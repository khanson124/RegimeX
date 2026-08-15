import { type Candle, type StrategyKind, type TradeCandidateOrigin } from "@regimex/shared";
import {
  Backtester,
  type BacktestConfig,
  type BacktestRunResult,
  type BacktestStrategyInput
} from "../backtest/backtester.js";
import { type BacktestSummary, type SimulatedTrade } from "../backtest/metrics.js";
import { type ParameterSpace } from "../optimize/gridSearch.js";
import { type WalkForwardConfig } from "../optimize/walkForward.js";
import { REGIME_CLASSIFIER_VERSION } from "../regime/classifier.js";
import {
  buildBaselineComparison,
  runDirectionBaselines,
  runRandomBaseline,
  type BaselineComparisonResult,
  type BaselineConfig,
  type BaselineOpportunity
} from "./baselines.js";
import { analyzePerformanceDegradation, type DegradationAnalysisResult } from "./degradationAnalysis.js";
import { splitHoldout, type HoldoutSplit } from "./holdoutSplit.js";
import { parameterSpaceForStrategy } from "./parameterSpaces.js";
import { computeResearchConfidence } from "./researchConfidence.js";
import { computeResearchVerdict, type ResearchVerdictResult } from "./researchVerdict.js";
import {
  WalkForwardService,
  summarizeWalkForwardTests,
  type WalkForwardRunResult,
  type WalkForwardServiceConfig
} from "./walkForwardService.js";
import { parameterStabilityAcrossWindows } from "./windowOptimizer.js";
import { type BacktestCandidateEvent } from "./tradeCandidate.js";

export interface ExperimentReproducibility {
  symbol: string;
  interval: string;
  from: string;
  to: string;
  holdoutPercent: number;
  walkForward: WalkForwardConfig;
  strategyIds: string[];
  strategyKinds: StrategyKind[];
  regimeClassifierVersion: string;
  parameterSpaces: Record<string, ParameterSpace>;
  randomBaselineSeed: number;
  randomBaselineSimulations: number;
  experimentSeed: number;
  selectionMode: BacktestConfig["selectionMode"];
  startingBalance: number;
  stakeAmount: number;
  contractDurationCandles: number;
  assumedPayoutRatio: number;
}

export interface ResearchExperimentOptions {
  candles: ReadonlyArray<Candle>;
  strategies: BacktestStrategyInput[];
  holdoutPercent: number;
  walkForward: WalkForwardConfig;
  backtest: Omit<BacktestConfig, "testSplit">;
  experimentSeed: number;
  parameterSpaces?: Record<string, ParameterSpace>;
  randomBaselineSimulations?: number;
  onCandidate?: (event: BacktestCandidateEvent) => void;
  candidateOrigin?: TradeCandidateOrigin;
}

export interface ResearchExperimentResult {
  holdoutSplit: HoldoutSplit;
  walkForward: WalkForwardRunResult;
  walkForwardSummary: BacktestSummary;
  holdoutSummary: BacktestSummary | null;
  trainAggregateSummary: BacktestSummary;
  baselines: BaselineComparisonResult;
  degradation: DegradationAnalysisResult;
  verdict: ResearchVerdictResult;
  confidence: ReturnType<typeof computeResearchConfidence>;
  parameterStability: ReturnType<typeof parameterStabilityAcrossWindows>;
  reproducibility: ExperimentReproducibility;
  baselineOpportunities: BaselineOpportunity[];
}

function tradesToOpportunities(
  trades: ReadonlyArray<SimulatedTrade>,
  candles: ReadonlyArray<Candle>,
  stake: number
): BaselineOpportunity[] {
  return trades.map((t) => {
    const idx = candles.findIndex((c) => c.closeTime === t.entryTime);
    return {
      candleIndex: idx >= 0 ? idx : 0,
      entryPrice: t.entryPrice,
      entryTime: t.entryTime,
      stake
    };
  });
}

export async function runResearchExperiment(
  opts: ResearchExperimentOptions
): Promise<ResearchExperimentResult> {
  const parameterSpaces: Record<string, ParameterSpace> = {};
  for (const s of opts.strategies) {
    parameterSpaces[s.strategy.id] = parameterSpaceForStrategy(
      s.strategy.kind,
      opts.parameterSpaces?.[s.strategy.id]
    );
  }

  const wfService = new WalkForwardService({
    holdoutPercent: opts.holdoutPercent,
    walkForward: opts.walkForward,
    optimizePerWindow: true,
    internalValidationSplit: 0.2,
    parameterSpaces,
    backtest: {
      ...opts.backtest,
      candidateRecording: opts.onCandidate
        ? {
            enabled: true,
            origin: opts.candidateOrigin ?? "WALK_FORWARD_TEST",
            onCandidate: opts.onCandidate
          }
        : undefined
    }
  });

  const wfResult = await wfService.run(opts.candles);
  const startingBalance = opts.backtest.startingBalance;
  const wfSummary = summarizeWalkForwardTests(wfResult.walkForwardTestTrades, startingBalance);
  const holdoutSummary = wfResult.holdout?.summary ?? null;

  const trainSummaries = wfResult.windows.map((w) => w.train.summary);
  const trainAggregateSummary = averageSummaries(trainSummaries, startingBalance);

  const windowParamSets = wfResult.windows.map((w) =>
    Object.values(w.frozenParameters)[0] ?? {}
  );
  const primarySpace = parameterSpaces[opts.strategies[0]!.strategy.id] ?? {};
  const parameterStability = parameterStabilityAcrossWindows(windowParamSets, primarySpace);

  const split = wfResult.holdoutSplit;
  const evalCandles = [...split.development.slice(wfResult.windows[0]?.window.testStart ?? 0), ...split.holdout];
  const opportunities = tradesToOpportunities(
    wfResult.walkForwardTestTrades,
    opts.candles,
    opts.backtest.stakeAmount
  );

  const baselineConfig: BaselineConfig = {
    startingBalance,
    assumedPayoutRatio: opts.backtest.assumedPayoutRatio,
    contractDurationCandles: opts.backtest.contractDurationCandles,
    randomSimulations: opts.randomBaselineSimulations ?? 100,
    randomSeed: opts.experimentSeed
  };

  const { alwaysCall, alwaysPut } = runDirectionBaselines(opportunities, opts.candles, baselineConfig);
  const random = runRandomBaseline(opportunities, opts.candles, baselineConfig);

  const noRegimeBacktester = new Backtester({
    ...opts.backtest,
    testSplit: 0,
    regimeFilterMode: "DISABLED",
    selectionMode: "SINGLE",
    strategies: opts.strategies.slice(0, 1)
  });
  const noRegimeResult = await noRegimeBacktester.run(evalCandles);

  const baselines = buildBaselineComparison({
    regimeX: wfSummary,
    noRegimeFilter: noRegimeResult.summary,
    alwaysCall,
    alwaysPut,
    random
  });

  const degradation = analyzePerformanceDegradation({
    train: trainAggregateSummary,
    walkForward: wfSummary,
    holdout: holdoutSummary,
    demoForward: null
  });

  const profitableWindows = wfResult.windows.filter((w) => w.test.summary.netProfit > 0).length;
  const confidence = computeResearchConfidence({
    totalTrades: wfSummary.totalTrades,
    oosTrades: wfSummary.totalTrades,
    profitFactor: wfSummary.profitFactor,
    expectancy: wfSummary.expectancy,
    maxDrawdownPercent: wfSummary.maxDrawdownPercent * 100,
    walkForwardProfitableWindows: profitableWindows,
    walkForwardTotalWindows: wfResult.windows.length,
    parameterStabilityScore: parameterStability.score,
    inSamplePf: trainAggregateSummary.profitFactor,
    oosPf: wfSummary.profitFactor,
    segmentIsOos: true
  });

  const verdict = computeResearchVerdict({
    confidenceScore: confidence.score,
    confidenceStatus: confidence.evaluationStatus,
    walkForward: wfSummary,
    holdout: holdoutSummary,
    demoForward: null,
    walkForwardProfitableWindows: profitableWindows,
    walkForwardTotalWindows: wfResult.windows.length,
    parameterStabilityLevel: parameterStability.level,
    parameterStabilityScore: parameterStability.score,
    baselines,
    degradation
  });

  const reproducibility: ExperimentReproducibility = {
    symbol: opts.candles[0]?.symbol ?? "",
    interval: opts.candles[0]?.interval ?? "5m",
    from: new Date(opts.candles[0]?.openTime ?? 0).toISOString(),
    to: new Date(opts.candles[opts.candles.length - 1]?.closeTime ?? 0).toISOString(),
    holdoutPercent: opts.holdoutPercent,
    walkForward: opts.walkForward,
    strategyIds: opts.strategies.map((s) => s.strategy.id),
    strategyKinds: opts.strategies.map((s) => s.strategy.kind),
    regimeClassifierVersion: REGIME_CLASSIFIER_VERSION,
    parameterSpaces,
    randomBaselineSeed: opts.experimentSeed,
    randomBaselineSimulations: baselineConfig.randomSimulations,
    experimentSeed: opts.experimentSeed,
    selectionMode: opts.backtest.selectionMode,
    startingBalance,
    stakeAmount: opts.backtest.stakeAmount,
    contractDurationCandles: opts.backtest.contractDurationCandles,
    assumedPayoutRatio: opts.backtest.assumedPayoutRatio
  };

  return {
    holdoutSplit: split,
    walkForward: wfResult,
    walkForwardSummary: wfSummary,
    holdoutSummary,
    trainAggregateSummary,
    baselines,
    degradation,
    verdict,
    confidence,
    parameterStability,
    reproducibility,
    baselineOpportunities: opportunities
  };
}

function averageSummaries(summaries: BacktestSummary[], startingBalance: number): BacktestSummary {
  if (summaries.length === 0) {
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
      endingBalance: startingBalance,
      returnPercent: 0,
      rejectedSignalCount: 0,
      noTradeCount: 0
    };
  }
  const netProfit = summaries.reduce((a, s) => a + s.netProfit, 0) / summaries.length;
  const pfs = summaries.map((s) => s.profitFactor).filter((p): p is number => p !== null);
  const profitFactor = pfs.length > 0 ? pfs.reduce((a, b) => a + b, 0) / pfs.length : null;
  const totalTrades = Math.round(summaries.reduce((a, s) => a + s.totalTrades, 0) / summaries.length);
  return {
    ...summaries[summaries.length - 1]!,
    netProfit,
    profitFactor,
    totalTrades,
    expectancy: summaries.reduce((a, s) => a + s.expectancy, 0) / summaries.length,
    maxDrawdownPercent: Math.max(...summaries.map((s) => s.maxDrawdownPercent))
  };
}

export type { WalkForwardServiceConfig, WalkForwardRunResult };
