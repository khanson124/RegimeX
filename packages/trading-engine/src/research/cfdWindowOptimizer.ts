import { type Candle, type InstrumentMetadata, type StrategyKind } from "@regimex/shared";
import { CfdBacktester, type CfdBacktestStrategyInput } from "../backtest/cfdBacktester.js";
import { type CfdBacktestSummary } from "../backtest/cfdMetrics.js";
import {
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS
} from "../strategies/registry.js";
import {
  generateCombinations,
  type ParameterSpace
} from "../optimize/gridSearch.js";
import {
  DEFAULT_CFD_OBJECTIVE_CONFIG,
  scoreCfdObjective,
  type CfdObjectiveConfig
} from "./cfdObjective.js";
import { CFD_SIMULATOR_VERSION } from "@regimex/shared";

export interface CfdWindowOptimizerConfig {
  startingBalance: number;
  riskPerTradePercent: number;
  maxHoldBars: number;
  minRiskRewardRatio: number;
  instrument: InstrumentMetadata;
  /** Internal validation split within train window only. */
  internalValidationSplit: number;
  objective?: CfdObjectiveConfig;
}

export interface CfdCandidateResult {
  parameters: Record<string, number | boolean>;
  trainExpectancyR: number;
  trainProfitFactor: number | null;
  trainTrades: number;
  /** Internal-validation (still within train band — never the WF validation window). */
  validationExpectancyR: number;
  validationProfitFactor: number | null;
  validationTrades: number;
  maxDrawdownPercent: number;
  winRate: number;
  longestLossStreak: number;
  objectiveScore: number;
  neighborhoodStability: number;
  overfitWarning: boolean;
}

export interface CfdWindowOptimizationResult {
  strategyId: string;
  strategyKind: StrategyKind;
  selectedParameters: Record<string, number | boolean | string>;
  trainSummary: CfdBacktestSummary;
  allCandidates: CfdCandidateResult[];
  stabilityScore: number;
  objectiveComponents: Record<string, number>;
}

/**
 * Optimize parameters on TRAIN candles ONLY.
 * Leakage guard: never pass validation/holdout candles.
 * Selection uses robust CFD objective — not raw return.
 */
export async function optimizeOnCfdTrainWindow(
  trainCandles: ReadonlyArray<Candle>,
  strategy: CfdBacktestStrategyInput,
  parameterSpace: ParameterSpace,
  config: CfdWindowOptimizerConfig
): Promise<CfdWindowOptimizationResult> {
  if (trainCandles.length < 50) {
    throw new Error(`Train window too small for CFD optimization (${trainCandles.length} candles)`);
  }

  const kind = inferKind(strategy);
  const combos = generateCombinations(parameterSpace);
  const results: CfdCandidateResult[] = [];
  const objectiveConfig = config.objective ?? DEFAULT_CFD_OBJECTIVE_CONFIG;

  for (const combo of combos) {
    const s = createStrategy(kind);
    const parameters = s.validateParameters({
      ...DEFAULT_STRATEGY_PARAMETERS[kind],
      ...combo
    });

    const backtester = new CfdBacktester({
      startingBalance: config.startingBalance,
      riskPerTradePercent: config.riskPerTradePercent,
      minRiskRewardRatio: config.minRiskRewardRatio,
      maxHoldBars: config.maxHoldBars,
      instrument: config.instrument,
      testSplit: config.internalValidationSplit,
      strategies: [{ strategy: s, parameters }]
    });
    const result = await backtester.run(trainCandles);
    const train = result.validation?.train ?? result.summary;
    const internalVal = result.validation?.test ?? result.summary;

    const overfitWarning =
      train.expectancyR > 0 &&
      (internalVal.expectancyR <= 0 ||
        (train.profitFactor != null &&
          internalVal.profitFactor != null &&
          internalVal.profitFactor < train.profitFactor * 0.5));

    results.push({
      parameters: combo,
      trainExpectancyR: train.expectancyR,
      trainProfitFactor: train.profitFactor,
      trainTrades: train.totalTrades,
      validationExpectancyR: internalVal.expectancyR,
      validationProfitFactor: internalVal.profitFactor,
      validationTrades: internalVal.totalTrades,
      maxDrawdownPercent: result.summary.maxDrawdownPercent,
      winRate: internalVal.winRate,
      longestLossStreak: internalVal.longestLossStreak,
      objectiveScore: 0,
      neighborhoodStability: 0,
      overfitWarning
    });
  }

  // Neighborhood stability on validation expectancyR
  for (const c of results) {
    c.neighborhoodStability = neighborhoodStability(c, results);
    const scored = scoreCfdObjective(
      {
        expectancyR: c.validationExpectancyR,
        profitFactor: c.validationProfitFactor,
        trades: c.validationTrades,
        maxDrawdownPercent: c.maxDrawdownPercent,
        consistencyScore: c.neighborhoodStability,
        instabilityPenalty: c.overfitWarning ? 0.5 : 0,
        longestLossStreak: c.longestLossStreak,
        winRate: c.winRate
      },
      objectiveConfig
    );
    c.objectiveScore = scored.score;
  }

  results.sort((a, b) => b.objectiveScore - a.objectiveScore);
  const best = results[0];
  if (!best) {
    return {
      strategyId: strategy.strategy.id,
      strategyKind: kind,
      selectedParameters: { ...strategy.parameters },
      trainSummary: emptyCfdSummary(config.startingBalance),
      allCandidates: results,
      stabilityScore: 0,
      objectiveComponents: {}
    };
  }

  const fullTrain = await new CfdBacktester({
    startingBalance: config.startingBalance,
    riskPerTradePercent: config.riskPerTradePercent,
    minRiskRewardRatio: config.minRiskRewardRatio,
    maxHoldBars: config.maxHoldBars,
    instrument: config.instrument,
    testSplit: 0,
    strategies: [
      {
        strategy: createStrategy(kind),
        parameters: createStrategy(kind).validateParameters({
          ...DEFAULT_STRATEGY_PARAMETERS[kind],
          ...best.parameters
        })
      }
    ]
  }).run(trainCandles);

  const bestComponents = scoreCfdObjective(
    {
      expectancyR: best.validationExpectancyR,
      profitFactor: best.validationProfitFactor,
      trades: best.validationTrades,
      maxDrawdownPercent: best.maxDrawdownPercent,
      consistencyScore: best.neighborhoodStability,
      instabilityPenalty: best.overfitWarning ? 0.5 : 0,
      longestLossStreak: best.longestLossStreak,
      winRate: best.winRate
    },
    objectiveConfig
  ).components;

  return {
    strategyId: strategy.strategy.id,
    strategyKind: kind,
    selectedParameters: best.parameters as Record<string, number | boolean | string>,
    trainSummary: fullTrain.summary,
    allCandidates: results,
    stabilityScore: best.neighborhoodStability,
    objectiveComponents: bestComponents
  };
}

function neighborhoodStability(
  candidate: CfdCandidateResult,
  all: ReadonlyArray<CfdCandidateResult>
): number {
  const keys = Object.keys(candidate.parameters);
  const neighbors = all.filter((other) => {
    if (other === candidate) return false;
    let diffs = 0;
    for (const k of keys) {
      if (other.parameters[k] !== candidate.parameters[k]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  });
  if (neighbors.length === 0) return 0.5;
  const positive = neighbors.filter((n) => n.validationExpectancyR > 0).length;
  return positive / neighbors.length;
}

function inferKind(strategy: CfdBacktestStrategyInput): StrategyKind {
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

function emptyCfdSummary(startingBalance: number): CfdBacktestSummary {
  return {
    simulatorVersion: CFD_SIMULATOR_VERSION,
    rMetric: "netR",
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
    profitFactor: null,
    expectancy: 0,
    expectancyR: 0,
    averageR: null,
    averageGrossR: null,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    longestWinStreak: 0,
    longestLossStreak: 0,
    averageHoldingMs: 0,
    averageBarsHeld: 0,
    exposureBars: 0,
    endingBalance: startingBalance,
    returnPercent: 0,
    rejectedSignalCount: 0,
    noTradeCount: 0
  };
}

export function applyFrozenCfdParameters(
  strategies: CfdBacktestStrategyInput[],
  frozen: Record<string, Record<string, number | boolean | string>>
): CfdBacktestStrategyInput[] {
  return strategies.map((s) => ({
    strategy: s.strategy,
    parameters: frozen[s.strategy.id] ?? s.parameters
  }));
}
