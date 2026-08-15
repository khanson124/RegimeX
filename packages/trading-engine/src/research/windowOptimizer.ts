import { type Candle, type StrategyKind } from "@regimex/shared";
import { Backtester } from "../backtest/backtester.js";
import { type BacktestSummary } from "../backtest/metrics.js";
import {
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS
} from "../strategies/registry.js";
import {
  generateCombinations,
  rankCandidates,
  type CandidateResult,
  type ParameterSpace
} from "../optimize/gridSearch.js";
import { type BacktestConfig, type BacktestStrategyInput } from "../backtest/backtester.js";

export interface WindowOptimizerConfig {
  startingBalance: number;
  stakeAmount: number;
  contractDurationCandles: number;
  assumedPayoutRatio: number;
  selectionMode: BacktestConfig["selectionMode"];
  regimeFilterMode: BacktestConfig["regimeFilterMode"];
  /** Internal validation split within train window only (0 = pure IS ranking). */
  internalValidationSplit: number;
  strategies: BacktestStrategyInput[];
}

export interface WindowOptimizationResult {
  strategyId: string;
  strategyKind: StrategyKind;
  selectedParameters: Record<string, number | boolean | string>;
  trainSummary: BacktestSummary;
  allCandidates: CandidateResult[];
  stabilityScore: number;
}

/**
 * Optimize parameters on train candles ONLY.
 * Leakage guard: caller must pass train slice only — never include test/holdout candles.
 */
export async function optimizeOnTrainWindow(
  trainCandles: ReadonlyArray<Candle>,
  strategy: BacktestStrategyInput,
  parameterSpace: ParameterSpace,
  config: WindowOptimizerConfig
): Promise<WindowOptimizationResult> {
  if (trainCandles.length < 50) {
    throw new Error(`Train window too small for optimization (${trainCandles.length} candles)`);
  }

  const kind = inferKind(strategy);
  const combos = generateCombinations(parameterSpace);
  const results: CandidateResult[] = [];

  for (const combo of combos) {
    const s = createStrategy(kind);
    const parameters = s.validateParameters({
      ...DEFAULT_STRATEGY_PARAMETERS[kind],
      ...combo
    });

    const backtester = new Backtester({
      startingBalance: config.startingBalance,
      stakeAmount: config.stakeAmount,
      contractDurationCandles: config.contractDurationCandles,
      assumedPayoutRatio: config.assumedPayoutRatio,
      testSplit: config.internalValidationSplit,
      selectionMode: "SINGLE",
      regimeFilterMode: config.regimeFilterMode,
      strategies: [{ strategy: s, parameters }]
    });
    const result = await backtester.run(trainCandles);
    const train = result.validation?.train ?? result.summary;
    const internalTest = result.validation?.test ?? result.summary;

    results.push({
      parameters: combo,
      trainNetProfit: train.netProfit,
      trainProfitFactor: train.profitFactor,
      trainTrades: train.totalTrades,
      testNetProfit: internalTest.netProfit,
      testProfitFactor: internalTest.profitFactor,
      testTrades: internalTest.totalTrades,
      testExpectancy: internalTest.expectancy,
      maxDrawdownPercent: result.summary.maxDrawdownPercent * 100
    });
  }

  const ranked = rankCandidates(results);
  const best = ranked[0];
  if (!best) {
    return {
      strategyId: strategy.strategy.id,
      strategyKind: kind,
      selectedParameters: { ...strategy.parameters },
      trainSummary: emptySummary(),
      allCandidates: results,
      stabilityScore: 0
    };
  }

  const fullTrainBacktester = new Backtester({
    startingBalance: config.startingBalance,
    stakeAmount: config.stakeAmount,
    contractDurationCandles: config.contractDurationCandles,
    assumedPayoutRatio: config.assumedPayoutRatio,
    testSplit: 0,
    selectionMode: "SINGLE",
    regimeFilterMode: config.regimeFilterMode,
    strategies: [
      {
        strategy: createStrategy(kind),
        parameters: createStrategy(kind).validateParameters({
          ...DEFAULT_STRATEGY_PARAMETERS[kind],
          ...best.parameters
        })
      }
    ]
  });
  const fullTrain = await fullTrainBacktester.run(trainCandles);

  return {
    strategyId: strategy.strategy.id,
    strategyKind: kind,
    selectedParameters: best.parameters as Record<string, number | boolean | string>,
    trainSummary: fullTrain.summary,
    allCandidates: results,
    stabilityScore: best.stabilityScore
  };
}

function inferKind(strategy: BacktestStrategyInput): StrategyKind {
  const id = strategy.strategy.id;
  const kinds: StrategyKind[] = [
    "breakout-momentum",
    "ema-pullback",
    "bollinger-reversion",
    "squeeze-breakout"
  ];
  for (const k of kinds) {
    if (id.includes(k)) return k;
  }
  return "ema-pullback";
}

function emptySummary(): BacktestSummary {
  return {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    pushTrades: 0,
    winRate: 0,
    grossProfit: 0,
    grossLoss: 0,
    netProfit: 0,
    averageWin: 0,
    averageLoss: 0,
    expectancy: 0,
    profitFactor: null,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    longestWinStreak: 0,
    longestLossStreak: 0,
    averageHoldingMs: 0,
    endingBalance: 0,
    returnPercent: 0,
    rejectedSignalCount: 0,
    noTradeCount: 0
  };
}

/** Apply frozen per-strategy parameters to strategy inputs. */
export function applyFrozenParameters(
  strategies: BacktestStrategyInput[],
  frozen: Record<string, Record<string, number | boolean | string>>
): BacktestStrategyInput[] {
  return strategies.map((s) => ({
    strategy: s.strategy,
    parameters: frozen[s.strategy.id] ?? s.parameters
  }));
}

/** Compare parameter sets across windows — fraction of keys stable across windows. */
export function parameterStabilityAcrossWindows(
  windowParams: ReadonlyArray<Record<string, number | boolean | string>>,
  parameterSpace: ParameterSpace
): { score: number; level: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN"; varianceNotes: string[] } {
  if (windowParams.length < 2) {
    return { score: 0.5, level: "UNKNOWN", varianceNotes: ["Fewer than 2 windows for cross-window stability"] };
  }

  const keys = Object.keys(parameterSpace);
  let stableKeys = 0;
  const varianceNotes: string[] = [];

  for (const key of keys) {
    const values = windowParams.map((p) => p[key]).filter((v) => v !== undefined);
    const unique = new Set(values.map(String));
    if (unique.size === 1) {
      stableKeys++;
    } else {
      varianceNotes.push(`${key} varied across windows: ${[...unique].join(", ")}`);
    }
  }

  const score = keys.length > 0 ? stableKeys / keys.length : 0.5;
  return {
    score,
    level: score >= 0.7 ? "HIGH" : score >= 0.4 ? "MEDIUM" : "LOW",
    varianceNotes
  };
}
