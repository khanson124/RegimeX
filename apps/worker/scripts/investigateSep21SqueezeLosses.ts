#!/usr/bin/env tsx
/**
 * Read-only Sep 21 R_10 squeeze-breakout loss reconstruction + candidate offline backtests.
 * Does NOT modify production strategies, configs, positions, or orders.
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
  type Candle
} from "@regimex/trading-engine";

function loadEnv(): void {
  for (const p of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

const TRADES = [
  {
    ticket: "5781810683",
    entry: 5021.924,
    exit: 5015.25,
    pnl: -3.34,
    direction: "BUY" as const
  },
  {
    ticket: "5781935022",
    entry: 5021.766,
    exit: 5014.839,
    pnl: -3.46,
    direction: "BUY" as const
  }
];

type VariantId =
  | "baseline"
  | "stronger_confirmation"
  | "failed_breakout_memory"
  | "post_entry_invalidation";

interface VariantConfig {
  id: VariantId;
  label: string;
  minBreakoutReturn: number;
  cooldownCandles: number;
  /** Bars after a SL/false breakout within priceTol of entry where new BUYs are suppressed. */
  failedBreakoutLookbackBars: number;
  failedBreakoutPriceTolPct: number;
  /** If true, exit early when close falls back below prior Donchian high after entry. */
  postEntryInvalidation: boolean;
}

const VARIANTS: VariantConfig[] = [
  {
    id: "baseline",
    label: "Unchanged squeeze-breakout-v1 defaults",
    minBreakoutReturn: SQUEEZE_BREAKOUT_DEFAULTS.minBreakoutReturn as number,
    cooldownCandles: SQUEEZE_BREAKOUT_DEFAULTS.cooldownCandles as number,
    failedBreakoutLookbackBars: 0,
    failedBreakoutPriceTolPct: 0,
    postEntryInvalidation: false
  },
  {
    id: "stronger_confirmation",
    label: "Stronger momentum: minBreakoutReturn 0.0015 (≈0.15%)",
    minBreakoutReturn: 0.0015,
    cooldownCandles: SQUEEZE_BREAKOUT_DEFAULTS.cooldownCandles as number,
    failedBreakoutLookbackBars: 0,
    failedBreakoutPriceTolPct: 0,
    postEntryInvalidation: false
  },
  {
    id: "failed_breakout_memory",
    label: "Suppress re-entry within 30 bars & 0.15% of a recent SL false breakout",
    minBreakoutReturn: SQUEEZE_BREAKOUT_DEFAULTS.minBreakoutReturn as number,
    cooldownCandles: SQUEEZE_BREAKOUT_DEFAULTS.cooldownCandles as number,
    failedBreakoutLookbackBars: 30,
    failedBreakoutPriceTolPct: 0.0015,
    postEntryInvalidation: false
  },
  {
    id: "post_entry_invalidation",
    label: "Exit if close reclaims below breakout Donchian high within 5 bars",
    minBreakoutReturn: SQUEEZE_BREAKOUT_DEFAULTS.minBreakoutReturn as number,
    cooldownCandles: SQUEEZE_BREAKOUT_DEFAULTS.cooldownCandles as number,
    failedBreakoutLookbackBars: 0,
    failedBreakoutPriceTolPct: 0,
    postEntryInvalidation: true
  }
];

function toCandle(r: {
  openTime: Date;
  closeTime: Date;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  tickCount: number | null;
  isComplete: boolean;
  source: string;
}): Candle {
  return {
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
  };
}

interface SimTrade {
  entryIndex: number;
  entryTimeIso: string;
  entryPrice: number;
  exitIndex: number;
  exitTimeIso: string;
  exitPrice: number;
  pnlPoints: number;
  exitReason: string;
  stop: number;
  target: number;
  donchianHighAtEntry: number | null;
  recentReturn: number | null;
  regime: string;
}

function simulateVariant(
  candles: Candle[],
  features: ReturnType<typeof extractFeatures>,
  classifier: RuleBasedRegimeClassifier,
  variant: VariantConfig
): { trades: SimTrade[]; signals: number } {
  const strategy = new SqueezeBreakoutStrategy();
  const params = {
    ...SQUEEZE_BREAKOUT_DEFAULTS,
    minBreakoutReturn: variant.minBreakoutReturn,
    cooldownCandles: variant.cooldownCandles
  };
  const trades: SimTrade[] = [];
  let lastSignalIndex = Number.NEGATIVE_INFINITY;
  const failedBreakouts: Array<{ index: number; price: number }> = [];
  let open: {
    entryIndex: number;
    entryPrice: number;
    stop: number;
    target: number;
    donchianHigh: number | null;
    recentReturn: number | null;
    regime: string;
  } | null = null;

  const warmup = 80;
  for (let i = warmup; i < candles.length; i++) {
    const f = features[i]!;
    const regime = classifier.classify({ features: f, thresholds: DEFAULT_REGIME_THRESHOLDS });

    if (open) {
      const c = candles[i]!;
      let exitPrice: number | null = null;
      let exitReason: string | null = null;
      if (c.low <= open.stop) {
        exitPrice = open.stop;
        exitReason = "STOP_LOSS";
      } else if (c.high >= open.target) {
        exitPrice = open.target;
        exitReason = "TAKE_PROFIT";
      } else if (
        variant.postEntryInvalidation &&
        open.donchianHigh != null &&
        i - open.entryIndex <= 5 &&
        c.close < open.donchianHigh
      ) {
        exitPrice = c.close;
        exitReason = "BREAKOUT_INVALIDATION";
      }
      if (exitPrice != null && exitReason) {
        const pnlPoints = exitPrice - open.entryPrice;
        trades.push({
          entryIndex: open.entryIndex,
          entryTimeIso: new Date(candles[open.entryIndex]!.openTime).toISOString(),
          entryPrice: open.entryPrice,
          exitIndex: i,
          exitTimeIso: new Date(c.openTime).toISOString(),
          exitPrice,
          pnlPoints,
          exitReason,
          stop: open.stop,
          target: open.target,
          donchianHighAtEntry: open.donchianHigh,
          recentReturn: open.recentReturn,
          regime: open.regime
        });
        if (exitReason === "STOP_LOSS" || exitReason === "BREAKOUT_INVALIDATION") {
          failedBreakouts.push({ index: open.entryIndex, price: open.entryPrice });
        }
        lastSignalIndex = open.entryIndex;
        open = null;
      }
      continue;
    }

    if (!["BREAKOUT_EXPANSION", "VOLATILITY_COMPRESSION"].includes(regime.regime)) continue;
    if (regime.confidence < 0.5) continue;

    const since = lastSignalIndex < 0 ? Number.POSITIVE_INFINITY : i - lastSignalIndex;
    const decision = strategy.evaluate({
      candles: candles.slice(0, i + 1),
      features: features.slice(0, i + 1),
      regime,
      parameters: params,
      candlesSinceLastSignal: since
    });
    if (decision.action !== "BUY") continue;

    // Failed-breakout memory (research-only candidate).
    if (variant.failedBreakoutLookbackBars > 0) {
      const blocked = failedBreakouts.some((fb) => {
        if (i - fb.index > variant.failedBreakoutLookbackBars) return false;
        const tol = fb.price * variant.failedBreakoutPriceTolPct;
        return Math.abs(candles[i]!.close - fb.price) <= tol;
      });
      if (blocked) continue;
    }

    const proposal = proposeCfdStopTarget({
      strategyId: "squeeze-breakout-v1",
      direction: "BUY",
      entryPrice: candles[i]!.close,
      features: f,
      candles: candles.slice(0, i + 1),
      metadata: decision.metadata,
      tickSize: 0.001
    });
    if (!proposal) continue;

    open = {
      entryIndex: i,
      entryPrice: candles[i]!.close,
      stop: proposal.stopLoss,
      target: proposal.takeProfit,
      donchianHigh: f.donchianHigh,
      recentReturn: f.recentReturn,
      regime: regime.regime
    };
  }

  return { trades, signals: trades.length };
}

function summarize(trades: SimTrade[]): Record<string, number | null> {
  if (trades.length === 0) {
    return {
      trades: 0,
      netPnlPoints: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      expectancyPoints: null,
      maxDrawdownPoints: 0,
      avgWin: null,
      avgLoss: null
    };
  }
  const pnls = trades.map((t) => t.pnlPoints);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    trades: trades.length,
    netPnlPoints: Number(pnls.reduce((a, b) => a + b, 0).toFixed(4)),
    wins: wins.length,
    losses: losses.length,
    winRate: Number((wins.length / trades.length).toFixed(3)),
    expectancyPoints: Number((pnls.reduce((a, b) => a + b, 0) / trades.length).toFixed(4)),
    maxDrawdownPoints: Number(maxDd.toFixed(4)),
    avgWin: wins.length ? Number((wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(4)) : null,
    avgLoss: losses.length
      ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(4))
      : null
  };
}

async function main(): Promise<void> {
  loadEnv();
  const { PrismaClient } = await import("@regimex/database");
  const prisma = new PrismaClient();
  const outDir = resolve(process.cwd(), "../../research-datasets/sep21-squeeze-loss-investigation");
  mkdirSync(outDir, { recursive: true });

  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!sym) throw new Error("R_10 symbol missing");

    // Broad window: Sep 20 noon UTC → Sep 21 end of available data
    const rows = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "1m",
        isComplete: true,
        openTime: {
          gte: new Date("2026-09-20T12:00:00.000Z"),
          lt: new Date("2026-09-21T23:59:00.000Z")
        }
      },
      orderBy: { openTime: "asc" }
    });
    const candles = rows.map(toCandle);
    const features = extractFeatures(candles, DEFAULT_FEATURE_CONFIG);
    const classifier = new RuleBasedRegimeClassifier();
    const strategy = new SqueezeBreakoutStrategy();

    // Locate bars whose high/low span reported fill prices (intra-bar fills ≠ close).
    const tradeRecon = TRADES.map((t) => {
      const candidates = candles
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.low <= t.entry && c.high >= t.entry)
        .map(({ c, i }) => {
          // Prefer bars where close is near entry or high pierces consolidation
          const dist = Math.abs(c.close - t.entry);
          return { i, openTime: new Date(c.openTime).toISOString(), ...c, dist };
        })
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8);

      const exitCandidates = candles
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.low <= t.exit && c.high >= t.exit)
        .map(({ c, i }) => ({
          i,
          openTime: new Date(c.openTime).toISOString(),
          low: c.low,
          high: c.high,
          close: c.close,
          dist: Math.abs(c.low - t.exit)
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5);

      return { ticket: t.ticket, entry: t.entry, exit: t.exit, pnl: t.pnl, candidates, exitCandidates };
    });

    // Walk strategy decisions on Sep 21 complete candles only
    const sep21Start = Date.parse("2026-09-21T00:00:00.000Z");
    const signalTrace: unknown[] = [];
    let lastSig = Number.NEGATIVE_INFINITY;
    for (let i = 80; i < candles.length; i++) {
      if (candles[i]!.openTime < sep21Start) continue;
      const f = features[i]!;
      const regime = classifier.classify({ features: f, thresholds: DEFAULT_REGIME_THRESHOLDS });
      const since = lastSig < 0 ? Number.POSITIVE_INFINITY : i - lastSig;
      const decision = strategy.evaluate({
        candles: candles.slice(0, i + 1),
        features: features.slice(0, i + 1),
        regime,
        parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
        candlesSinceLastSignal: since
      });
      if (decision.action === "BUY" || decision.action === "SELL") {
        lastSig = i;
        const proposal = proposeCfdStopTarget({
          strategyId: "squeeze-breakout-v1",
          direction: decision.action,
          entryPrice: candles[i]!.close,
          features: f,
          candles: candles.slice(0, i + 1),
          metadata: decision.metadata,
          tickSize: 0.001
        });
        signalTrace.push({
          openTime: new Date(candles[i]!.openTime).toISOString(),
          close: candles[i]!.close,
          high: candles[i]!.high,
          low: candles[i]!.low,
          action: decision.action,
          confidence: decision.confidence,
          entryReason: decision.entryReason,
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          donchianHigh: f.donchianHigh,
          donchianLow: f.donchianLow,
          bollingerWidth: f.bollingerWidth,
          recentReturn: f.recentReturn,
          volatilityPercentile: f.volatilityPercentile,
          atr: f.atr,
          stop: proposal?.stopLoss ?? null,
          target: proposal?.takeProfit ?? null,
          stopMethod: proposal?.method ?? null
        });
      }
    }

    // Detailed reconstruction around nearest matching bars for each ticket
    const detailedSetups = TRADES.map((t) => {
      const match = tradeRecon.find((r) => r.ticket === t.ticket)!;
      const best = match.candidates[0];
      if (!best) {
        return { ticket: t.ticket, error: "No complete candle spans reported entry price" };
      }
      const i = best.i;
      // Look back 30 bars of OHLC around entry for consolidation context
      const window = candles.slice(Math.max(0, i - 40), Math.min(candles.length, i + 25)).map((c, idx) => {
        const gi = Math.max(0, i - 40) + idx;
        const f = features[gi]!;
        const regime = classifier.classify({ features: f, thresholds: DEFAULT_REGIME_THRESHOLDS });
        return {
          openTime: new Date(c.openTime).toISOString(),
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
          source: c.source,
          isComplete: c.isComplete,
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          donchianHigh: f.donchianHigh,
          recentReturn: f.recentReturn,
          bollingerWidth: f.bollingerWidth,
          volPct: f.volatilityPercentile,
          relativeToEntry: gi - i
        };
      });

      const f = features[i]!;
      const regime = classifier.classify({ features: f, thresholds: DEFAULT_REGIME_THRESHOLDS });
      const since = 99;
      const decision = strategy.evaluate({
        candles: candles.slice(0, i + 1),
        features: features.slice(0, i + 1),
        regime,
        parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
        candlesSinceLastSignal: since
      });
      const proposal = proposeCfdStopTarget({
        strategyId: "squeeze-breakout-v1",
        direction: "BUY",
        entryPrice: t.entry,
        features: f,
        candles: candles.slice(0, i + 1),
        metadata: decision.metadata,
        tickSize: 0.001
      });

      // Path after entry until reported exit level
      const path: unknown[] = [];
      for (let j = i; j < Math.min(candles.length, i + 30); j++) {
        const c = candles[j]!;
        path.push({
          openTime: new Date(c.openTime).toISOString(),
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
          hitSlBand: c.low <= t.exit + 0.05,
          barsAfterEntry: j - i
        });
        if (c.low <= t.exit + 0.05 && j > i) break;
      }

      return {
        ticket: t.ticket,
        reported: t,
        matchedEntryBar: {
          openTime: best.openTime,
          ohlc: { o: best.open, h: best.high, l: best.low, c: best.close },
          source: best.source,
          note: "Complete HISTORY_API 1m bar spanning fill; actual MT5 fill is intra-bar (sampled ticks not available locally)"
        },
        exitCandidates: match.exitCandidates,
        decisionAtMatchedBar: {
          action: decision.action,
          confidence: decision.confidence,
          entryReason: decision.entryReason,
          invalidationReason: decision.invalidationReason,
          regime: regime.regime,
          regimeConfidence: regime.confidence,
          donchianHigh: f.donchianHigh,
          recentReturn: f.recentReturn,
          bollingerWidth: f.bollingerWidth,
          volPct: f.volatilityPercentile
        },
        stopTargetAtReportedEntry: proposal
          ? {
              stop: proposal.stopLoss,
              target: proposal.takeProfit,
              method: proposal.method,
              risk: t.entry - proposal.stopLoss,
              reward: proposal.takeProfit - t.entry
            }
          : null,
        window,
        pathToExit: path
      };
    });

    // Compare second vs first: same consolidation?
    const a = detailedSetups[0] as { matchedEntryBar?: { openTime: string }; decisionAtMatchedBar?: { donchianHigh: number | null } };
    const b = detailedSetups[1] as { matchedEntryBar?: { openTime: string }; decisionAtMatchedBar?: { donchianHigh: number | null } };
    const relationship = {
      entryPriceDelta: TRADES[1]!.entry - TRADES[0]!.entry,
      entryPriceDeltaPct: ((TRADES[1]!.entry - TRADES[0]!.entry) / TRADES[0]!.entry) * 100,
      donchianHighFirst: a.decisionAtMatchedBar?.donchianHigh ?? null,
      donchianHighSecond: b.decisionAtMatchedBar?.donchianHigh ?? null,
      sameDonchianHigh:
        a.decisionAtMatchedBar?.donchianHigh != null &&
        b.decisionAtMatchedBar?.donchianHigh != null &&
        Math.abs(a.decisionAtMatchedBar.donchianHigh - b.decisionAtMatchedBar.donchianHigh) < 0.01,
      minutesBetweenMatchedBars:
        a.matchedEntryBar && b.matchedEntryBar
          ? (Date.parse(b.matchedEntryBar.openTime) - Date.parse(a.matchedEntryBar.openTime)) / 60_000
          : null
    };

    // Offline variant backtests on contiguous Sep 19–21 segment available locally
    const backtestRows = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "1m",
        isComplete: true,
        openTime: {
          gte: new Date("2026-09-19T00:01:00.000Z"),
          lt: new Date("2026-09-21T16:30:00.000Z")
        }
      },
      orderBy: { openTime: "asc" }
    });
    const btCandles = backtestRows.map(toCandle);
    const btFeatures = extractFeatures(btCandles, DEFAULT_FEATURE_CONFIG);
    const variantResults = VARIANTS.map((v) => {
      const { trades } = simulateVariant(btCandles, btFeatures, classifier, v);
      const summary = summarize(trades);
      // Would each reported losing ticket's matched bar still fire?
      const ticketOutcomes = detailedSetups.map((setup) => {
        if (!("matchedEntryBar" in setup) || !setup.matchedEntryBar) {
          return { ticket: (setup as { ticket: string }).ticket, stillWouldEnter: null };
        }
        const openTime = Date.parse(setup.matchedEntryBar.openTime);
        const hit = trades.find((t) => Math.abs(Date.parse(t.entryTimeIso) - openTime) < 120_000);
        return {
          ticket: (setup as { ticket: string }).ticket,
          stillWouldEnter: Boolean(hit),
          matchedSimTrade: hit
            ? {
                entry: hit.entryPrice,
                exit: hit.exitPrice,
                reason: hit.exitReason,
                pnlPoints: hit.pnlPoints
              }
            : null
        };
      });
      return {
        variant: v.id,
        label: v.label,
        window: {
          from: "2026-09-19T00:01:00.000Z",
          to: "2026-09-21T16:29:00.000Z",
          bars: btCandles.length,
          source: "HISTORY_API complete 1m"
        },
        summary,
        ticketOutcomes,
        sampleTrades: trades.slice(0, 15)
      };
    });

    const baseline = variantResults.find((v) => v.variant === "baseline")!;
    const comparisons = variantResults.map((v) => ({
      variant: v.variant,
      label: v.label,
      deltaTrades: (v.summary.trades as number) - (baseline.summary.trades as number),
      deltaNetPnlPoints:
        (v.summary.netPnlPoints as number) - (baseline.summary.netPnlPoints as number),
      deltaExpectancy:
        v.summary.expectancyPoints != null && baseline.summary.expectancyPoints != null
          ? Number(
              ((v.summary.expectancyPoints as number) - (baseline.summary.expectancyPoints as number)).toFixed(4)
            )
          : null,
      deltaMaxDD:
        (v.summary.maxDrawdownPoints as number) - (baseline.summary.maxDrawdownPoints as number),
      sep21TicketsAvoided: v.ticketOutcomes.filter((t) => t.stillWouldEnter === false).map((t) => t.ticket)
    }));

    const report = {
      generatedAt: new Date().toISOString(),
      scope: {
        objective: "Investigate two losing R_10 DEMO squeeze-breakout BUYs on 2026-09-21",
        tickets: TRADES,
        dataLimitations: [
          "Local PostgreSQL has no Position/Signal rows for these tickets (server DEMO DB only)",
          "Reconstruction uses Deriv HISTORY_API complete 1m candles — not MT5 fill ticks",
          "Entry fills are intra-bar; matched bars are those whose OHLC spans the reported fill",
          "MT5 quote-timeout events not present in local DecisionLog — cannot confirm from this DB",
          "Candidate backtests are closed-candle research simulations with ATR stops; costs not modeled as MT5 spreads/slippage",
          "Sample window is short (~2.7 days continuous after Sep 19 gap) — underpowered for promotion decisions"
        ]
      },
      strategyBaseline: {
        id: "squeeze-breakout-v1",
        defaults: SQUEEZE_BREAKOUT_DEFAULTS,
        buyChecklist: [
          "cooldown clear (8 bars)",
          "BB squeeze in prior 10 bars (width<=0.008 and vol%<=30)",
          "close > prior-20 Donchian high",
          "10-bar recentReturn >= 0.0008 (~0.08%)",
          "BB width > 1.1 × squeeze min width",
          "confidence >= 0.6"
        ],
        stopTarget: {
          structureBufferAtr: 0.25,
          stopAtrMultipleFallback: 1.5,
          targetRMultiple: 2
        }
      },
      candleCoverage: {
        loadedBars: candles.length,
        first: candles[0] ? new Date(candles[0].openTime).toISOString() : null,
        last: candles.length
          ? new Date(candles[candles.length - 1]!.openTime).toISOString()
          : null,
        sources: [...new Set(candles.map((c) => c.source))]
      },
      signalTraceSep21: signalTrace,
      detailedSetups,
      relationshipFirstVsSecond: relationship,
      variantBacktests: variantResults,
      comparisonsVsBaseline: comparisons,
      quoteTimeoutNote:
        "No local ENGINE_DEGRADED/timeout DecisionLog for these tickets. Treat quote timeout as independent of P&L path unless server logs show otherwise; both losses hit SL ~17–18m later per user report, which is consistent with price path rather than an immediate timeout-forced exit."
    };

    writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(
      resolve(outDir, "report.md"),
      formatMarkdown(report)
    );
    console.log(
      JSON.stringify(
        {
          wrote: {
            json: resolve(outDir, "report.json"),
            md: resolve(outDir, "report.md")
          },
          signalCountSep21: signalTrace.length,
          relationship,
          comparisons,
          baselineSummary: baseline.summary
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

function formatMarkdown(report: {
  generatedAt: string;
  scope: { dataLimitations: string[]; tickets: typeof TRADES };
  relationshipFirstVsSecond: Record<string, unknown>;
  signalTraceSep21: unknown[];
  comparisonsVsBaseline: Array<Record<string, unknown>>;
  variantBacktests: Array<{ variant: string; summary: Record<string, number | null>; ticketOutcomes: unknown[] }>;
  detailedSetups: unknown[];
  quoteTimeoutNote: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Sep 21 R_10 squeeze-breakout loss investigation`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`## Limitations`);
  for (const l of report.scope.dataLimitations) lines.push(`- ${l}`);
  lines.push("");
  lines.push(`## First vs second entry`);
  lines.push("```json");
  lines.push(JSON.stringify(report.relationshipFirstVsSecond, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Sep 21 strategy BUY/SELL signals on complete candles: ${report.signalTraceSep21.length}`);
  lines.push("");
  lines.push(`## Candidate comparisons vs baseline (points, not $)`);
  lines.push("```json");
  lines.push(JSON.stringify(report.comparisonsVsBaseline, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Quote timeout`);
  lines.push(report.quoteTimeoutNote);
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
