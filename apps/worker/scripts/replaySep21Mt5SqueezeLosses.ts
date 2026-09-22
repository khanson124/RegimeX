#!/usr/bin/env tsx
/**
 * MT5-ONLY closed-candle replay for Sep 21 R_10 squeeze DEMO losses.
 *
 * Sources allowed: MT5_LIVE_TICKS, MT5_HISTORY (never HISTORY_API / LIVE_TICKS / SEED).
 * Read-only: does not modify positions, config, strategies, or place orders.
 *
 * Usage (on DEMO host with MT5 candles):
 *   pnpm --filter @regimex/worker exec tsx scripts/replaySep21Mt5SqueezeLosses.ts
 *   pnpm --filter @regimex/worker exec tsx scripts/replaySep21Mt5SqueezeLosses.ts --from-csv /path/to/mt5_r10_1m.csv
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractFeatures,
  DEFAULT_FEATURE_CONFIG,
  SqueezeBreakoutStrategy,
  SQUEEZE_BREAKOUT_DEFAULTS,
  proposeCfdStopTarget,
  RuleBasedRegimeClassifier,
  DEFAULT_REGIME_THRESHOLDS,
  assertMt5CandleContinuity,
  type Mt5ContinuityReport,
  type Candle
} from "@regimex/trading-engine";

const TRADES = [
  {
    ticket: "5781810683",
    entry: 5021.924,
    exit: 5015.25,
    pnlUsd: -3.34,
    openedAtIso: "2026-09-21T11:59:06.000Z",
    closedAtApproxIso: "2026-09-21T12:17:00.000Z",
    reportedMomentumPct: 0.09
  },
  {
    ticket: "5781935022",
    entry: 5021.766,
    exit: 5014.839,
    pnlUsd: -3.46,
    openedAtIso: "2026-09-21T13:49:09.000Z",
    closedAtApproxIso: "2026-09-21T14:06:00.000Z",
    reportedMomentumPct: 0.1
  }
] as const;

/** Warm-up: vol percentile window 100 + strategy minimumHistory 80 → export ≥120 bars before first entry. */
const WARMUP_BARS = 120;
const EXPORT_START_ISO = "2026-09-21T09:00:00.000Z";
const EXPORT_END_ISO = "2026-09-21T15:00:00.000Z";

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
  const header = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const idx = (name: string) => header.indexOf(name);
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const openTime = Date.parse(cols[idx("openTime")] ?? cols[idx("open_time")] ?? "");
    const closeTime = Date.parse(cols[idx("closeTime")] ?? cols[idx("close_time")] ?? "");
    const source = cols[idx("source")] ?? "MT5_LIVE_TICKS";
    out.push({
      symbol: "R_10",
      interval: "1m",
      openTime,
      closeTime: Number.isFinite(closeTime) ? closeTime : openTime + 60_000,
      open: Number(cols[idx("open")]),
      high: Number(cols[idx("high")]),
      low: Number(cols[idx("low")]),
      close: Number(cols[idx("close")]),
      tickCount: Number(cols[idx("tickCount")] ?? cols[idx("tick_count")] ?? 0),
      isComplete: String(cols[idx("isComplete")] ?? cols[idx("is_complete")] ?? "true") !== "false",
      source: source as Candle["source"]
    });
  }
  return out;
}

function decisionBarIndex(candles: Candle[], openedAtMs: number): number {
  // Engine decides on the just-closed 1m bar at/before open. Prefer bar whose closeTime <= open.
  let best = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.closeTime <= openedAtMs) best = i;
    else break;
  }
  if (best >= 0) return best;
  // Fallback: bar whose openTime equals floor minute of open
  const floor = openedAtMs - (openedAtMs % 60_000);
  return candles.findIndex((c) => c.openTime === floor - 60_000 || c.openTime === floor);
}

function reconstructTrade(
  candles: Candle[],
  features: ReturnType<typeof extractFeatures>,
  trade: (typeof TRADES)[number]
): Record<string, unknown> {
  const classifier = new RuleBasedRegimeClassifier();
  const strategy = new SqueezeBreakoutStrategy();
  const openedAtMs = Date.parse(trade.openedAtIso);
  const closedApproxMs = Date.parse(trade.closedAtApproxIso);
  const i = decisionBarIndex(candles, openedAtMs);

  const limitations: string[] = [];
  if (i < 0) {
    return {
      ticket: trade.ticket,
      reconstructable: false,
      limitations: ["No MT5 complete candle at/before open time"]
    };
  }
  if (i + 1 < WARMUP_BARS) {
    limitations.push(
      `Only ${i + 1} MT5 bars before decision index; want ≥${WARMUP_BARS} for full feature warm-up`
    );
  }

  const f = features[i]!;
  const regime = classifier.classify({ features: f, thresholds: DEFAULT_REGIME_THRESHOLDS });
  const decision = strategy.evaluate({
    candles: candles.slice(0, i + 1),
    features: features.slice(0, i + 1),
    regime,
    parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
    candlesSinceLastSignal: Number.POSITIVE_INFINITY
  });

  const proposalAtClose = proposeCfdStopTarget({
    strategyId: "squeeze-breakout-v1",
    direction: "BUY",
    entryPrice: candles[i]!.close,
    features: f,
    candles: candles.slice(0, i + 1),
    metadata: decision.metadata,
    tickSize: 0.001
  });
  const proposalAtFill = proposeCfdStopTarget({
    strategyId: "squeeze-breakout-v1",
    direction: "BUY",
    entryPrice: trade.entry,
    features: f,
    candles: candles.slice(0, i + 1),
    metadata: decision.metadata,
    tickSize: 0.001
  });

  // Path from decision bar through approx close
  const path: Array<Record<string, unknown>> = [];
  for (let j = i; j < candles.length && candles[j]!.openTime <= closedApproxMs + 60_000; j++) {
    const c = candles[j]!;
    path.push({
      openTime: new Date(c.openTime).toISOString(),
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      spansEntry: c.low <= trade.entry && c.high >= trade.entry,
      spansExit: c.low <= trade.exit && c.high >= trade.exit,
      barsAfterDecision: j - i
    });
  }

  const barsToSl = path.findIndex((p) => p.spansExit && (p.barsAfterDecision as number) > 0);

  limitations.push(
    "Entry fill is intra-bar MT5 execution — reconstructed decision uses completed 1m close, not bid/ask at 11:59:06 / 13:49:09"
  );
  limitations.push(
    "candlesSinceLastSignal set to Infinity for single-bar probe — production cooldown state requires DecisionLog/prior signals"
  );
  limitations.push(
    "Regime/confidence recomputed from MT5 OHLC — may differ from DecisionLog if live used different thresholds or partial features"
  );

  return {
    ticket: trade.ticket,
    reported: trade,
    reconstructableFromCompleted1m: {
      decisionBar: {
        openTime: new Date(candles[i]!.openTime).toISOString(),
        closeTime: new Date(candles[i]!.closeTime).toISOString(),
        ohlc: {
          o: candles[i]!.open,
          h: candles[i]!.high,
          l: candles[i]!.low,
          c: candles[i]!.close
        },
        source: candles[i]!.source,
        note: "Likely last complete bar at/before broker open"
      },
      recomputedDecision: {
        action: decision.action,
        confidence: decision.confidence,
        entryReason: decision.entryReason,
        invalidationReason: decision.invalidationReason,
        regime: regime.regime,
        regimeConfidence: regime.confidence,
        donchianHigh: f.donchianHigh,
        donchianLow: f.donchianLow,
        recentReturn: f.recentReturn,
        recentReturnPct: f.recentReturn != null ? Number((f.recentReturn * 100).toFixed(4)) : null,
        bollingerWidth: f.bollingerWidth,
        volatilityPercentile: f.volatilityPercentile,
        atr: f.atr
      },
      stopTargetFromBarClose: proposalAtClose,
      stopTargetFromReportedFill: proposalAtFill,
      pathBars: path.length,
      barsUntilExitLevelTouched: barsToSl >= 0 ? barsToSl : null,
      entryVsBarClose: trade.entry - candles[i]!.close,
      exitVsStructureStop:
        proposalAtFill != null ? trade.exit - proposalAtFill.stopLoss : null
    },
    notReconstructableFromCompleted1mAlone: [
      "Exact bid/ask and fill price at open/close timestamps",
      "Original DecisionLog featureSummary / regime at decision time (authoritative)",
      "Production candlesSinceLastSignal / lastSignalCandle state",
      "Quote-timeout / ENGINE_DEGRADED events (ops logs)",
      "Broker deal tickets, commission, swap breakdown"
    ],
    limitations
  };
}

async function loadFromDb(): Promise<Candle[]> {
  loadEnv();
  const { PrismaClient } = await import("@regimex/database");
  const prisma = new PrismaClient();
  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!sym) throw new Error("R_10 symbol not found");
    const rows = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "1m",
        isComplete: true,
        source: { in: ["MT5_LIVE_TICKS", "MT5_HISTORY"] },
        openTime: {
          gte: new Date(EXPORT_START_ISO),
          lt: new Date(EXPORT_END_ISO)
        }
      },
      orderBy: { openTime: "asc" }
    });
    return rows.map((r) => ({
      symbol: "R_10",
      interval: "1m",
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount ?? 0,
      isComplete: r.isComplete,
      source: r.source as Candle["source"]
    }));
  } finally {
    await prisma.$disconnect();
  }
}

function compareTrades(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const ar = a.reconstructableFromCompleted1m as
    | { recomputedDecision?: { donchianHigh?: number | null; recentReturn?: number | null }; decisionBar?: { openTime?: string } }
    | undefined;
  const br = b.reconstructableFromCompleted1m as
    | { recomputedDecision?: { donchianHigh?: number | null; recentReturn?: number | null }; decisionBar?: { openTime?: string } }
    | undefined;
  const d1 = ar?.recomputedDecision?.donchianHigh ?? null;
  const d2 = br?.recomputedDecision?.donchianHigh ?? null;
  const entryDelta = TRADES[1]!.entry - TRADES[0]!.entry;
  const minutesBetween =
    (Date.parse(TRADES[1]!.openedAtIso) - Date.parse(TRADES[0]!.openedAtIso)) / 60_000;
  const sameLevel =
    Math.abs(entryDelta / TRADES[0]!.entry) <= 0.0015 || Math.abs(entryDelta) <= 1.0;
  const sameDonchian =
    d1 != null && d2 != null ? Math.abs(d1 - d2) <= 0.05 : null;

  let verdict: string;
  if (sameLevel && sameDonchian === true) {
    verdict =
      "LIKELY_SAME_LEVEL_REENTRY — entries near identical and Donchian highs essentially unchanged";
  } else if (sameLevel && sameDonchian === false) {
    verdict =
      "AMBIGUOUS — same price band but Donchian reference changed (possible new consolidation at similar price)";
  } else if (sameLevel && sameDonchian == null) {
    verdict =
      "SAME_PRICE_BAND — Donchian comparison unavailable; need successful MT5 feature warm-up";
  } else {
    verdict = "LIKELY_INDEPENDENT — entry prices materially different";
  }

  return {
    entryPriceDelta: entryDelta,
    entryPriceDeltaPct: (entryDelta / TRADES[0]!.entry) * 100,
    minutesBetweenOpens: minutesBetween,
    donchianHighFirst: d1,
    donchianHighSecond: d2,
    sameDonchianHigh: sameDonchian,
    decisionBars: {
      first: ar?.decisionBar?.openTime ?? null,
      second: br?.decisionBar?.openTime ?? null
    },
    verdict,
    note: "Cooldown (8m) elapsed long before second open (~110m later); cooldown alone does not prevent re-entry"
  };
}

async function main(): Promise<void> {
  const csvPath = arg("from-csv");
  const raw = csvPath ? parseCsv(resolve(csvPath)) : await loadFromDb();
  const { candles, report: continuity } = assertMt5CandleContinuity(raw);

  const outDir = resolve(
    process.cwd(),
    "../../research-datasets/sep21-squeeze-loss-investigation"
  );
  mkdirSync(outDir, { recursive: true });

  if (candles.length === 0) {
    const stub = {
      generatedAt: new Date().toISOString(),
      status: "NO_MT5_CANDLES_IN_REACHABLE_DB",
      continuity,
      exportRequired: minimumExportSpec(),
      procedure: replayProcedure(),
      reconstructionBoundaries: reconstructionBoundaries()
    };
    writeFileSync(resolve(outDir, "mt5_replay_report.json"), JSON.stringify(stub, null, 2));
    writeFileSync(resolve(outDir, "mt5_replay_report.md"), formatPlanMarkdown(stub));
    console.log(JSON.stringify(stub, null, 2));
    return;
  }

  const features = extractFeatures(candles, DEFAULT_FEATURE_CONFIG);
  const setups = TRADES.map((t) => reconstructTrade(candles, features, t));
  const relationship = compareTrades(setups[0]!, setups[1]!);

  const full = {
    generatedAt: new Date().toISOString(),
    status: continuity.continuous1m ? "MT5_REPLAY_OK" : "MT5_REPLAY_WITH_GAPS",
    sourcesAllowed: ["MT5_LIVE_TICKS", "MT5_HISTORY"],
    sourcesUsed: continuity.sources,
    continuity,
    exportRequired: minimumExportSpec(),
    procedure: replayProcedure(),
    reconstructionBoundaries: reconstructionBoundaries(),
    setups,
    relationshipFirstVsSecond: relationship,
    candidateImprovementsForReview: [
      {
        id: "failed_breakout_memory",
        hypothesis:
          "Suppress BUY for N bars within X% of a recent SL entry at similar breakout level",
        falsePositives: "Blocks valid second-leg continuation after shallow stop-out",
        missedWinners: "Skips profitable re-break after failed first attempt"
      },
      {
        id: "post_entry_invalidation",
        hypothesis:
          "Exit if close reclaims below breakout Donchian high within M bars after entry",
        falsePositives: "Cuts winners that dip through level then continue",
        missedWinners: "May free cooldown early and change subsequent trade set"
      }
    ],
    largerSamplePlan: {
      inventory: "All R_10 1m MT5_LIVE_TICKS/MT5_HISTORY continuous segments on DEMO",
      inSample: "Longest continuous MT5 segment including 2026-09-21",
      outOfSample: "Later contiguous holdout never used for N/X/M selection",
      promoteOnlyIf: "OOS expectancy/DD and blocked-winner counts acceptable"
    }
  };

  writeFileSync(resolve(outDir, "mt5_replay_report.json"), JSON.stringify(full, null, 2));
  writeFileSync(resolve(outDir, "mt5_replay_report.md"), formatResultMarkdown(full));
  console.log(
    JSON.stringify(
      {
        wrote: {
          json: resolve(outDir, "mt5_replay_report.json"),
          md: resolve(outDir, "mt5_replay_report.md")
        },
        continuity: {
          bars: continuity.barCount,
          continuous1m: continuity.continuous1m,
          gaps: continuity.gapCount,
          duplicates: continuity.duplicateOpenTimes.length,
          sources: continuity.sources
        },
        relationship,
        setupActions: setups.map((s) => ({
          ticket: s.ticket,
          action: (s.reconstructableFromCompleted1m as { recomputedDecision?: { action?: string } })
            ?.recomputedDecision?.action
        }))
      },
      null,
      2
    )
  );
}

function minimumExportSpec(): Record<string, unknown> {
  return {
    symbol: "R_10",
    interval: "1m",
    sources: ["MT5_LIVE_TICKS", "MT5_HISTORY"],
    isComplete: true,
    openTimeInclusive: EXPORT_START_ISO,
    openTimeExclusive: EXPORT_END_ISO,
    rationale: [
      `First open ${TRADES[0].openedAtIso} needs ≥${WARMUP_BARS} prior complete MT5 bars (vol percentile 100 + strategy min 80)`,
      "09:00–15:00 UTC covers warm-up, both entries (11:59, 13:49), and both ~17m holds",
      "Do NOT include HISTORY_API / LIVE_TICKS / SEED in this export"
    ],
    alsoExport: [
      "Position rows for both brokerPositionIds",
      "Linked Signal + DecisionLog by correlationId",
      "Optional: DecisionLog ENGINE_DEGRADED/timeout 11:55–12:25 UTC only"
    ],
    sqlFile: "research-datasets/sep21-squeeze-loss-investigation/export_mt5_replay.sql"
  };
}

function replayProcedure(): string[] {
  return [
    "1. On DEMO host: run export_mt5_replay.sql (read-only) → mt5_r10_1m_sep21.csv + positions JSON",
    "2. Verify continuity: duplicate openTimes=0, gaps=0 for 09:00–14:59 (360 expected hours×60 if full)",
    "3. pnpm --filter @regimex/worker exec tsx scripts/replaySep21Mt5SqueezeLosses.ts --from-csv mt5_r10_1m_sep21.csv",
    "4. Or run without --from-csv when DATABASE_URL points at DEMO with MT5 candles",
    "5. Compare recomputedDecision.action/reasons to DecisionLog SIGNAL_PRODUCED (authoritative)",
    "6. Apply relationship verdict using Donchian highs + entry proximity — not HISTORY_API"
  ];
}

function reconstructionBoundaries(): Record<string, string[]> {
  return {
    fromCompleted1mMt5Candles: [
      "OHLC path, Donchian/BB/ATR/recentReturn recomputed without look-ahead",
      "Whether strategy.evaluate would BUY/HOLD/SELL on that closed bar",
      "Structure stop/target from proposeCfdStopTarget at bar close or reported fill",
      "Whether exit price level was touched on subsequent complete bars",
      "Whether second entry shares Donchian high / price band with first"
    ],
    requiresDecisionTimeOrBrokerRecords: [
      "Exact fill vs bar close (slippage)",
      "Bid/ask at open/close",
      "Logged regime/features/reasons at decision time",
      "Production cooldown / prior signal state",
      "Commission, swap, deal tickets",
      "Quote timeout causality"
    ]
  };
}

function formatPlanMarkdown(stub: Record<string, unknown>): string {
  return `# MT5-only Sep 21 replay\n\nStatus: ${stub.status}\n\nNo MT5 candles in the reachable DATABASE_URL. Run export SQL on DEMO, then rerun with --from-csv.\n`;
}

function formatResultMarkdown(full: {
  status: string;
  continuity: Mt5ContinuityReport;
  relationshipFirstVsSecond: Record<string, unknown>;
  setups: Array<Record<string, unknown>>;
}): string {
  const lines = [
    `# MT5-only Sep 21 squeeze loss replay`,
    ``,
    `Status: **${full.status}**`,
    ``,
    `## Continuity`,
    `- Bars: ${full.continuity.barCount}`,
    `- Continuous 1m: ${full.continuity.continuous1m}`,
    `- Gaps: ${full.continuity.gapCount}`,
    `- Duplicate openTimes: ${full.continuity.duplicateOpenTimes.length}`,
    `- Sources: ${full.continuity.sources.join(", ")}`,
    `- Span: ${full.continuity.firstIso} → ${full.continuity.lastIso}`,
    ``,
    `## First vs second`,
    "```json",
    JSON.stringify(full.relationshipFirstVsSecond, null, 2),
    "```",
    ``,
    `## Setups`,
    "```json",
    JSON.stringify(full.setups, null, 2),
    "```",
    ``
  ];
  return `${lines.join("\n")}\n`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
