import { type Candle } from "@regimex/shared";
import { Backtester, type BacktestConfig, type BacktestRunResult } from "../backtest/backtester.js";
import { computeSummary, type BacktestSummary, type SimulatedTrade } from "../backtest/metrics.js";
import { type ParameterSpace } from "../optimize/gridSearch.js";
import { type WalkForwardConfig, type WalkForwardWindow } from "../optimize/walkForward.js";
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
  applyFrozenParameters,
  optimizeOnTrainWindow,
  parameterStabilityAcrossWindows
} from "./windowOptimizer.js";

export interface WalkForwardServiceConfig {
  backtest: Omit<BacktestConfig, "testSplit">;
  holdoutPercent: number;
  walkForward: WalkForwardConfig;
  optimizePerWindow?: boolean;
  parameterSpaces?: Record<string, ParameterSpace>;
  internalValidationSplit?: number;
}

export interface WalkForwardWindowResult {
  windowIndex: number;
  window: WalkForwardWindow;
  train: BacktestRunResult;
  test: BacktestRunResult;
  frozenParameters: Record<string, Record<string, number | boolean | string>>;
  trainOptimizedSummary?: BacktestSummary;
}

export interface WalkForwardRunResult {
  holdoutSplit: HoldoutSplit;
  windows: WalkForwardWindowResult[];
  walkForwardTestTrades: SimulatedTrade[];
  holdout: BacktestRunResult | null;
  parameterStability: ReturnType<typeof parameterStabilityAcrossWindows>;
}

/**
 * Nested walk-forward with optional per-window optimization on train data only.
 */
export class WalkForwardService {
  constructor(private readonly config: WalkForwardServiceConfig) {}

  async run(allCandles: ReadonlyArray<Candle>): Promise<WalkForwardRunResult> {
    const split = splitHoldout(allCandles, this.config.holdoutPercent);
    const wfWindows = generateDevelopmentWalkForwardWindows(
      split.development.length,
      this.config.walkForward
    );

    const windowResults: WalkForwardWindowResult[] = [];
    const walkForwardTestTrades: SimulatedTrade[] = [];
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
      let trainOptimizedSummary: BacktestSummary | undefined;

      if (this.config.optimizePerWindow && this.config.parameterSpaces) {
        frozenParameters = { ...lastFrozen };
        for (const strategy of this.config.backtest.strategies) {
          const space = this.config.parameterSpaces[strategy.strategy.id];
          if (!space) continue;
          const optimized = await optimizeOnTrainWindow(trainCandles, strategy, space, {
            startingBalance: this.config.backtest.startingBalance,
            stakeAmount: this.config.backtest.stakeAmount,
            contractDurationCandles: this.config.backtest.contractDurationCandles,
            assumedPayoutRatio: this.config.backtest.assumedPayoutRatio,
            selectionMode: this.config.backtest.selectionMode,
            regimeFilterMode: this.config.backtest.regimeFilterMode ?? "ENABLED",
            internalValidationSplit: this.config.internalValidationSplit ?? 0.2,
            strategies: this.config.backtest.strategies
          });
          frozenParameters[strategy.strategy.id] = optimized.selectedParameters;
          trainOptimizedSummary = optimized.trainSummary;
        }
      }

      assertParametersFrozenBeforeTest(true);

      const train = await this.runSegment(trainCandles, 0, frozenParameters, "BACKTEST");
      const test = await this.runSegment(testCandles, 0, frozenParameters, "WALK_FORWARD_TEST");

      walkForwardTestTrades.push(...test.trades);
      windowParamSets.push(Object.values(frozenParameters)[0] ?? {});
      lastFrozen = frozenParameters;

      windowResults.push({
        windowIndex: idx,
        window,
        train: trainOptimizedSummary ? { ...train, summary: trainOptimizedSummary } : train,
        test,
        frozenParameters,
        trainOptimizedSummary
      });
    }

    let holdout: BacktestRunResult | null = null;
    if (split.holdout.length > 0) {
      assertHoldoutNotUsedForOptimization(split.development, split.holdout);
      holdout = await this.runSegment(split.holdout, 0, lastFrozen, "FINAL_HOLDOUT");
    }

    const primarySpace =
      this.config.parameterSpaces?.[this.config.backtest.strategies[0]?.strategy.id ?? ""] ?? {};
    const parameterStability = parameterStabilityAcrossWindows(windowParamSets, primarySpace);

    return { holdoutSplit: split, windows: windowResults, walkForwardTestTrades, holdout, parameterStability };
  }

  private freezeParametersFromConfig(): Record<string, Record<string, number | boolean | string>> {
    const map: Record<string, Record<string, number | boolean | string>> = {};
    for (const s of this.config.backtest.strategies) {
      map[s.strategy.id] = { ...s.parameters };
    }
    return map;
  }

  private async runSegment(
    candles: ReadonlyArray<Candle>,
    testSplit: number,
    frozen: Record<string, Record<string, number | boolean | string>>,
    origin: "BACKTEST" | "WALK_FORWARD_TEST" | "FINAL_HOLDOUT"
  ): Promise<BacktestRunResult> {
    const strategies = applyFrozenParameters(this.config.backtest.strategies, frozen);
    const backtester = new Backtester({
      ...this.config.backtest,
      strategies,
      testSplit,
      candidateRecording: this.config.backtest.candidateRecording
        ? { ...this.config.backtest.candidateRecording, origin }
        : undefined
    });
    return backtester.run(candles);
  }
}

export function summarizeWalkForwardTests(
  trades: ReadonlyArray<SimulatedTrade>,
  startingBalance: number
): ReturnType<typeof computeSummary>["summary"] {
  return computeSummary(trades, startingBalance).summary;
}

export { applyFrozenParameters } from "./windowOptimizer.js";
