import {
  type EvaluationStatus,
  type MetricSegment,
  type ResearchSampleRequirements,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
} from "@regimex/shared";
import { computeCfdSummary, type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { resolveRegimeEvaluationStatus } from "./evaluationStatus.js";
import { type CfdTradeEntryFeatureSnapshot } from "./cfdTradeEntrySnapshot.js";

export const EMA_PULLBACK_STRATEGY_ID = "ema-pullback-v1";
export const MEAN_REVERSION_STRATEGY_ID = "bollinger-reversion-v1";

export const CFD_STRATEGY_QUALITY_TARGETS = [
  EMA_PULLBACK_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_ID
] as const;

export type CfdQualitySegment = Extract<MetricSegment, "TRAIN" | "WALK_FORWARD" | "HOLDOUT">;

export interface QualityBucketMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  profitFactor: number | null;
  expectancyR: number;
  averageR: number | null;
  netProfit: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
}

export interface QualityFeatureBucket {
  dimension: string;
  band: string;
  action: "BUY" | "SELL" | "ALL";
  segment: CfdQualitySegment;
  metrics: QualityBucketMetrics;
  evaluationStatus: EvaluationStatus;
}

export interface SegmentQualityAnalysis {
  segment: CfdQualitySegment;
  tradesAnalyzed: number;
  tradesWithSnapshots: number;
  buckets: QualityFeatureBucket[];
}

export interface CrossSegmentDegradationFlag {
  strategyId: string;
  dimension: string;
  band: string;
  action: "BUY" | "SELL" | "ALL";
  trainExpectancyR: number;
  walkForwardExpectancyR: number | null;
  holdoutExpectancyR: number | null;
  message: string;
}

export interface StrategyQualityAnalysis {
  strategyId: string;
  segments: Record<CfdQualitySegment, SegmentQualityAnalysis>;
  degradationFlags: CrossSegmentDegradationFlag[];
}

export interface CfdStrategyQualityAnalysisResult {
  analysisVersion: 1;
  strategies: StrategyQualityAnalysis[];
  note: string;
}

type BandRule = {
  dimension: string;
  label: string;
  match: (snap: CfdTradeEntryFeatureSnapshot, trade: CfdSimulatedTrade) => boolean;
};

function bandBetween(value: number | null, min: number, max: number): boolean {
  return value !== null && value >= min && value < max;
}

function emaPullbackBandRules(): BandRule[] {
  return [
    { dimension: "action", label: "BUY", match: (_s, t) => t.action === "BUY" },
    { dimension: "action", label: "SELL", match: (_s, t) => t.action === "SELL" },
    {
      dimension: "regimeConfidence",
      label: "0.00-0.50",
      match: (s) => bandBetween(s.regimeConfidence, 0, 0.5)
    },
    {
      dimension: "regimeConfidence",
      label: "0.50-0.65",
      match: (s) => bandBetween(s.regimeConfidence, 0.5, 0.65)
    },
    {
      dimension: "regimeConfidence",
      label: "0.65-0.80",
      match: (s) => bandBetween(s.regimeConfidence, 0.65, 0.8)
    },
    {
      dimension: "regimeConfidence",
      label: "0.80-1.00",
      match: (s) => bandBetween(s.regimeConfidence, 0.8, 1.01)
    },
    { dimension: "adx", label: "0-20", match: (s) => bandBetween(s.adx, 0, 20) },
    { dimension: "adx", label: "20-25", match: (s) => bandBetween(s.adx, 20, 25) },
    { dimension: "adx", label: "25-35", match: (s) => bandBetween(s.adx, 25, 35) },
    { dimension: "adx", label: "35+", match: (s) => s.adx !== null && s.adx >= 35 },
    { dimension: "rsi", label: "0-35", match: (s) => bandBetween(s.rsi, 0, 35) },
    { dimension: "rsi", label: "35-50", match: (s) => bandBetween(s.rsi, 35, 50) },
    { dimension: "rsi", label: "50-65", match: (s) => bandBetween(s.rsi, 50, 65) },
    { dimension: "rsi", label: "65-100", match: (s) => bandBetween(s.rsi, 65, 101) },
    {
      dimension: "pullbackDepth",
      label: "0.00-0.10%",
      match: (s) => bandBetween(s.pullbackDepth, 0, 0.001)
    },
    {
      dimension: "pullbackDepth",
      label: "0.10-0.30%",
      match: (s) => bandBetween(s.pullbackDepth, 0.001, 0.003)
    },
    {
      dimension: "pullbackDepth",
      label: "0.30%+",
      match: (s) => s.pullbackDepth !== null && s.pullbackDepth >= 0.003
    },
    {
      dimension: "priceDistanceFromSlowEma",
      label: "-0.50% to -0.10%",
      match: (s) => bandBetween(s.priceDistanceFromSlowEma, -0.005, -0.001)
    },
    {
      dimension: "priceDistanceFromSlowEma",
      label: "-0.10% to +0.10%",
      match: (s) => bandBetween(s.priceDistanceFromSlowEma, -0.001, 0.001)
    },
    {
      dimension: "priceDistanceFromSlowEma",
      label: "+0.10% to +0.50%",
      match: (s) => bandBetween(s.priceDistanceFromSlowEma, 0.001, 0.005)
    },
    {
      dimension: "rejectionWickBodyRatio",
      label: "0-1",
      match: (s) => bandBetween(s.rejectionWickBodyRatio, 0, 1)
    },
    {
      dimension: "rejectionWickBodyRatio",
      label: "1-2",
      match: (s) => bandBetween(s.rejectionWickBodyRatio, 1, 2)
    },
    {
      dimension: "rejectionWickBodyRatio",
      label: "2+",
      match: (s) => s.rejectionWickBodyRatio !== null && s.rejectionWickBodyRatio >= 2
    },
    {
      dimension: "atrPercent",
      label: "0-0.10%",
      match: (s) => bandBetween(s.atrPercent, 0, 0.001)
    },
    {
      dimension: "atrPercent",
      label: "0.10-0.25%",
      match: (s) => bandBetween(s.atrPercent, 0.001, 0.0025)
    },
    {
      dimension: "atrPercent",
      label: "0.25%+",
      match: (s) => s.atrPercent !== null && s.atrPercent >= 0.0025
    },
    {
      dimension: "strategyConfidence",
      label: "0.55-0.65",
      match: (s) => bandBetween(s.strategyConfidence, 0.55, 0.65)
    },
    {
      dimension: "strategyConfidence",
      label: "0.65-0.75",
      match: (s) => bandBetween(s.strategyConfidence, 0.65, 0.75)
    },
    {
      dimension: "strategyConfidence",
      label: "0.75+",
      match: (s) => s.strategyConfidence >= 0.75
    }
  ];
}

function meanReversionBandRules(): BandRule[] {
  return [
    { dimension: "action", label: "BUY", match: (_s, t) => t.action === "BUY" },
    { dimension: "action", label: "SELL", match: (_s, t) => t.action === "SELL" },
    {
      dimension: "regimeConfidence",
      label: "0.00-0.50",
      match: (s) => bandBetween(s.regimeConfidence, 0, 0.5)
    },
    {
      dimension: "regimeConfidence",
      label: "0.50-0.65",
      match: (s) => bandBetween(s.regimeConfidence, 0.5, 0.65)
    },
    {
      dimension: "regimeConfidence",
      label: "0.65-0.80",
      match: (s) => bandBetween(s.regimeConfidence, 0.65, 0.8)
    },
    {
      dimension: "regimeConfidence",
      label: "0.80-1.00",
      match: (s) => bandBetween(s.regimeConfidence, 0.8, 1.01)
    },
    { dimension: "rsi", label: "0-30", match: (s) => bandBetween(s.rsi, 0, 30) },
    { dimension: "rsi", label: "30-40", match: (s) => bandBetween(s.rsi, 30, 40) },
    { dimension: "rsi", label: "40-60", match: (s) => bandBetween(s.rsi, 40, 60) },
    { dimension: "rsi", label: "60-70", match: (s) => bandBetween(s.rsi, 60, 70) },
    { dimension: "rsi", label: "70-100", match: (s) => bandBetween(s.rsi, 70, 101) },
    {
      dimension: "bollingerPosition",
      label: "below_lower",
      match: (s) => s.bollingerPosition !== null && s.bollingerPosition < -1
    },
    {
      dimension: "bollingerPosition",
      label: "-1_to_0",
      match: (s) => bandBetween(s.bollingerPosition, -1, 0)
    },
    {
      dimension: "bollingerPosition",
      label: "0_to_1",
      match: (s) => bandBetween(s.bollingerPosition, 0, 1)
    },
    {
      dimension: "bollingerPosition",
      label: "above_upper",
      match: (s) => s.bollingerPosition !== null && s.bollingerPosition >= 1
    },
    {
      dimension: "distanceFromMean",
      label: "0-0.10%",
      match: (s) => bandBetween(Math.abs(s.distanceFromMean ?? 0), 0, 0.001)
    },
    {
      dimension: "distanceFromMean",
      label: "0.10-0.30%",
      match: (s) => bandBetween(Math.abs(s.distanceFromMean ?? 0), 0.001, 0.003)
    },
    {
      dimension: "distanceFromMean",
      label: "0.30%+",
      match: (s) => s.distanceFromMean !== null && Math.abs(s.distanceFromMean) >= 0.003
    },
    {
      dimension: "bollingerWidth",
      label: "0-0.008",
      match: (s) => bandBetween(s.bollingerWidth, 0, 0.008)
    },
    {
      dimension: "bollingerWidth",
      label: "0.008-0.015",
      match: (s) => bandBetween(s.bollingerWidth, 0.008, 0.015)
    },
    {
      dimension: "bollingerWidth",
      label: "0.015+",
      match: (s) => s.bollingerWidth !== null && s.bollingerWidth >= 0.015
    },
    {
      dimension: "rejectionWickBodyRatio",
      label: "0-1",
      match: (s) => bandBetween(s.rejectionWickBodyRatio, 0, 1)
    },
    {
      dimension: "rejectionWickBodyRatio",
      label: "1-2",
      match: (s) => bandBetween(s.rejectionWickBodyRatio, 1, 2)
    },
    {
      dimension: "rejectionWickBodyRatio",
      label: "2+",
      match: (s) => s.rejectionWickBodyRatio !== null && s.rejectionWickBodyRatio >= 2
    },
    {
      dimension: "strategyConfidence",
      label: "0.55-0.65",
      match: (s) => bandBetween(s.strategyConfidence, 0.55, 0.65)
    },
    {
      dimension: "strategyConfidence",
      label: "0.65-0.75",
      match: (s) => bandBetween(s.strategyConfidence, 0.65, 0.75)
    },
    {
      dimension: "strategyConfidence",
      label: "0.75+",
      match: (s) => s.strategyConfidence >= 0.75
    },
    { dimension: "adx", label: "0-15", match: (s) => bandBetween(s.adx, 0, 15) },
    { dimension: "adx", label: "15-22", match: (s) => bandBetween(s.adx, 15, 22) },
    { dimension: "adx", label: "22+", match: (s) => s.adx !== null && s.adx >= 22 }
  ];
}

function bandRulesForStrategy(strategyId: string): BandRule[] {
  if (strategyId === EMA_PULLBACK_STRATEGY_ID) {
    return [
      ...emaPullbackBandRules(),
      ...uniqueRegimeRules()
    ];
  }
  if (strategyId === MEAN_REVERSION_STRATEGY_ID) {
    return [
      ...meanReversionBandRules(),
      ...uniqueRegimeRules()
    ];
  }
  return [];
}

function uniqueRegimeRules(): BandRule[] {
  const regimes = [
    "STRONG_UPTREND",
    "WEAK_UPTREND",
    "STRONG_DOWNTREND",
    "WEAK_DOWNTREND",
    "RANGE_LOW_VOLATILITY",
    "RANGE_HIGH_VOLATILITY",
    "BREAKOUT_EXPANSION",
    "VOLATILITY_COMPRESSION",
    "TRANSITION",
    "UNKNOWN"
  ] as const;
  return regimes.map((regime) => ({
    dimension: "regime",
    label: regime,
    match: (s) => s.regime === regime
  }));
}

function toMetrics(trades: CfdSimulatedTrade[], startingBalance: number): QualityBucketMetrics {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const { summary } = computeCfdSummary(ordered, startingBalance);
  return {
    totalTrades: summary.totalTrades,
    wins: summary.winningTrades,
    losses: summary.losingTrades,
    pushes: summary.pushTrades,
    winRate: summary.winRate,
    profitFactor: summary.profitFactor,
    expectancyR: summary.expectancyR,
    averageR: summary.averageR,
    netProfit: summary.netProfit,
    averageWin: summary.averageWin,
    averageLoss: summary.averageLoss,
    maxDrawdown: summary.maxDrawdown,
    maxDrawdownPercent: summary.maxDrawdownPercent
  };
}

function analyzeSegment(
  strategyId: string,
  segment: CfdQualitySegment,
  trades: ReadonlyArray<CfdSimulatedTrade>,
  startingBalance: number,
  requirements: ResearchSampleRequirements
): SegmentQualityAnalysis {
  const scoped = trades.filter((t) => t.strategyId === strategyId && t.entryFeatures);
  const rules = bandRulesForStrategy(strategyId);
  const buckets: QualityFeatureBucket[] = [];
  const seen = new Set<string>();

  const pushBucket = (
    rule: BandRule,
    action: "BUY" | "SELL" | "ALL",
    matched: CfdSimulatedTrade[]
  ) => {
    if (matched.length === 0) return;
    const key = `${rule.dimension}::${rule.label}::${action}`;
    if (seen.has(key)) return;
    seen.add(key);
    buckets.push({
      dimension: rule.dimension,
      band: rule.label,
      action,
      segment,
      metrics: toMetrics(matched, startingBalance),
      evaluationStatus: resolveRegimeEvaluationStatus(matched.length, requirements)
    });
  };

  for (const rule of rules) {
    const allMatched = scoped.filter((t) => rule.match(t.entryFeatures!, t));
    if (rule.dimension === "action") {
      pushBucket(rule, rule.label as "BUY" | "SELL", allMatched);
      continue;
    }
    pushBucket(rule, "ALL", allMatched);
    pushBucket(
      rule,
      "BUY",
      allMatched.filter((t) => t.action === "BUY")
    );
    pushBucket(
      rule,
      "SELL",
      allMatched.filter((t) => t.action === "SELL")
    );
  }

  return {
    segment,
    tradesAnalyzed: trades.filter((t) => t.strategyId === strategyId).length,
    tradesWithSnapshots: scoped.length,
    buckets
  };
}

function findBucket(
  segments: Record<CfdQualitySegment, SegmentQualityAnalysis>,
  segment: CfdQualitySegment,
  dimension: string,
  band: string,
  action: "BUY" | "SELL" | "ALL"
): QualityFeatureBucket | undefined {
  return segments[segment].buckets.find(
    (b) => b.dimension === dimension && b.band === band && b.action === action
  );
}

function detectDegradation(
  strategyId: string,
  segments: Record<CfdQualitySegment, SegmentQualityAnalysis>
): CrossSegmentDegradationFlag[] {
  const flags: CrossSegmentDegradationFlag[] = [];
  const trainBuckets = segments.TRAIN.buckets.filter((b) => b.evaluationStatus !== "INSUFFICIENT_SAMPLE");

  for (const train of trainBuckets) {
    if (train.metrics.expectancyR <= 0) continue;
    const wf = findBucket(segments, "WALK_FORWARD", train.dimension, train.band, train.action);
    const ho = findBucket(segments, "HOLDOUT", train.dimension, train.band, train.action);

    const wfBad = wf && wf.evaluationStatus !== "INSUFFICIENT_SAMPLE" && wf.metrics.expectancyR < 0;
    const hoBad = ho && ho.evaluationStatus !== "INSUFFICIENT_SAMPLE" && ho.metrics.expectancyR < 0;
    const wfDegraded =
      wf &&
      wf.evaluationStatus !== "INSUFFICIENT_SAMPLE" &&
      wf.metrics.expectancyR < train.metrics.expectancyR * 0.5;
    const hoDegraded =
      ho &&
      ho.evaluationStatus !== "INSUFFICIENT_SAMPLE" &&
      ho.metrics.expectancyR < train.metrics.expectancyR * 0.5;

    if (wfBad || hoBad || wfDegraded || hoDegraded) {
      flags.push({
        strategyId,
        dimension: train.dimension,
        band: train.band,
        action: train.action,
        trainExpectancyR: train.metrics.expectancyR,
        walkForwardExpectancyR: wf?.metrics.expectancyR ?? null,
        holdoutExpectancyR: ho?.metrics.expectancyR ?? null,
        message:
          `TRAIN expectancyR ${train.metrics.expectancyR.toFixed(3)} degrades in ` +
          `WALK_FORWARD ${wf?.metrics.expectancyR?.toFixed(3) ?? "n/a"} / ` +
          `HOLDOUT ${ho?.metrics.expectancyR?.toFixed(3) ?? "n/a"}`
      });
    }
  }

  return flags;
}

export interface CfdStrategyQualityInput {
  startingBalance: number;
  requirements?: ResearchSampleRequirements;
  segments: Partial<Record<CfdQualitySegment, ReadonlyArray<CfdSimulatedTrade>>>;
  strategyIds?: ReadonlyArray<string>;
}

export function analyzeCfdStrategyQuality(
  input: CfdStrategyQualityInput
): CfdStrategyQualityAnalysisResult {
  const requirements = input.requirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS;
  const strategyIds = input.strategyIds ?? [...CFD_STRATEGY_QUALITY_TARGETS];
  const strategies: StrategyQualityAnalysis[] = [];

  for (const strategyId of strategyIds) {
    const rules = bandRulesForStrategy(strategyId);
    if (rules.length === 0) continue;

    const segmentResults = {
      TRAIN: analyzeSegment(
        strategyId,
        "TRAIN",
        input.segments.TRAIN ?? [],
        input.startingBalance,
        requirements
      ),
      WALK_FORWARD: analyzeSegment(
        strategyId,
        "WALK_FORWARD",
        input.segments.WALK_FORWARD ?? [],
        input.startingBalance,
        requirements
      ),
      HOLDOUT: analyzeSegment(
        strategyId,
        "HOLDOUT",
        input.segments.HOLDOUT ?? [],
        input.startingBalance,
        requirements
      )
    };

    strategies.push({
      strategyId,
      segments: segmentResults,
      degradationFlags: detectDegradation(strategyId, segmentResults)
    });
  }

  return {
    analysisVersion: 1,
    strategies,
    note:
      "Observation-only quality bands. HOLDOUT is never used for optimization. " +
      "No live thresholds are applied from this output."
  };
}
