import {
  type Candle,
  type InstrumentMetadata
} from "@regimex/shared";
import { CfdBacktester, type CfdBacktestStrategyInput } from "../backtest/cfdBacktester.js";
import {
  computeCfdSummary,
  type CfdBacktestSummary,
  type CfdSimulatedTrade
} from "../backtest/cfdMetrics.js";
import { type ParameterSpace } from "../optimize/gridSearch.js";
import { type WalkForwardConfig, type WalkForwardWindow } from "../optimize/walkForward.js";
import { computeStrategyConfigHash } from "../selection/strategyVersioning.js";
import {
  assertHoldoutNotUsedForOptimization,
  assertOptimizerDisjointFromTest,
  assertParametersFrozenBeforeTest
} from "./leakageGuards.js";
import {
  assertWindowWithinDevelopment,
  generateDevelopmentWalkForwardWindows,
  splitHoldout,
  type HoldoutSplit
} from "./holdoutSplit.js";
import {
  applyFrozenCfdParameters,
  optimizeOnCfdTrainWindow
} from "./cfdWindowOptimizer.js";
import { parameterStabilityAcrossWindows } from "./windowOptimizer.js";
import {
  runCfdBaselines,
  type CfdBaselineComparisonResult,
  type CfdBaselineOpportunity
} from "./cfdBaselines.js";
import {
  aggregateCfdWalkForwardWindows,
  type CfdWalkForwardAggregate
} from "./cfdWalkForwardAggregates.js";

export interface CfdWalkForwardServiceConfig {
  instrument: InstrumentMetadata;
  startingBalance: number;
  riskPerTradePercent: number;
  maxHoldBars: number;
  minRiskRewardRatio: number;
  holdoutPercent: number;
  walkForward: WalkForwardConfig;
  strategies: CfdBacktestStrategyInput[];
  optimizePerWindow?: boolean;
  parameterSpaces?: Record<string, ParameterSpace>;
  internalValidationSplit?: number;
  minTradesPerWindow?: number;
  randomBaselineSimulations?: number;
  experimentSeed?: number;
}

export interface CfdWalkForwardWindowResult {
  windowIndex: number;
  window: WalkForwardWindow;
  trainSummary: CfdBacktestSummary;
  validationSummary: CfdBacktestSummary;
  frozenParameters: Record<string, Record<string, number | boolean | string>>;
  configHashes: Record<string, string>;
  trainToValidationDegradationPercent: number | null;
  baselines: CfdBaselineComparisonResult | null;
  parameterStabilityScore: number | null;
  validationTrades: CfdSimulatedTrade[];
}

export interface CfdWalkForwardRunResult {
  holdoutSplit: HoldoutSplit;
  windows: CfdWalkForwardWindowResult[];
  walkForwardValidationTrades: CfdSimulatedTrade[];
  aggregate: CfdWalkForwardAggregate;
  holdoutSummary: CfdBacktestSummary | null;
  holdoutTrades: CfdSimulatedTrade[];
  /** Last frozen params used for final holdout (never optimized on holdout). */
  finalFrozenParameters: Record<string, Record<string, number | boolean | string>>;
  parameterStability: ReturnType<typeof parameterStabilityAcrossWindows>;
}

/**
 * Multi-window CFD walk-forward:
 * development windows (train → optional offline opt → frozen validation)
 * then final untouched holdout with last frozen config.
 */
export class CfdWalkForwardService {
  constructor(private readonly config: CfdWalkForwardServiceConfig) {}

  async run(allCandles: ReadonlyArray<Candle>): Promise<CfdWalkForwardRunResult> {
    const split = splitHoldout(allCandles, this.config.holdoutPercent);
    const wfWindows = generateDevelopmentWalkForwardWindows(
      split.development.length,
      this.config.walkForward
    );

    const windowResults: CfdWalkForwardWindowResult[] = [];
    const walkForwardValidationTrades: CfdSimulatedTrade[] = [];
    const windowParamSets: Record<string, number | boolean | string>[] = [];
    let lastFrozen = this.freezeParametersFromConfig();

    for (let idx = 0; idx < wfWindows.length; idx++) {
      const window = wfWindows[idx]!;
      assertWindowWithinDevelopment(window, split.development.length, split.holdoutStartIndex);

      const trainCandles = split.development.slice(window.trainStart, window.trainEnd);
      const testCandles = split.development.slice(window.testStart, window.testEnd);

      assertOptimizerDisjointFromTest(trainCandles, testCandles);
      assertHoldoutNotUsedForOptimization(trainCandles, split.holdout);

      let frozenParameters = lastFrozen;
      let neighborhoodStability: number | null = null;

      if (this.config.optimizePerWindow && this.config.parameterSpaces) {
        frozenParameters = { ...lastFrozen };
        for (const strategy of this.config.strategies) {
          const space = this.config.parameterSpaces[strategy.strategy.id];
          if (!space) continue;
          const optimized = await optimizeOnCfdTrainWindow(trainCandles, strategy, space, {
            startingBalance: this.config.startingBalance,
            riskPerTradePercent: this.config.riskPerTradePercent,
            maxHoldBars: this.config.maxHoldBars,
            minRiskRewardRatio: this.config.minRiskRewardRatio,
            instrument: this.config.instrument,
            internalValidationSplit: this.config.internalValidationSplit ?? 0.2
          });
          frozenParameters[strategy.strategy.id] = optimized.selectedParameters;
          neighborhoodStability = optimized.stabilityScore;
        }
        lastFrozen = frozenParameters;
      }

      assertParametersFrozenBeforeTest(true);

      const frozenStrategies = applyFrozenCfdParameters(this.config.strategies, frozenParameters);

      const trainRun = await new CfdBacktester({
        startingBalance: this.config.startingBalance,
        riskPerTradePercent: this.config.riskPerTradePercent,
        minRiskRewardRatio: this.config.minRiskRewardRatio,
        maxHoldBars: this.config.maxHoldBars,
        instrument: this.config.instrument,
        testSplit: 0,
        strategies: frozenStrategies
      }).run(trainCandles);

      const validationRun = await new CfdBacktester({
        startingBalance: this.config.startingBalance,
        riskPerTradePercent: this.config.riskPerTradePercent,
        minRiskRewardRatio: this.config.minRiskRewardRatio,
        maxHoldBars: this.config.maxHoldBars,
        instrument: this.config.instrument,
        testSplit: 0,
        strategies: frozenStrategies
      }).run(testCandles);

      const minTrades = this.config.minTradesPerWindow ?? 0;
      if (minTrades > 0 && validationRun.summary.totalTrades < minTrades) {
        // Still record the window — aggregates and verdicts account for thin samples.
      }

      const primaryStrategy = frozenStrategies[0]!;
      windowParamSets.push(frozenParameters[primaryStrategy.strategy.id] ?? primaryStrategy.parameters);

      const deg =
        trainRun.summary.expectancyR > 0
          ? Number(
              (
                (1 - validationRun.summary.expectancyR / trainRun.summary.expectancyR) *
                100
              ).toFixed(2)
            )
          : null;

      const baselines = this.runWindowBaselines(testCandles);

      const configHashes: Record<string, string> = {};
      for (const s of frozenStrategies) {
        configHashes[s.strategy.id] = computeStrategyConfigHash({
          strategyId: s.strategy.id,
          strategyVersion: s.strategy.version,
          parameters: s.parameters,
          executionModel: "cfd_v1"
        });
      }

      walkForwardValidationTrades.push(...validationRun.trades);
      windowResults.push({
        windowIndex: idx,
        window,
        trainSummary: trainRun.summary,
        validationSummary: validationRun.summary,
        frozenParameters,
        configHashes,
        trainToValidationDegradationPercent: deg,
        baselines,
        parameterStabilityScore: neighborhoodStability,
        validationTrades: validationRun.trades
      });
    }

    const aggregate = aggregateCfdWalkForwardWindows(
      windowResults.map((w) => ({
        windowIndex: w.windowIndex,
        validation: w.validationSummary,
        train: w.trainSummary,
        validationNetRSum: w.validationTrades.reduce((a, t) => a + (t.netR ?? 0), 0)
      }))
    );

    let holdoutSummary: CfdBacktestSummary | null = null;
    let holdoutTrades: CfdSimulatedTrade[] = [];
    if (split.holdout.length > 0) {
      assertHoldoutNotUsedForOptimization(
        split.development.slice(0, Math.min(10, split.development.length)),
        split.holdout
      );
      const holdoutRun = await new CfdBacktester({
        startingBalance: this.config.startingBalance,
        riskPerTradePercent: this.config.riskPerTradePercent,
        minRiskRewardRatio: this.config.minRiskRewardRatio,
        maxHoldBars: this.config.maxHoldBars,
        instrument: this.config.instrument,
        testSplit: 0,
        strategies: applyFrozenCfdParameters(this.config.strategies, lastFrozen)
      }).run(split.holdout);
      holdoutSummary = holdoutRun.summary;
      holdoutTrades = holdoutRun.trades;
    }

    const primarySpace =
      this.config.parameterSpaces?.[this.config.strategies[0]?.strategy.id ?? ""] ?? {};
    const parameterStability = parameterStabilityAcrossWindows(windowParamSets, primarySpace);

    return {
      holdoutSplit: split,
      windows: windowResults,
      walkForwardValidationTrades,
      aggregate,
      holdoutSummary,
      holdoutTrades,
      finalFrozenParameters: lastFrozen,
      parameterStability
    };
  }

  private freezeParametersFromConfig(): Record<
    string,
    Record<string, number | boolean | string>
  > {
    const frozen: Record<string, Record<string, number | boolean | string>> = {};
    for (const s of this.config.strategies) {
      frozen[s.strategy.id] = { ...s.parameters };
    }
    return frozen;
  }

  private runWindowBaselines(candles: ReadonlyArray<Candle>): CfdBaselineComparisonResult | null {
    if (candles.length < 40) return null;
    const opportunities: CfdBaselineOpportunity[] = [];
    for (let i = 20; i < candles.length - this.config.maxHoldBars; i += 10) {
      const c = candles[i]!;
      opportunities.push({
        candleIndex: i,
        entryTime: c.closeTime,
        quoteMid: c.close,
        stopDistance: Math.max(c.close * 0.002, this.config.instrument.tickSize * 10)
      });
    }
    if (opportunities.length === 0) return null;
    return runCfdBaselines(opportunities, candles, {
      startingBalance: this.config.startingBalance,
      riskPerTradePercent: this.config.riskPerTradePercent,
      instrument: this.config.instrument,
      maxHoldBars: this.config.maxHoldBars,
      targetRMultiple: 2,
      randomSimulations: this.config.randomBaselineSimulations ?? 20,
      randomSeed: (this.config.experimentSeed ?? 1) + candles.length,
      spreadBps: this.config.instrument.spreadBps,
      slippageBps: this.config.instrument.slippageBps
    });
  }
}

/** Combined WF validation summary from aggregated trades. */
export function summarizeCfdWalkForwardValidation(
  trades: ReadonlyArray<CfdSimulatedTrade>,
  startingBalance: number
): CfdBacktestSummary {
  return computeCfdSummary(trades, startingBalance).summary;
}
