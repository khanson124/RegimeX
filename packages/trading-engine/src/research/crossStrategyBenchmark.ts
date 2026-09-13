import { type Candle, type InstrumentMetadata } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import {
  BollingerReversionStrategy,
  BOLLINGER_REVERSION_DEFAULTS
} from "../strategies/bollingerReversion.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "../strategies/squeezeBreakout.js";
import {
  TrendStructurePullbackStrategy,
  TREND_STRUCTURE_PULLBACK_DEFAULTS
} from "../strategies/trendStructurePullback.js";
import {
  TrendStructurePullbackV2Strategy,
  TREND_STRUCTURE_PULLBACK_V2_DEFAULTS
} from "../strategies/trendStructurePullbackV2.js";
import {
  XauMtfStructureMomentumStrategy,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS
} from "../strategies/xauMtfStructureMomentum.js";
import {
  XauVolatilityExpansionRetestStrategy,
  XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS
} from "../strategies/xauVolatilityExpansionRetest.js";
import {
  XauTrendPullbackStrategy,
  XAU_TREND_PULLBACK_DEFAULTS
} from "../strategies/xauTrendPullback.js";
import {
  XauTrendBreakoutV2Strategy,
  XAU_TREND_BREAKOUT_V2_DEFAULTS
} from "../strategies/xauTrendBreakoutV2.js";
import { CFD_CAPABLE_STRATEGY_IDS } from "../strategies/cfdCapability.js";
import { type TradingStrategy } from "../strategies/types.js";
import {
  generateDevelopmentWalkForwardWindows,
  splitHoldout
} from "./holdoutSplit.js";
import { inspectCandleDataQuality, type DataQualityReport } from "./dataQuality.js";
import {
  classifyCostEdgeCase,
  classifyStrategyFamily,
  computeWalkForwardStability,
  costDragExpectancyR,
  researchVerdict,
  summarizeTrades,
  type CostEdgeCase,
  type ResearchVerdict,
  type SplitMetrics,
  type StrategyFamily,
  type WalkForwardStability
} from "./benchmarkMetrics.js";
import { type WalkForwardConfig } from "../optimize/walkForward.js";

export interface BenchmarkStrategySpec {
  strategyId: string;
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
  family: StrategyFamily;
}

/** Deterministic catalogue of all CFD-capable research strategies at default params. */
export function listBenchmarkStrategies(
  ids?: ReadonlyArray<string>
): BenchmarkStrategySpec[] {
  const all: BenchmarkStrategySpec[] = [
    {
      strategyId: "breakout-momentum-v1",
      strategy: new BreakoutMomentumStrategy(),
      parameters: { ...BREAKOUT_MOMENTUM_DEFAULTS },
      family: classifyStrategyFamily("breakout-momentum-v1")
    },
    {
      strategyId: "ema-pullback-v1",
      strategy: new EmaPullbackStrategy(),
      parameters: { ...EMA_PULLBACK_DEFAULTS },
      family: classifyStrategyFamily("ema-pullback-v1")
    },
    {
      strategyId: "bollinger-reversion-v1",
      strategy: new BollingerReversionStrategy(),
      parameters: { ...BOLLINGER_REVERSION_DEFAULTS },
      family: classifyStrategyFamily("bollinger-reversion-v1")
    },
    {
      strategyId: "squeeze-breakout-v1",
      strategy: new SqueezeBreakoutStrategy(),
      parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
      family: classifyStrategyFamily("squeeze-breakout-v1")
    },
    {
      strategyId: "trend-structure-pullback-v1",
      strategy: new TrendStructurePullbackStrategy(),
      parameters: { ...TREND_STRUCTURE_PULLBACK_DEFAULTS },
      family: classifyStrategyFamily("trend-structure-pullback-v1")
    },
    {
      strategyId: "trend-structure-pullback-v2",
      strategy: new TrendStructurePullbackV2Strategy(),
      parameters: { ...TREND_STRUCTURE_PULLBACK_V2_DEFAULTS },
      family: classifyStrategyFamily("trend-structure-pullback-v2")
    },
    {
      strategyId: "xau-mtf-structure-momentum-v1",
      strategy: new XauMtfStructureMomentumStrategy(),
      parameters: { ...XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS },
      family: classifyStrategyFamily("xau-mtf-structure-momentum-v1")
    },
    {
      strategyId: "xau-volatility-expansion-retest-v1",
      strategy: new XauVolatilityExpansionRetestStrategy(),
      parameters: { ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS },
      family: classifyStrategyFamily("xau-volatility-expansion-retest-v1")
    },
    {
      strategyId: "xau-trend-pullback-v1",
      strategy: new XauTrendPullbackStrategy(),
      parameters: { ...XAU_TREND_PULLBACK_DEFAULTS },
      family: classifyStrategyFamily("xau-trend-pullback-v1")
    },
    {
      strategyId: "xau-trend-breakout-v2",
      strategy: new XauTrendBreakoutV2Strategy(),
      parameters: { ...XAU_TREND_BREAKOUT_V2_DEFAULTS },
      family: classifyStrategyFamily("xau-trend-breakout-v2")
    }
  ];

  const wanted = ids && ids.length > 0 ? new Set(ids) : null;
  const filtered = wanted ? all.filter((s) => wanted.has(s.strategyId)) : all;
  // Deterministic ordering by strategyId.
  return filtered.sort((a, b) => a.strategyId.localeCompare(b.strategyId));
}

export function assertAllCfdCapableCovered(specs: ReadonlyArray<BenchmarkStrategySpec>): void {
  const have = new Set(specs.map((s) => s.strategyId));
  for (const id of CFD_CAPABLE_STRATEGY_IDS) {
    if (!have.has(id) && specs.length >= CFD_CAPABLE_STRATEGY_IDS.length) {
      throw new Error(`Benchmark missing CFD-capable strategy ${id}`);
    }
  }
}

export interface CrossStrategyBenchmarkConfig {
  symbol: string;
  interval: string;
  holdoutPercent: number;
  spreadBps: number;
  slippageBps: number;
  startingBalance: number;
  riskPerTradePercent: number;
  minRiskRewardRatio: number;
  maxHoldBars: number;
  walkForward: WalkForwardConfig;
  tickSize: number;
  tickValue: number;
  maxVolume: number;
  /** Defaults to 1 (R_10-style). Gold MT5 CFD uses 100. */
  contractSize?: number;
  pricePrecision?: number;
  strategyIds?: string[];
}

export const DEFAULT_CROSS_STRATEGY_BENCHMARK_CONFIG: CrossStrategyBenchmarkConfig = {
  symbol: "R_10",
  interval: "1m",
  holdoutPercent: 0.3,
  spreadBps: 8,
  slippageBps: 3,
  startingBalance: 10_000,
  riskPerTradePercent: 0.5,
  minRiskRewardRatio: 1.5,
  maxHoldBars: 60,
  walkForward: {
    trainWindow: 2000,
    testWindow: 400,
    stepSize: 400,
    windowMode: "rolling"
  },
  tickSize: 0.001,
  tickValue: 0.1,
  maxVolume: 5
};

function instrumentFromConfig(
  cfg: CrossStrategyBenchmarkConfig,
  spreadBps: number,
  slippageBps: number
): InstrumentMetadata {
  return {
    symbol: cfg.symbol,
    enabled: true,
    verified: true,
    contractSize: cfg.contractSize ?? 1,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: cfg.maxVolume,
    tickSize: cfg.tickSize,
    tickValue: cfg.tickValue,
    marginRate: 0.01,
    spreadBps,
    slippageBps,
    pricePrecision: cfg.pricePrecision ?? 3,
    currency: "USD"
  };
}

/** MT5-DEMO-aligned XAUUSD research instrument (not an enablement). */
export const XAUUSD_CROSS_STRATEGY_BENCHMARK_CONFIG: CrossStrategyBenchmarkConfig = {
  symbol: "XAUUSD",
  interval: "1m",
  holdoutPercent: 0.3,
  spreadBps: 0.61,
  slippageBps: 0,
  startingBalance: 10_000,
  riskPerTradePercent: 0.5,
  minRiskRewardRatio: 1.5,
  maxHoldBars: 60,
  walkForward: {
    trainWindow: 2000,
    testWindow: 400,
    stepSize: 400,
    windowMode: "rolling"
  },
  tickSize: 0.01,
  tickValue: 1,
  maxVolume: 10,
  contractSize: 100,
  pricePrecision: 2
};

export interface WindowResult {
  window: number;
  testStart: number;
  testEnd: number;
  trades: number;
  expectancyR: number;
  profitFactor: number | null;
  netR: number;
}

export interface CostModeResult {
  spreadBps: number;
  slippageBps: number;
  development: SplitMetrics;
  holdout: SplitMetrics;
  walkForwardWindows: WindowResult[];
  walkForwardStability: WalkForwardStability;
}

export interface StrategyBenchmarkResult {
  strategyId: string;
  family: StrategyFamily;
  parameters: Record<string, number | boolean | string>;
  realistic: CostModeResult;
  zeroCost: CostModeResult;
  costDrag: {
    holdoutExpectancyR: number;
    developmentExpectancyR: number;
    holdoutNetR: number;
    developmentNetR: number;
  };
  costEdgeCase: CostEdgeCase;
  verdict: ResearchVerdict;
}

export interface CrossStrategyBenchmarkReport {
  config: CrossStrategyBenchmarkConfig;
  dataQuality: DataQualityReport;
  developmentCount: number;
  holdoutCount: number;
  holdoutStartIndex: number;
  walkForwardWindowCount: number;
  /** Explicit: holdout never used for parameter selection in this benchmark. */
  holdoutUsedForParameterSelection: false;
  strategies: StrategyBenchmarkResult[];
  rankings: {
    realisticHoldoutExpectancyR: string[];
    realisticHoldoutPf: string[];
    walkForwardStability: string[];
    costRobustness: string[];
    tradeCountAdequacy: string[];
    overallResearch: string[];
  };
  familySummary: Record<
    StrategyFamily,
    { strategyIds: string[]; anyPromising: boolean; allNoEdgeOrFailed: boolean }
  >;
  notes: {
    deployed: false;
    strategiesEnabled: false;
    emaPullbackRemainsSuspended: true;
    productionPathsUnchanged: true;
    fillSemantics: string;
  };
}

async function runOne(
  candles: ReadonlyArray<Candle>,
  spec: BenchmarkStrategySpec,
  instrument: InstrumentMetadata,
  cfg: CrossStrategyBenchmarkConfig
) {
  return new CfdBacktester({
    startingBalance: cfg.startingBalance,
    riskPerTradePercent: cfg.riskPerTradePercent,
    minRiskRewardRatio: cfg.minRiskRewardRatio,
    maxHoldBars: cfg.maxHoldBars,
    instrument,
    strategies: [{ strategy: spec.strategy, parameters: spec.parameters }],
    testSplit: 0
  }).run(candles);
}

async function runCostMode(
  spec: BenchmarkStrategySpec,
  development: Candle[],
  holdout: Candle[],
  cfg: CrossStrategyBenchmarkConfig,
  spreadBps: number,
  slippageBps: number
): Promise<CostModeResult> {
  const instrument = instrumentFromConfig(cfg, spreadBps, slippageBps);
  const [devRun, holdRun] = await Promise.all([
    runOne(development, spec, instrument, cfg),
    runOne(holdout, spec, instrument, cfg)
  ]);

  const wfWindows = generateDevelopmentWalkForwardWindows(development.length, cfg.walkForward);
  const walkForwardWindows: WindowResult[] = [];
  for (let w = 0; w < wfWindows.length; w++) {
    const win = wfWindows[w]!;
    const slice = development.slice(win.testStart, win.testEnd);
    if (slice.length < 50) continue;
    const run = await runOne(slice, spec, instrument, cfg);
    const m = summarizeTrades(run.trades, run.summary);
    walkForwardWindows.push({
      window: w,
      testStart: win.testStart,
      testEnd: win.testEnd,
      trades: m.trades,
      expectancyR: m.expectancyR,
      profitFactor: m.profitFactor,
      netR: m.netR
    });
  }

  return {
    spreadBps,
    slippageBps,
    development: summarizeTrades(devRun.trades, devRun.summary),
    holdout: summarizeTrades(holdRun.trades, holdRun.summary),
    walkForwardWindows,
    walkForwardStability: computeWalkForwardStability(walkForwardWindows)
  };
}

function buildRankings(strategies: StrategyBenchmarkResult[]): CrossStrategyBenchmarkReport["rankings"] {
  const byHoldExp = [...strategies].sort(
    (a, b) => b.realistic.holdout.expectancyR - a.realistic.holdout.expectancyR
  );
  const byHoldPf = [...strategies].sort((a, b) => {
    const ap = a.realistic.holdout.profitFactor;
    const bp = b.realistic.holdout.profitFactor;
    const an = ap == null || !Number.isFinite(ap) ? -Infinity : ap;
    const bn = bp == null || !Number.isFinite(bp) ? -Infinity : bp;
    return bn - an;
  });
  const byWf = [...strategies].sort((a, b) => {
    const as = a.realistic.walkForwardStability;
    const bs = b.realistic.walkForwardStability;
    if (bs.percentPositiveExpectancy !== as.percentPositiveExpectancy) {
      return bs.percentPositiveExpectancy - as.percentPositiveExpectancy;
    }
    return bs.medianExpectancyR - as.medianExpectancyR;
  });
  // Cost robustness: smaller drag when zero-cost was positive; else by abs drag ascending among no-edge.
  const byCost = [...strategies].sort((a, b) => {
    const aSensitive = a.costEdgeCase === "RAW_EDGE_KILLED_BY_COSTS" ? 0 : 1;
    const bSensitive = b.costEdgeCase === "RAW_EDGE_KILLED_BY_COSTS" ? 0 : 1;
    if (aSensitive !== bSensitive) return aSensitive - bSensitive;
    return a.costDrag.holdoutExpectancyR - b.costDrag.holdoutExpectancyR;
  });
  const byTrades = [...strategies].sort(
    (a, b) => b.realistic.holdout.trades - a.realistic.holdout.trades
  );

  const verdictRank: Record<ResearchVerdict, number> = {
    PROMISING_FOR_MORE_RESEARCH: 0,
    RAW_EDGE_BUT_COST_SENSITIVE: 1,
    UNSTABLE: 2,
    TOO_SPARSE: 3,
    FAILED: 4,
    NO_EDGE: 5
  };
  const overall = [...strategies].sort((a, b) => {
    const vd = verdictRank[a.verdict] - verdictRank[b.verdict];
    if (vd !== 0) return vd;
    return b.realistic.holdout.expectancyR - a.realistic.holdout.expectancyR;
  });

  return {
    realisticHoldoutExpectancyR: byHoldExp.map((s) => s.strategyId),
    realisticHoldoutPf: byHoldPf.map((s) => s.strategyId),
    walkForwardStability: byWf.map((s) => s.strategyId),
    costRobustness: byCost.map((s) => s.strategyId),
    tradeCountAdequacy: byTrades.map((s) => s.strategyId),
    overallResearch: overall.map((s) => s.strategyId)
  };
}

/**
 * Cross-strategy CFD benchmark. Research-only: does not mutate strategies,
 * lifecycle, allowlists, or production execution.
 */
export async function runCrossStrategyBenchmark(
  candles: ReadonlyArray<Candle>,
  config: Partial<CrossStrategyBenchmarkConfig> = {}
): Promise<CrossStrategyBenchmarkReport> {
  const cfg: CrossStrategyBenchmarkConfig = {
    ...DEFAULT_CROSS_STRATEGY_BENCHMARK_CONFIG,
    ...config,
    walkForward: {
      ...DEFAULT_CROSS_STRATEGY_BENCHMARK_CONFIG.walkForward,
      ...(config.walkForward ?? {})
    }
  };

  const expectedIntervalMs =
    cfg.interval === "1m" ? 60_000 : cfg.interval === "5m" ? 300_000 : 60_000;

  const dataQuality = inspectCandleDataQuality(candles, { expectedIntervalMs });
  const split = splitHoldout(candles, cfg.holdoutPercent);
  const wfWindows = generateDevelopmentWalkForwardWindows(split.development.length, cfg.walkForward);

  const specs = listBenchmarkStrategies(cfg.strategyIds);
  if (specs.length === 0) throw new Error("No strategies selected for benchmark");

  const strategies: StrategyBenchmarkResult[] = [];
  for (const spec of specs) {
    const [realistic, zeroCost] = await Promise.all([
      runCostMode(spec, split.development, split.holdout, cfg, cfg.spreadBps, cfg.slippageBps),
      runCostMode(spec, split.development, split.holdout, cfg, 0, 0)
    ]);

    const costCase = classifyCostEdgeCase({
      holdoutTradesRealistic: realistic.holdout.trades,
      holdoutTradesZero: zeroCost.holdout.trades,
      zeroCostHoldoutExpR: zeroCost.holdout.expectancyR,
      realisticHoldoutExpR: realistic.holdout.expectancyR
    });
    const verdict = researchVerdict({
      costCase,
      wf: realistic.walkForwardStability,
      holdoutTrades: realistic.holdout.trades
    });

    strategies.push({
      strategyId: spec.strategyId,
      family: spec.family,
      parameters: spec.parameters,
      realistic,
      zeroCost,
      costDrag: {
        holdoutExpectancyR: costDragExpectancyR(
          zeroCost.holdout.expectancyR,
          realistic.holdout.expectancyR
        ),
        developmentExpectancyR: costDragExpectancyR(
          zeroCost.development.expectancyR,
          realistic.development.expectancyR
        ),
        holdoutNetR: Number((zeroCost.holdout.netR - realistic.holdout.netR).toFixed(4)),
        developmentNetR: Number((zeroCost.development.netR - realistic.development.netR).toFixed(4))
      },
      costEdgeCase: costCase,
      verdict
    });
  }

  const familySummary = {
    trend_pullback: { strategyIds: [] as string[], anyPromising: false, allNoEdgeOrFailed: true },
    mean_reversion: { strategyIds: [] as string[], anyPromising: false, allNoEdgeOrFailed: true },
    breakout_momentum: { strategyIds: [] as string[], anyPromising: false, allNoEdgeOrFailed: true }
  };
  for (const s of strategies) {
    const f = familySummary[s.family];
    f.strategyIds.push(s.strategyId);
    if (s.verdict === "PROMISING_FOR_MORE_RESEARCH") f.anyPromising = true;
    if (
      s.verdict !== "NO_EDGE" &&
      s.verdict !== "FAILED" &&
      s.costEdgeCase !== "NO_EDGE_EVEN_BEFORE_COSTS"
    ) {
      f.allNoEdgeOrFailed = false;
    }
  }

  return {
    config: cfg,
    dataQuality,
    developmentCount: split.development.length,
    holdoutCount: split.holdout.length,
    holdoutStartIndex: split.holdoutStartIndex,
    walkForwardWindowCount: wfWindows.length,
    holdoutUsedForParameterSelection: false,
    strategies,
    rankings: buildRankings(strategies),
    familySummary,
    notes: {
      deployed: false,
      strategiesEnabled: false,
      emaPullbackRemainsSuspended: true,
      productionPathsUnchanged: true,
      fillSemantics:
        "mid → adverse fill → propose SL/TP from fill → validate R:R from fill (CfdBacktester)"
    }
  };
}
