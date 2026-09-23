#!/usr/bin/env tsx
/**
 * Research-only: reconstruct blocked R_10 squeeze SELL signals (esp. 2026-09-21 04:10/04:11 UTC).
 *
 * MT5 candles only (MT5_LIVE_TICKS | MT5_HISTORY). Never HISTORY_API.
 * Does not place orders, enable SELL, mutate config, or restart services.
 *
 * Run on Ubuntu DEMO host (DATABASE_URL → DEMO Postgres):
 *   docker compose exec -T worker pnpm --filter @regimex/worker exec tsx \
 *     scripts/auditBlockedR10SellsSep21.ts
 *
 * Optional CSV (MT5-only export):
 *   ... tsx scripts/auditBlockedR10SellsSep21.ts --from-csv /path/to/mt5_r10_1m.csv
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_FEATURE_CONFIG,
  DEFAULT_REGIME_THRESHOLDS,
  RuleBasedRegimeClassifier,
  SqueezeBreakoutStrategy,
  SQUEEZE_BREAKOUT_DEFAULTS,
  assertMt5CandleContinuity,
  extractFeatures,
  proposeCfdStopTarget,
  type Candle
} from "@regimex/trading-engine";

const OUT_DIR = resolve(
  process.cwd(),
  "../../research-datasets/r10-missed-opportunity-sep18-23"
);
const FOCUS_ISO = "2026-09-21T04:10:00.000Z";
const WINDOW_START = "2026-09-18T00:00:00.000Z";
const WINDOW_END = "2026-09-24T00:00:00.000Z";
const WARMUP_BARS = 120;
const PATH_BARS = 120; // ~2h after entry for SL/TP race
const FT_REASON = "R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY";

function loadEnv(): void {
  for (const p of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}

function parseCsv(path: string): Candle[] {
  const text = readFileSync(path, "utf8").trim();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iOt = idx("openTime");
  const iO = idx("open");
  const iH = idx("high");
  const iL = idx("low");
  const iC = idx("close");
  const iSrc = idx("source");
  const iComp = idx("isComplete");
  const iTc = idx("tickCount");
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const openTime = Date.parse(cols[iOt]!);
    if (!Number.isFinite(openTime)) continue;
    const source = (iSrc >= 0 ? cols[iSrc] : "MT5_LIVE_TICKS") as Candle["source"];
    const isComplete = iComp < 0 ? true : cols[iComp] === "t" || cols[iComp] === "true" || cols[iComp] === "1";
    out.push({
      symbol: "R_10",
      interval: "1m",
      openTime,
      closeTime: openTime + 60_000,
      open: Number(cols[iO]),
      high: Number(cols[iH]),
      low: Number(cols[iL]),
      close: Number(cols[iC]),
      tickCount: iTc >= 0 ? Number(cols[iTc] || 0) : 0,
      isComplete,
      source
    });
  }
  return out;
}

async function loadMt5FromDb(): Promise<Candle[]> {
  loadEnv();
  const { PrismaClient } = await import("@regimex/database");
  const prisma = new PrismaClient();
  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!sym) return [];
    // Need warm-up before focus + path after window start
    const from = new Date("2026-09-21T01:00:00.000Z");
    const to = new Date(WINDOW_END);
    const rows = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "1m",
        isComplete: true,
        source: { in: ["MT5_LIVE_TICKS", "MT5_HISTORY"] },
        openTime: { gte: from, lt: to }
      },
      orderBy: { openTime: "asc" }
    });
    return rows.map((r) => ({
      symbol: "R_10",
      interval: "1m" as const,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: r.isComplete,
      source: r.source as Candle["source"]
    }));
  } finally {
    await prisma.$disconnect();
  }
}

type AuthSignal = {
  kind: "production_blocked_sell" | "shadow_sell";
  createdAt: string;
  correlationId: string;
  strategyId: string | null;
  action: string | null;
  eventType: string;
  reasons: unknown;
  featureSummary: unknown;
  signalId?: string;
  signalTime?: string;
  signalStatus?: string;
  proposedEntryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

async function loadAuthoritativeLogs(): Promise<{
  blockedSells: AuthSignal[];
  shadowEvals: AuthSignal[];
  dbHostHint: string;
}> {
  loadEnv();
  const url = process.env.DATABASE_URL ?? "";
  const dbHostHint = url.includes("@") ? url.replace(/:[^:@/]+@/, ":***@").slice(0, 80) : "unset";
  const { PrismaClient } = await import("@regimex/database");
  const prisma = new PrismaClient();
  try {
    const from = new Date(WINDOW_START);
    const to = new Date(WINDOW_END);
    const windowLogs = await prisma.decisionLog.findMany({
      where: {
        symbol: "R_10",
        createdAt: { gte: from, lt: to }
      },
      orderBy: { createdAt: "asc" }
    });

    const blockedSells: AuthSignal[] = [];
    for (const d of windowLogs) {
      if (d.action !== "SELL") continue;
      const blob = `${JSON.stringify(d.reasons)}\n${JSON.stringify(d.featureSummary)}`;
      if (!blob.includes(FT_REASON) && !blob.includes("forwardTrialDirectionalGuard")) continue;
      blockedSells.push({
        kind: "production_blocked_sell",
        createdAt: d.createdAt.toISOString(),
        correlationId: d.correlationId,
        strategyId: d.strategyId,
        action: d.action,
        eventType: d.eventType,
        reasons: d.reasons,
        featureSummary: d.featureSummary
      });
    }

    // Enrich from Signal rows (SL/TP usually null when FT-blocked before executeCfdSignal)
    const signals = await prisma.signal.findMany({
      where: {
        symbol: "R_10",
        action: "SELL",
        strategyId: "squeeze-breakout-v1",
        signalTime: { gte: from, lt: to }
      },
      orderBy: { signalTime: "asc" }
    });
    const byCorr = new Map(signals.map((s) => [s.correlationId, s]));
    for (const b of blockedSells) {
      const s = byCorr.get(b.correlationId);
      if (!s) continue;
      b.signalId = s.id;
      b.signalTime = s.signalTime.toISOString();
      b.signalStatus = s.status;
      b.proposedEntryPrice = s.proposedEntryPrice != null ? Number(s.proposedEntryPrice) : null;
      b.stopLoss = s.stopLoss != null ? Number(s.stopLoss) : null;
      b.takeProfit = s.takeProfit != null ? Number(s.takeProfit) : null;
    }

    const shadowRows = await prisma.decisionLog.findMany({
      where: {
        symbol: "R_10",
        eventType: "AUTO_SHADOW_EVAL",
        createdAt: { gte: from, lt: to }
      },
      orderBy: { createdAt: "asc" }
    });
    const shadowEvals: AuthSignal[] = shadowRows
      .filter((d) => {
        const text = `${JSON.stringify(d.reasons)} ${JSON.stringify(d.featureSummary)}`;
        return /\bSELL\b/.test(text);
      })
      .map((d) => ({
        kind: "shadow_sell" as const,
        createdAt: d.createdAt.toISOString(),
        correlationId: d.correlationId,
        strategyId: d.strategyId,
        action: d.action,
        eventType: d.eventType,
        reasons: d.reasons,
        featureSummary: d.featureSummary
      }));

    return { blockedSells, shadowEvals, dbHostHint };
  } finally {
    await prisma.$disconnect();
  }
}

function decisionBarIndex(candles: Candle[], aroundMs: number): number {
  // Prefer bar whose closeTime is nearest at-or-before aroundMs (onCandleClosed timing)
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const delta = aroundMs - c.closeTime;
    if (delta < -5_000) continue; // bar closed too far after log
    if (Math.abs(delta) < bestDelta) {
      bestDelta = Math.abs(delta);
      best = i;
    }
  }
  return best;
}

type PathOutcome = {
  firstTouch: "STOP" | "TARGET" | "NEITHER" | "SAME_BAR_AMBIGUOUS";
  stopBarIso: string | null;
  targetBarIso: string | null;
  barsToStop: number | null;
  barsToTarget: number | null;
  pathEndIso: string | null;
};

function simulateSellPath(
  candles: Candle[],
  decisionIdx: number,
  entry: number,
  stopLoss: number,
  takeProfit: number
): PathOutcome {
  let stopBar: number | null = null;
  let targetBar: number | null = null;
  const end = Math.min(candles.length - 1, decisionIdx + PATH_BARS);
  // Execution assumed at/after decision bar close — evaluate subsequent bars for touches
  for (let j = decisionIdx + 1; j <= end; j++) {
    const c = candles[j]!;
    const hitStop = c.high >= stopLoss;
    const hitTp = c.low <= takeProfit;
    if (hitStop && hitTp) {
      return {
        firstTouch: "SAME_BAR_AMBIGUOUS",
        stopBarIso: new Date(c.openTime).toISOString(),
        targetBarIso: new Date(c.openTime).toISOString(),
        barsToStop: j - decisionIdx,
        barsToTarget: j - decisionIdx,
        pathEndIso: new Date(candles[end]!.openTime).toISOString()
      };
    }
    if (hitStop && stopBar == null) stopBar = j;
    if (hitTp && targetBar == null) targetBar = j;
    if (stopBar != null || targetBar != null) {
      if (stopBar != null && (targetBar == null || stopBar < targetBar)) {
        return {
          firstTouch: "STOP",
          stopBarIso: new Date(candles[stopBar]!.openTime).toISOString(),
          targetBarIso: targetBar != null ? new Date(candles[targetBar]!.openTime).toISOString() : null,
          barsToStop: stopBar - decisionIdx,
          barsToTarget: targetBar != null ? targetBar - decisionIdx : null,
          pathEndIso: new Date(candles[end]!.openTime).toISOString()
        };
      }
      if (targetBar != null && (stopBar == null || targetBar < stopBar)) {
        return {
          firstTouch: "TARGET",
          stopBarIso: stopBar != null ? new Date(candles[stopBar]!.openTime).toISOString() : null,
          targetBarIso: new Date(candles[targetBar]!.openTime).toISOString(),
          barsToStop: stopBar != null ? stopBar - decisionIdx : null,
          barsToTarget: targetBar - decisionIdx,
          pathEndIso: new Date(candles[end]!.openTime).toISOString()
        };
      }
    }
  }
  return {
    firstTouch: "NEITHER",
    stopBarIso: null,
    targetBarIso: null,
    barsToStop: null,
    barsToTarget: null,
    pathEndIso: end >= 0 ? new Date(candles[end]!.openTime).toISOString() : null
  };
}

function reconstructAt(
  candles: Candle[],
  features: ReturnType<typeof extractFeatures>,
  classifier: RuleBasedRegimeClassifier,
  strategy: SqueezeBreakoutStrategy,
  aroundIso: string,
  label: string,
  candlesSinceLastSignal: number
) {
  const aroundMs = Date.parse(aroundIso);
  const i = decisionBarIndex(candles, aroundMs);
  const limitations: string[] = [];
  if (i < 0) {
    return { label, aroundIso, reconstructable: false as const, limitations: ["No MT5 decision bar matched"] };
  }
  if (i + 1 < WARMUP_BARS) {
    limitations.push(`Only ${i + 1} bars before decision; want ≥${WARMUP_BARS}`);
  }
  const f = features[i]!;
  const bar = candles[i]!;
  const regime = classifier.classify({ features: f, thresholds: DEFAULT_REGIME_THRESHOLDS });
  const decision = strategy.evaluate({
    candles: candles.slice(0, i + 1),
    features: features.slice(0, i + 1),
    regime,
    parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
    candlesSinceLastSignal
  });

  const entryAtClose = bar.close;
  const proposal =
    decision.action === "SELL" || decision.action === "BUY"
      ? proposeCfdStopTarget({
          strategyId: "squeeze-breakout-v1",
          direction: decision.action,
          entryPrice: entryAtClose,
          features: f,
          candles: candles.slice(0, i + 1),
          metadata: decision.metadata,
          tickSize: 0.001
        })
      : null;

  limitations.push(
    "Proposed entry = completed 1m close (not bid/ask fill). FT-blocked signals never reached executeCfdSignal."
  );
  limitations.push(
    "Broker stop adaptation / freeze level / spread not applied — research reconstruction only."
  );
  limitations.push(
    "Empirical MT5 cost profile unlockGates.profilesUnlocked=false (0 reliable spread/fill samples) — no $ P&L."
  );

  let path: PathOutcome | null = null;
  if (proposal && decision.action === "SELL") {
    path = simulateSellPath(candles, i, entryAtClose, proposal.stopLoss, proposal.takeProfit!);
  }

  return {
    label,
    aroundIso,
    reconstructable: true as const,
    decisionBar: {
      openTimeIso: new Date(bar.openTime).toISOString(),
      closeTimeIso: new Date(bar.closeTime).toISOString(),
      ohlc: { o: bar.open, h: bar.high, l: bar.low, c: bar.close },
      source: bar.source
    },
    regime: { regime: regime.regime, confidence: regime.confidence },
    recomputedDecision: {
      action: decision.action,
      confidence: decision.confidence,
      entryReason: decision.entryReason,
      invalidationReason: decision.invalidationReason,
      metadata: decision.metadata
    },
    candlesSinceLastSignalUsed: candlesSinceLastSignal,
    proposed: proposal
      ? {
          entryPrice: entryAtClose,
          stopLoss: proposal.stopLoss,
          takeProfit: proposal.takeProfit,
          stopDistance: proposal.stopDistance,
          targetDistance: proposal.targetDistance,
          riskRewardRatio: proposal.riskRewardRatio,
          stopMethod: proposal.stopMethod,
          reasons: proposal.reasons
        }
      : null,
    pathOutcome: path,
    limitations
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  let authoritative: Awaited<ReturnType<typeof loadAuthoritativeLogs>> | null = null;
  let authError: string | null = null;
  try {
    authoritative = await loadAuthoritativeLogs();
  } catch (e) {
    authError = e instanceof Error ? e.message : String(e);
  }

  const csvPath = arg("from-csv");
  const raw = csvPath ? parseCsv(resolve(csvPath)) : await loadMt5FromDb();
  const { candles, report: continuity } = assertMt5CandleContinuity(raw);

  const features = extractFeatures(candles, DEFAULT_FEATURE_CONFIG);
  const classifier = new RuleBasedRegimeClassifier();
  const strategy = new SqueezeBreakoutStrategy();

  // 04:10: first of the pair — treat as independent (no prior FT SELL cooldown advance)
  const focus0410 = reconstructAt(
    candles,
    features,
    classifier,
    strategy,
    FOCUS_ISO,
    "production_focus_0410_utc",
    Number.POSITIVE_INFINITY
  );

  // 04:11: one minute later — production does NOT advance cooldown on FT block, so
  // candlesSinceLastSignal stays large; still the same structural breakout → repeated opportunity
  const focus0411 = reconstructAt(
    candles,
    features,
    classifier,
    strategy,
    "2026-09-21T04:11:00.000Z",
    "production_focus_0411_utc",
    Number.POSITIVE_INFINITY
  );

  const sameStructure =
    focus0410.reconstructable &&
    focus0411.reconstructable &&
    focus0410.recomputedDecision.action === "SELL" &&
    focus0411.recomputedDecision.action === "SELL" &&
    focus0410.recomputedDecision.metadata?.donchianLow ===
      focus0411.recomputedDecision.metadata?.donchianLow &&
    focus0410.recomputedDecision.metadata?.donchianHigh ===
      focus0411.recomputedDecision.metadata?.donchianHigh;

  const report = {
    generatedAt: new Date().toISOString(),
    status:
      candles.length === 0
        ? "NO_MT5_CANDLES"
        : authoritative && authoritative.blockedSells.length === 0 && authError == null
          ? "MT5_OK_BUT_NO_BLOCKED_SELL_LOGS"
          : candles.length > 0
            ? "RECONSTRUCTION_COMPLETE"
            : "INCOMPLETE",
    dataIntegrity: {
      sourcesAllowed: ["MT5_LIVE_TICKS", "MT5_HISTORY"],
      continuity,
      authoritativeLogsLoaded: authoritative != null,
      authoritativeError: authError,
      dbHostHint: authoritative?.dbHostHint ?? null,
      note:
        "Reject local Mac DB if DecisionLog max(createdAt) < 2026-09-18 or MT5 bar count is 0 for Sep 21"
    },
    codeFacts: {
      forwardTrialBlocksBeforeExecuteCfdSignal: true,
      signalStopLossPersistedOnFtBlock: false,
      cooldownAdvancesOnFtBlock: false,
      implication0411:
        "04:11 can fire as a repeated opportunity on consecutive bars because FT block returns before lastSignalCandle update"
    },
    focus0410,
    focus0411,
    relationship0410_0411: {
      sameDonchianStructure: sameStructure,
      classification: sameStructure
        ? "REPEATED_OPPORTUNITY_SAME_BREAKOUT"
        : "NEEDS_MANUAL_COMPARE_OR_INSUFFICIENT_MT5",
      note: "Not an independent second trade under an 8-bar cooldown if production had opened; FT block skips cooldown"
    },
    productionBlockedSellsInWindow: authoritative?.blockedSells ?? [],
    shadowSellObservationsInWindow: authoritative?.shadowEvals ?? [],
    pnlReliability: {
      dollarPnlEstablished: false,
      reasons: [
        "No broker fill — signal SKIPPED before submit",
        "R_10_mt5_empirical_cost_calibration unlockGates.profilesUnlocked=false",
        "Intra-bar SL/TP race can be SAME_BAR_AMBIGUOUS on 1m OHLC",
        "Entry at bar close ≠ ask/bid at submit"
      ]
    },
    artifacts: {
      outDir: OUT_DIR
    }
  };

  const jsonPath = resolve(OUT_DIR, "blocked_sell_0410_reconstruction.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    `# Blocked SELL reconstruction — 2026-09-21 04:10 UTC`,
    ``,
    `Generated: ${report.generatedAt}`,
    `Status: **${report.status}**`,
    ``,
    `## 04:10 focus`,
    focus0410.reconstructable
      ? [
          `- Decision bar: ${focus0410.decisionBar.openTimeIso} → ${focus0410.decisionBar.closeTimeIso} close=${focus0410.decisionBar.ohlc.c}`,
          `- Recomputed action: ${focus0410.recomputedDecision.action} (conf ${focus0410.recomputedDecision.confidence})`,
          focus0410.proposed
            ? `- Proposed entry/SL/TP: ${focus0410.proposed.entryPrice} / ${focus0410.proposed.stopLoss} / ${focus0410.proposed.takeProfit} (${focus0410.proposed.stopMethod})`
            : `- Proposed SL/TP: unavailable`,
          focus0410.pathOutcome
            ? `- First touch (subsequent 1m OHLC): **${focus0410.pathOutcome.firstTouch}** (stopBars=${focus0410.pathOutcome.barsToStop}, targetBars=${focus0410.pathOutcome.barsToTarget})`
            : `- Path: n/a`
        ].join("\n")
      : `- Not reconstructable: ${(focus0410.limitations ?? []).join("; ")}`,
    ``,
    `## 04:11 relationship`,
    `- Classification: **${report.relationship0410_0411.classification}**`,
    `- ${report.relationship0410_0411.note}`,
    ``,
    `## P&L`,
    `- Dollar P&L established: **false**`,
    ...report.pnlReliability.reasons.map((r) => `- ${r}`),
    ``,
    `## Authoritative counts`,
    `- Production FT-blocked SELLs in window: ${report.productionBlockedSellsInWindow.length}`,
    `- Shadow SELL-containing AUTO_SHADOW_EVAL rows: ${report.shadowSellObservationsInWindow.length}`,
    authError ? `- Auth log error: ${authError}` : "",
    ``,
    `See \`blocked_sell_0410_reconstruction.json\` for full detail.`
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(resolve(OUT_DIR, "blocked_sell_0410_reconstruction.md"), md);
  console.log(JSON.stringify({ status: report.status, jsonPath, focus0410: report.focus0410, relationship: report.relationship0410_0411 }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
