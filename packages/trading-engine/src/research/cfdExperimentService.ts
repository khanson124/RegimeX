import {
  type Candle,
  type InstrumentMetadata,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS,
  type ResearchSampleRequirements
} from "@regimex/shared";
import { type CfdBacktestStrategyInput } from "../backtest/cfdBacktester.js";
import { computeCfdSummary, type CfdBacktestSummary } from "../backtest/cfdMetrics.js";
import { type BacktestSummary } from "../backtest/metrics.js";
import { type WalkForwardConfig } from "../optimize/walkForward.js";
import { type ParameterSpace } from "../optimize/gridSearch.js";
import { computeResearchConfidence } from "./researchConfidence.js";
import { analyzePerformanceDegradation } from "./degradationAnalysis.js";
import {
  runCfdBaselines,
  type CfdBaselineComparisonResult,
  type CfdBaselineOpportunity
} from "./cfdBaselines.js";
import {
  CfdWalkForwardService,
  summarizeCfdWalkForwardValidation,
  type CfdWalkForwardRunResult,
  type CfdWalkForwardWindowResult
} from "./cfdWalkForwardService.js";
import {
  computeCfdResearchVerdict,
  strategyOutperformsCfdBaselines,
  type CfdResearchVerdictResult
} from "./cfdResearchVerdict.js";
import {
  computePromotionEligibility,
  type PromotionEligibilityResult
} from "./cfdPromotion.js";
import { parameterSpaceForStrategy } from "./parameterSpaces.js";
import { type StrategyKind } from "@regimex/shared";

function asBinaryShapedSummary(s: CfdBacktestSummary): BacktestSummary {
  return {
    totalTrades: s.totalTrades,
    winningTrades: s.winningTrades,
    losingTrades: s.losingTrades,
    pushTrades: s.pushTrades,
    winRate: s.winRate,
    grossProfit: s.grossProfit,
    grossLoss: s.grossLoss,
    profitFactor: s.profitFactor,
    expectancy: s.expectancyR,
    averageWin: s.averageWin,
    averageLoss: s.averageLoss,
    netProfit: s.netProfit,
    returnPercent: s.returnPercent,
    maxDrawdown: s.maxDrawdown,
    maxDrawdownPercent: s.maxDrawdownPercent,
    longestWinStreak: s.longestWinStreak,
    longestLossStreak: s.longestLossStreak,
    averageHoldingMs: s.averageHoldingMs,
    endingBalance: s.endingBalance,
    rejectedSignalCount: s.rejectedSignalCount,
    noTradeCount: s.noTradeCount
  };
}

export interface CfdResearchExperimentInput {
  candles: ReadonlyArray<Candle>;
  strategies: CfdBacktestStrategyInput[];
  instrument: InstrumentMetadata;
  holdoutPercent: number;
  startingBalance: number;
  riskPerTradePercent: number;
  maxHoldBars: number;
  minRiskRewardRatio?: number;
  experimentSeed: number;
  sampleRequirements?: ResearchSampleRequirements;
  randomBaselineSimulations?: number;
  walkForward?: WalkForwardConfig;
  /** Offline per-window optimization — never mutates live strategies. */
  optimizePerWindow?: boolean;
  parameterSpaces?: Record<string, ParameterSpace>;
  /** Optional forward-paper summary (kept separate from historical OOS). */
  forwardPaperSummary?: CfdBacktestSummary | null;
  forwardPaperTradeCount?: number;
}

export interface CfdResearchExperimentResult {
  executionModel: "cfd_v1";
  developmentSummary: CfdBacktestSummary;
  holdoutSummary: CfdBacktestSummary;
  walkForwardSummary: CfdBacktestSummary;
  trainSummary: CfdBacktestSummary;
  windows: CfdWalkForwardWindowResult[];
  walkForward: CfdWalkForwardRunResult;
  baselines: CfdBaselineComparisonResult;
  verdict: CfdResearchVerdictResult;
  confidence: ReturnType<typeof computeResearchConfidence>;
  degradation: ReturnType<typeof analyzePerformanceDegradation>;
  promotion: PromotionEligibilityResult;
  parameterStability: CfdWalkForwardRunResult["parameterStability"];
  historicalEvidence: CfdResearchVerdictResult["historicalEvidence"];
  forwardEvidence: CfdResearchVerdictResult["forwardEvidence"];
  developmentCandleCount: number;
  holdoutCandleCount: number;
  holdoutStartIndex: number;
  reproducibility: {
    experimentSeed: number;
    optimizePerWindow: boolean;
    walkForward: WalkForwardConfig;
    finalFrozenParameters: Record<string, Record<string, number | boolean | string>>;
  };
}

function inferKindFromId(id: string): StrategyKind {
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

/**
 * CFD research ladder (cfd_v1):
 * holdout split → multi-window walk-forward (optional offline opt) →
 * aggregate OOS → CFD baselines → confidence/verdict/degradation/promotion.
 * Never mutates live strategy parameters.
 */
export async function runCfdResearchExperiment(
  input: CfdResearchExperimentInput
): Promise<CfdResearchExperimentResult> {
  const req = input.sampleRequirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS;
  const walkForward: WalkForwardConfig = input.walkForward ?? {
    trainWindow: 2000,
    testWindow: 400,
    stepSize: 400,
    windowMode: "rolling"
  };

  const parameterSpaces =
    input.parameterSpaces ??
    Object.fromEntries(
      input.strategies.map((s) => [s.strategy.id, parameterSpaceForStrategy(inferKindFromId(s.strategy.id))])
    );

  const wfService = new CfdWalkForwardService({
    instrument: input.instrument,
    startingBalance: input.startingBalance,
    riskPerTradePercent: input.riskPerTradePercent,
    maxHoldBars: input.maxHoldBars,
    minRiskRewardRatio: input.minRiskRewardRatio ?? 1.5,
    holdoutPercent: input.holdoutPercent,
    walkForward,
    strategies: input.strategies,
    optimizePerWindow: input.optimizePerWindow ?? false,
    parameterSpaces: input.optimizePerWindow ? parameterSpaces : undefined,
    internalValidationSplit: 0.2,
    randomBaselineSimulations: input.randomBaselineSimulations ?? 30,
    experimentSeed: input.experimentSeed
  });

  const walkForwardRun = await wfService.run(input.candles);
  const wfSummary = summarizeCfdWalkForwardValidation(
    walkForwardRun.walkForwardValidationTrades,
    input.startingBalance
  );

  const trainTrades = walkForwardRun.windows.flatMap((w) => {
    // Reconstruct is not stored — use window train summaries only for aggregate train.
    return [] as const;
  });
  void trainTrades;

  const trainSummary =
    walkForwardRun.windows.length > 0
      ? combineSummaries(
          walkForwardRun.windows.map((w) => w.trainSummary),
          input.startingBalance
        )
      : wfSummary;

  const holdoutSummary =
    walkForwardRun.holdoutSummary ??
    computeCfdSummary([], input.startingBalance).summary;

  const developmentSummary = combineSummaries(
    [trainSummary, wfSummary],
    input.startingBalance
  );

  // Overall development baselines (not per-window) for experiment-level comparison
  const opportunities: CfdBaselineOpportunity[] = [];
  const development = walkForwardRun.holdoutSplit.development;
  for (let i = 80; i < development.length - input.maxHoldBars; i += 15) {
    const c = development[i]!;
    opportunities.push({
      candleIndex: i,
      entryTime: c.closeTime,
      quoteMid: c.close,
      stopDistance: Math.max(c.close * 0.002, input.instrument.tickSize * 10)
    });
  }
  const baselines = runCfdBaselines(opportunities, development, {
    startingBalance: input.startingBalance,
    riskPerTradePercent: input.riskPerTradePercent,
    instrument: input.instrument,
    maxHoldBars: input.maxHoldBars,
    targetRMultiple: 2,
    randomSimulations: input.randomBaselineSimulations ?? 50,
    randomSeed: input.experimentSeed,
    spreadBps: input.instrument.spreadBps,
    slippageBps: input.instrument.slippageBps
  });

  const outperforms = strategyOutperformsCfdBaselines(
    walkForwardRun.aggregate.weightedExpectancyR,
    baselines
  );

  const confidence = computeResearchConfidence({
    totalTrades: trainSummary.totalTrades + wfSummary.totalTrades,
    oosTrades: wfSummary.totalTrades + holdoutSummary.totalTrades,
    profitFactor: wfSummary.profitFactor,
    expectancy: wfSummary.expectancyR,
    maxDrawdownPercent: Math.max(
      wfSummary.maxDrawdownPercent,
      holdoutSummary.maxDrawdownPercent,
      walkForwardRun.aggregate.maxDrawdownPercent
    ),
    walkForwardProfitableWindows: Math.round(
      walkForwardRun.aggregate.percentProfitableWindows * walkForwardRun.aggregate.windowCount
    ),
    walkForwardTotalWindows: Math.max(walkForwardRun.aggregate.windowCount, 1),
    parameterStabilityScore: walkForwardRun.parameterStability.score,
    inSamplePf: trainSummary.profitFactor,
    oosPf: wfSummary.profitFactor,
    segmentIsOos: true,
    requirements: req
  });

  const degradation = analyzePerformanceDegradation({
    train: asBinaryShapedSummary(trainSummary),
    walkForward: asBinaryShapedSummary(wfSummary),
    holdout: asBinaryShapedSummary(holdoutSummary),
    demoForward: input.forwardPaperSummary
      ? asBinaryShapedSummary(input.forwardPaperSummary)
      : null
  });

  const verdict = computeCfdResearchVerdict({
    confidenceScore: confidence.score,
    confidenceStatus: confidence.evaluationStatus,
    aggregate: walkForwardRun.aggregate,
    walkForwardSummary: wfSummary,
    holdoutSummary,
    forwardSummary: input.forwardPaperSummary ?? null,
    parameterStabilityLevel: walkForwardRun.parameterStability.level,
    parameterStabilityScore: walkForwardRun.parameterStability.score,
    baselines,
    degradation,
    outperformsBaselines: outperforms,
    requirements: req
  });

  const promotion = computePromotionEligibility({
    verdict: verdict.verdict,
    aggregate: walkForwardRun.aggregate,
    holdoutExpectancyR: holdoutSummary.expectancyR,
    holdoutTrades: holdoutSummary.totalTrades,
    parameterStabilityLevel: walkForwardRun.parameterStability.level,
    parameterStabilityScore: walkForwardRun.parameterStability.score,
    forwardTradeCount: input.forwardPaperTradeCount ?? input.forwardPaperSummary?.totalTrades ?? 0,
    forwardExpectancyR: input.forwardPaperSummary?.expectancyR ?? null,
    forwardDegradation:
      input.forwardPaperSummary && walkForwardRun.aggregate.weightedExpectancyR > 0
        ? Math.max(
            0,
            1 -
              input.forwardPaperSummary.expectancyR /
                Math.max(walkForwardRun.aggregate.weightedExpectancyR, 0.01)
          )
        : null,
    outperformsBaselines: outperforms,
    requirements: req
  });

  return {
    executionModel: "cfd_v1",
    developmentSummary,
    holdoutSummary,
    walkForwardSummary: wfSummary,
    trainSummary,
    windows: walkForwardRun.windows,
    walkForward: walkForwardRun,
    baselines,
    verdict,
    confidence,
    degradation,
    promotion,
    parameterStability: walkForwardRun.parameterStability,
    historicalEvidence: verdict.historicalEvidence,
    forwardEvidence: verdict.forwardEvidence,
    developmentCandleCount: walkForwardRun.holdoutSplit.development.length,
    holdoutCandleCount: walkForwardRun.holdoutSplit.holdout.length,
    holdoutStartIndex: walkForwardRun.holdoutSplit.holdoutStartIndex,
    reproducibility: {
      experimentSeed: input.experimentSeed,
      optimizePerWindow: input.optimizePerWindow ?? false,
      walkForward,
      finalFrozenParameters: walkForwardRun.finalFrozenParameters
    }
  };
}

function combineSummaries(
  summaries: CfdBacktestSummary[],
  startingBalance: number
): CfdBacktestSummary {
  if (summaries.length === 0) return computeCfdSummary([], startingBalance).summary;
  // Approximate combine via weighted expectancy / summed trades (not reconstructing equity).
  const totalTrades = summaries.reduce((a, s) => a + s.totalTrades, 0);
  const netProfit = summaries.reduce((a, s) => a + s.netProfit, 0);
  const wins = summaries.reduce((a, s) => a + s.winningTrades, 0);
  const losses = summaries.reduce((a, s) => a + s.losingTrades, 0);
  const pushes = summaries.reduce((a, s) => a + s.pushTrades, 0);
  const grossProfit = summaries.reduce((a, s) => a + s.grossProfit, 0);
  const grossLoss = summaries.reduce((a, s) => a + s.grossLoss, 0);
  const er =
    totalTrades > 0
      ? summaries.reduce((a, s) => a + s.expectancyR * s.totalTrades, 0) / totalTrades
      : 0;
  const base = summaries[summaries.length - 1]!;
  return {
    ...base,
    totalTrades,
    winningTrades: wins,
    losingTrades: losses,
    pushTrades: pushes,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor: grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : null,
    expectancy: er,
    expectancyR: er,
    maxDrawdownPercent: Math.max(...summaries.map((s) => s.maxDrawdownPercent)),
    endingBalance: startingBalance + netProfit,
    returnPercent: startingBalance > 0 ? (netProfit / startingBalance) * 100 : 0
  };
}
