import { type Candle, type InstrumentMetadata } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { computeCfdSummary, type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { CFD_SIMULATOR_VERSION } from "@regimex/shared";
import {
  BreakoutMomentumStrategy,
  BREAKOUT_MOMENTUM_DEFAULTS
} from "../strategies/breakoutMomentum.js";
import {
  SqueezeBreakoutStrategy,
  SQUEEZE_BREAKOUT_DEFAULTS
} from "../strategies/squeezeBreakout.js";
import { type TradingStrategy } from "../strategies/types.js";
import {
  assertNoHoldoutLeakage,
  generateDevelopmentWalkForwardWindows,
  splitHoldout,
  splitHoldoutByTimestamp
} from "./holdoutSplit.js";
import {
  computeWalkForwardStability,
  summarizeTrades,
  type SplitMetrics,
  type WalkForwardStability
} from "./benchmarkMetrics.js";
import {
  aggregateCostToMove,
  computeTradeCostToMove,
  estimateBreakEvenCost,
  type CostSweepPoint,
  type CostToMoveAggregate
} from "./costToMove.js";
import { type WalkForwardConfig } from "../optimize/walkForward.js";
import { detectContinuousSegments, sliceSegment } from "./gapSegments.js";

export const BREAKOUT_FAMILY_STRATEGY_IDS = [
  "breakout-momentum-v1",
  "squeeze-breakout-v1"
] as const;

export type BreakoutFamilyStrategyId = (typeof BREAKOUT_FAMILY_STRATEGY_IDS)[number];

export interface BreakoutFamilySpec {
  strategyId: BreakoutFamilyStrategyId;
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
}

export function listBreakoutFamilyStrategies(): BreakoutFamilySpec[] {
  const specs: BreakoutFamilySpec[] = [
    {
      strategyId: "breakout-momentum-v1",
      strategy: new BreakoutMomentumStrategy(),
      parameters: { ...BREAKOUT_MOMENTUM_DEFAULTS }
    },
    {
      strategyId: "squeeze-breakout-v1",
      strategy: new SqueezeBreakoutStrategy(),
      parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS }
    }
  ];
  return specs.sort((a, b) => a.strategyId.localeCompare(b.strategyId));
}

function instrument(
  symbol: string,
  spreadBps: number,
  slippageBps: number
): InstrumentMetadata {
  return {
    symbol,
    enabled: true,
    verified: true,
    contractSize: 1,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 5,
    tickSize: 0.001,
    tickValue: 0.1,
    marginRate: 0.01,
    spreadBps,
    slippageBps,
    pricePrecision: 3,
    currency: "USD"
  };
}

async function runBacktest(
  candles: ReadonlyArray<Candle>,
  spec: BreakoutFamilySpec,
  spreadBps: number,
  slippageBps: number,
  opts: { maxHoldBars: number; symbol: string; respectGaps?: boolean; maxGapMs?: number }
) {
  const respectGaps = opts.respectGaps !== false;
  const barMs =
    candles.length >= 2
      ? (() => {
          // Prefer declared interval; fall back to median successive delta.
          const iv = candles[0]?.interval;
          if (iv === "1m") return 60_000;
          if (iv === "5m") return 300_000;
          const deltas: number[] = [];
          for (let i = 1; i < Math.min(candles.length, 50); i++) {
            deltas.push(candles[i]!.openTime - candles[i - 1]!.openTime);
          }
          deltas.sort((a, b) => a - b);
          return deltas[Math.floor(deltas.length / 2)] ?? 60_000;
        })()
      : 60_000;
  // Allow one missing bar before splitting; never use a fixed 2m threshold on 5m tapes.
  const maxGapMs = opts.maxGapMs ?? 2 * barMs;

  if (!respectGaps || candles.length === 0) {
    return new CfdBacktester({
      startingBalance: 10_000,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: opts.maxHoldBars,
      instrument: instrument(opts.symbol, spreadBps, slippageBps),
      strategies: [{ strategy: spec.strategy, parameters: spec.parameters }],
      testSplit: 0
    }).run(candles);
  }

  // Gap-safe: run each continuous segment independently so indicators/positions
  // do not bridge multi-hour/day holes as if time were continuous.
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const segs = detectContinuousSegments(sorted, maxGapMs);
  const allTrades: CfdSimulatedTrade[] = [];
  let equity = 10_000;
  let cancelled = false;
  // Scale min segment length with bar size (~80 1m bars ≈ ~16 5m bars).
  const minSegmentBars = Math.max(40, Math.round(80 * (60_000 / barMs)));

  for (const seg of segs.segments) {
    if (seg.candleCount < minSegmentBars) continue;
    const slice = sliceSegment(sorted, seg);
    const run = await new CfdBacktester({
      startingBalance: equity,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: opts.maxHoldBars,
      instrument: instrument(opts.symbol, spreadBps, slippageBps),
      strategies: [{ strategy: spec.strategy, parameters: spec.parameters }],
      testSplit: 0
    }).run(slice);
    allTrades.push(...run.trades);
    equity = run.summary.endingBalance;
    cancelled = cancelled || run.cancelled;
  }

  const { summary, equityCurve } = computeCfdSummary(allTrades, 10_000);
  return {
    cancelled,
    simulatorVersion: CFD_SIMULATOR_VERSION,
    summary,
    equityCurve,
    trades: allTrades,
    validation: null
  };
}

function costMetricsForTrades(
  trades: ReadonlyArray<CfdSimulatedTrade>,
  spreadBps: number,
  slippageBps: number
): CostToMoveAggregate {
  const rows = trades.map((t) => computeTradeCostToMove(t, spreadBps, slippageBps));
  return aggregateCostToMove(rows);
}

export interface WinLossDiagnosticRow {
  outcome: string;
  action: string;
  regime: string;
  atr: number | null;
  adx: number | null;
  donchianWidthAtr: number | null;
  stopDistanceAtr: number | null;
  targetDistanceAtr: number | null;
  netR: number | null;
  grossR: number | null;
  barsHeld: number;
  candleBodySizeAtr: number | null;
  candleRangeAtr: number | null;
  distanceFromLongEmaAtr: number | null;
}

export function buildWinLossDiagnostics(
  trades: ReadonlyArray<CfdSimulatedTrade>
): {
  wins: WinLossDiagnosticRow[];
  losses: WinLossDiagnosticRow[];
  winMedians: Record<string, number | null>;
  lossMedians: Record<string, number | null>;
} {
  const row = (t: CfdSimulatedTrade): WinLossDiagnosticRow => {
    const atr = t.entryFeatures?.atr ?? null;
    const dh = t.entryFeatures?.donchianHigh ?? null;
    const dl = t.entryFeatures?.donchianLow ?? null;
    const width = dh != null && dl != null ? dh - dl : null;
    const stopDist = Math.abs(t.entryPrice - t.stopLoss);
    const targetDist = Math.abs(t.takeProfit - t.entryPrice);
    const body = t.entryFeatures?.candleBodySize ?? null;
    const range =
      t.entryFeatures != null
        ? Math.abs(
            (t.entryFeatures.distanceFromDonchianHigh ?? 0) -
              (t.entryFeatures.distanceFromDonchianLow ?? 0)
          )
        : null;
    // Prefer ATR-normalized body from features if present via candleBodySize / atr
    const bodyAtr =
      body != null && atr != null && atr > 0 ? body / atr : null;
    const longEma = t.entryFeatures?.emaLong ?? null;
    const distLong =
      longEma != null && atr != null && atr > 0
        ? Math.abs(t.entryPrice - longEma) / atr
        : null;
    return {
      outcome: t.outcome,
      action: t.action,
      regime: t.regime,
      atr,
      adx: t.entryFeatures?.adx ?? null,
      donchianWidthAtr: width != null && atr != null && atr > 0 ? width / atr : null,
      stopDistanceAtr: atr != null && atr > 0 ? stopDist / atr : null,
      targetDistanceAtr: atr != null && atr > 0 ? targetDist / atr : null,
      netR: t.netR,
      grossR: t.grossR,
      barsHeld: t.barsHeld,
      candleBodySizeAtr: bodyAtr,
      candleRangeAtr: range != null && atr != null && atr > 0 ? range / atr : null,
      distanceFromLongEmaAtr: distLong
    };
  };

  const wins = trades.filter((t) => t.outcome === "WIN").map(row);
  const losses = trades.filter((t) => t.outcome === "LOSS").map(row);

  const med = (rows: WinLossDiagnosticRow[], key: keyof WinLossDiagnosticRow) => {
    const xs = rows
      .map((r) => r[key])
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
  };

  const keys: (keyof WinLossDiagnosticRow)[] = [
    "atr",
    "adx",
    "donchianWidthAtr",
    "stopDistanceAtr",
    "targetDistanceAtr",
    "netR",
    "grossR",
    "barsHeld",
    "candleBodySizeAtr",
    "distanceFromLongEmaAtr"
  ];

  return {
    wins,
    losses,
    winMedians: Object.fromEntries(keys.map((k) => [k, med(wins, k)])),
    lossMedians: Object.fromEntries(keys.map((k) => [k, med(losses, k)]))
  };
}

export type BreakoutTfClass =
  | "RAW_EDGE_COST_KILLED"
  | "NO_RAW_EDGE"
  | "PROMISING"
  | "INCONCLUSIVE_TOO_SPARSE";

export function classifyBreakoutTf(input: {
  holdoutTrades: number;
  zeroExpR: number;
  realisticExpR: number;
  wfPositivePct: number;
}): BreakoutTfClass {
  if (input.holdoutTrades < 20) return "INCONCLUSIVE_TOO_SPARSE";
  if (input.zeroExpR <= 0) return "NO_RAW_EDGE";
  if (input.realisticExpR > 0 && input.wfPositivePct >= 0.5) return "PROMISING";
  if (input.zeroExpR > 0 && input.realisticExpR <= 0) return "RAW_EDGE_COST_KILLED";
  return "NO_RAW_EDGE";
}

export interface BreakoutTimeframeRun {
  timeframe: string;
  candleCount: number;
  developmentCount: number;
  holdoutCount: number;
  holdoutStartOpenTime: number;
  strategyId: string;
  realistic: {
    development: SplitMetrics;
    holdout: SplitMetrics;
    walkForward: WalkForwardStability;
    costToMoveHoldout: CostToMoveAggregate;
    costToMoveDevelopment: CostToMoveAggregate;
  };
  zeroCost: {
    development: SplitMetrics;
    holdout: SplitMetrics;
  };
  costSweep: CostSweepPoint[];
  breakEven: ReturnType<typeof estimateBreakEvenCost>;
  winLossDiagnostics: ReturnType<typeof buildWinLossDiagnostics>;
  classification: BreakoutTfClass;
}

export interface BreakoutFamilyResearchConfig {
  symbol: string;
  holdoutPercent: number;
  costSweep: Array<{ spreadBps: number; slippageBps: number }>;
  realistic: { spreadBps: number; slippageBps: number };
  walkForward1m: WalkForwardConfig;
  walkForward5m: WalkForwardConfig;
  maxHoldBars1m: number;
  maxHoldBars5m: number;
}

export const DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG: BreakoutFamilyResearchConfig = {
  symbol: "R_10",
  holdoutPercent: 0.3,
  realistic: { spreadBps: 8, slippageBps: 3 },
  costSweep: [
    { spreadBps: 4, slippageBps: 1 },
    { spreadBps: 6, slippageBps: 2 },
    { spreadBps: 8, slippageBps: 3 },
    { spreadBps: 10, slippageBps: 4 }
  ],
  walkForward1m: {
    trainWindow: 2000,
    testWindow: 400,
    stepSize: 400,
    windowMode: "rolling"
  },
  walkForward5m: {
    trainWindow: 400,
    testWindow: 100,
    stepSize: 100,
    windowMode: "rolling"
  },
  maxHoldBars1m: 60,
  maxHoldBars5m: 24
};

async function runStrategyOnSeries(
  candles: Candle[],
  spec: BreakoutFamilySpec,
  cfg: BreakoutFamilyResearchConfig,
  timeframe: string,
  holdoutStartOpenTime: number,
  wf: WalkForwardConfig,
  maxHoldBars: number
): Promise<BreakoutTimeframeRun> {
  const split = splitHoldoutByTimestamp(candles, holdoutStartOpenTime);
  assertNoHoldoutLeakage(split.development, holdoutStartOpenTime);

  const { spreadBps, slippageBps } = cfg.realistic;
  const [devR, holdR, devZ, holdZ] = await Promise.all([
    runBacktest(split.development, spec, spreadBps, slippageBps, {
      maxHoldBars,
      symbol: cfg.symbol
    }),
    runBacktest(split.holdout, spec, spreadBps, slippageBps, {
      maxHoldBars,
      symbol: cfg.symbol
    }),
    runBacktest(split.development, spec, 0, 0, { maxHoldBars, symbol: cfg.symbol }),
    runBacktest(split.holdout, spec, 0, 0, { maxHoldBars, symbol: cfg.symbol })
  ]);

  const wfWindows = generateDevelopmentWalkForwardWindows(split.development.length, wf);
  const wfRows = [];
  for (let w = 0; w < wfWindows.length; w++) {
    const win = wfWindows[w]!;
    const slice = split.development.slice(win.testStart, win.testEnd);
    if (slice.length < 40) continue;
    const run = await runBacktest(slice, spec, spreadBps, slippageBps, {
      maxHoldBars,
      symbol: cfg.symbol
    });
    const m = summarizeTrades(run.trades, run.summary);
    wfRows.push({
      expectancyR: m.expectancyR,
      profitFactor: m.profitFactor,
      trades: m.trades,
      netR: m.netR
    });
  }
  const walkForward = computeWalkForwardStability(wfRows);

  const costSweep: CostSweepPoint[] = [];
  for (const c of cfg.costSweep) {
    const run = await runBacktest(split.holdout, spec, c.spreadBps, c.slippageBps, {
      maxHoldBars,
      symbol: cfg.symbol
    });
    const m = summarizeTrades(run.trades, run.summary);
    costSweep.push({
      spreadBps: c.spreadBps,
      slippageBps: c.slippageBps,
      trades: m.trades,
      expectancyR: m.expectancyR,
      profitFactor: m.profitFactor,
      netR: m.netR
    });
  }

  const holdMetrics = summarizeTrades(holdR.trades, holdR.summary);
  const zeroHold = summarizeTrades(holdZ.trades, holdZ.summary);
  const classification = classifyBreakoutTf({
    holdoutTrades: holdMetrics.trades,
    zeroExpR: zeroHold.expectancyR,
    realisticExpR: holdMetrics.expectancyR,
    wfPositivePct: walkForward.percentPositiveExpectancy
  });

  return {
    timeframe,
    candleCount: candles.length,
    developmentCount: split.development.length,
    holdoutCount: split.holdout.length,
    holdoutStartOpenTime,
    strategyId: spec.strategyId,
    realistic: {
      development: summarizeTrades(devR.trades, devR.summary),
      holdout: holdMetrics,
      walkForward,
      costToMoveHoldout: costMetricsForTrades(holdR.trades, spreadBps, slippageBps),
      costToMoveDevelopment: costMetricsForTrades(devR.trades, spreadBps, slippageBps)
    },
    zeroCost: {
      development: summarizeTrades(devZ.trades, devZ.summary),
      holdout: zeroHold
    },
    costSweep,
    breakEven: estimateBreakEvenCost(costSweep),
    winLossDiagnostics: buildWinLossDiagnostics([...devR.trades, ...holdR.trades]),
    classification
  };
}

/**
 * Research-only breakout family evaluation on 1m and contiguous 5m.
 * Does not mutate strategy logic or production paths.
 */
export async function runBreakoutFamilyResearch(input: {
  candles1m: ReadonlyArray<Candle>;
  candles5mContiguous: ReadonlyArray<Candle>;
  config?: Partial<BreakoutFamilyResearchConfig>;
}): Promise<{
  holdoutStartOpenTime: number;
  holdoutUsedForParameterSelection: false;
  runs: BreakoutTimeframeRun[];
  notes: {
    deployed: false;
    demoEnabled: false;
    emaPullbackRemainsSuspended: true;
    productionUnchanged: true;
  };
}> {
  const cfg: BreakoutFamilyResearchConfig = {
    ...DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG,
    ...input.config,
    realistic: {
      ...DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG.realistic,
      ...(input.config?.realistic ?? {})
    },
    costSweep: input.config?.costSweep ?? DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG.costSweep,
    walkForward1m: {
      ...DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG.walkForward1m,
      ...(input.config?.walkForward1m ?? {})
    },
    walkForward5m: {
      ...DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG.walkForward5m,
      ...(input.config?.walkForward5m ?? {})
    }
  };

  const split1m = splitHoldout(input.candles1m, cfg.holdoutPercent);
  const holdoutStartOpenTime =
    split1m.holdout[0]?.openTime ??
    (input.candles1m[input.candles1m.length - 1]?.openTime ?? 0) + 1;

  const specs = listBreakoutFamilyStrategies();
  const runs: BreakoutTimeframeRun[] = [];
  for (const spec of specs) {
    runs.push(
      await runStrategyOnSeries(
        [...input.candles1m],
        spec,
        cfg,
        "1m",
        holdoutStartOpenTime,
        cfg.walkForward1m,
        cfg.maxHoldBars1m
      )
    );
    runs.push(
      await runStrategyOnSeries(
        [...input.candles5mContiguous],
        spec,
        cfg,
        "5m",
        holdoutStartOpenTime,
        cfg.walkForward5m,
        cfg.maxHoldBars5m
      )
    );
  }

  return {
    holdoutStartOpenTime,
    holdoutUsedForParameterSelection: false,
    runs: runs.sort((a, b) =>
      `${a.strategyId}:${a.timeframe}`.localeCompare(`${b.strategyId}:${b.timeframe}`)
    ),
    notes: {
      deployed: false,
      demoEnabled: false,
      emaPullbackRemainsSuspended: true,
      productionUnchanged: true
    }
  };
}

export interface BreakoutCostProfileHoldoutRow {
  strategyId: BreakoutFamilyStrategyId;
  timeframe: string;
  profileLabel: string;
  spreadBps: number;
  slippageBps: number;
  trades: number;
  winRate: number;
  profitFactor: number | null;
  expectancyR: number;
  netR: number;
  maxDrawdownPercent: number | null;
  costDragR: number | null;
}

/**
 * Re-run unchanged breakout strategies under multiple cost profiles with a fixed holdout cut.
 * Does not retune parameters or redefine holdout.
 */
export async function runBreakoutFamilyCostProfileComparison(input: {
  candles1m: ReadonlyArray<Candle>;
  candles5mContiguous: ReadonlyArray<Candle>;
  holdoutStartOpenTime: number;
  profiles: ReadonlyArray<{ label: string; spreadBps: number; slippageBps: number }>;
  config?: Partial<BreakoutFamilyResearchConfig>;
}): Promise<{
  holdoutStartOpenTime: number;
  rows: BreakoutCostProfileHoldoutRow[];
  notes: {
    deployed: false;
    demoEnabled: false;
    emaPullbackRemainsSuspended: true;
    productionUnchanged: true;
    holdoutRedefined: false;
  };
}> {
  const cfg: BreakoutFamilyResearchConfig = {
    ...DEFAULT_BREAKOUT_FAMILY_RESEARCH_CONFIG,
    ...input.config
  };
  const specs = listBreakoutFamilyStrategies();
  const series: Array<{ timeframe: string; candles: Candle[]; maxHold: number }> = [
    { timeframe: "1m", candles: [...input.candles1m], maxHold: cfg.maxHoldBars1m },
    { timeframe: "5m", candles: [...input.candles5mContiguous], maxHold: cfg.maxHoldBars5m }
  ];
  const rows: BreakoutCostProfileHoldoutRow[] = [];

  for (const spec of specs) {
    for (const s of series) {
      const split = splitHoldoutByTimestamp(s.candles, input.holdoutStartOpenTime);
      assertNoHoldoutLeakage(split.development, input.holdoutStartOpenTime);
      for (const profile of input.profiles) {
        const hold = await runBacktest(split.holdout, spec, profile.spreadBps, profile.slippageBps, {
          maxHoldBars: s.maxHold,
          symbol: cfg.symbol
        });
        const metrics = summarizeTrades(hold.trades, hold.summary);
        const ctm = costMetricsForTrades(hold.trades, profile.spreadBps, profile.slippageBps);
        rows.push({
          strategyId: spec.strategyId,
          timeframe: s.timeframe,
          profileLabel: profile.label,
          spreadBps: profile.spreadBps,
          slippageBps: profile.slippageBps,
          trades: metrics.trades,
          winRate: metrics.winRate,
          profitFactor: metrics.profitFactor,
          expectancyR: metrics.expectancyR,
          netR: metrics.netR,
          maxDrawdownPercent: metrics.maxDrawdownPercent,
          costDragR: ctm.medianCostDragR
        });
      }
    }
  }

  rows.sort((a, b) =>
    `${a.strategyId}:${a.timeframe}:${a.profileLabel}`.localeCompare(
      `${b.strategyId}:${b.timeframe}:${b.profileLabel}`
    )
  );

  return {
    holdoutStartOpenTime: input.holdoutStartOpenTime,
    rows,
    notes: {
      deployed: false,
      demoEnabled: false,
      emaPullbackRemainsSuspended: true,
      productionUnchanged: true,
      holdoutRedefined: false
    }
  };
}
