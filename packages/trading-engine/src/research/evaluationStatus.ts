import {
  type EvaluationStatus,
  type MetricSegment,
  type ResearchSampleRequirements,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
} from "@regimex/shared";
import { type BacktestSummary } from "../backtest/metrics.js";

export interface ExtendedMetricRow {
  symbol: string;
  interval: string;
  strategyId: string;
  regime: string;
  segment: MetricSegment;
  evaluationStatus: EvaluationStatus;
  summary: BacktestSummary;
  riskAdjustedReturn: number | null;
}

/** Sharpe-like risk-adjusted return from per-trade profits. */
export function computeRiskAdjustedReturn(profits: ReadonlyArray<number>): number | null {
  if (profits.length < 2) return null;
  const mean = profits.reduce((a, b) => a + b, 0) / profits.length;
  const variance = profits.reduce((a, p) => a + (p - mean) ** 2, 0) / profits.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return Number((mean / std).toFixed(4));
}

export function resolveEvaluationStatus(
  trades: number,
  segment: MetricSegment,
  requirements: ResearchSampleRequirements = DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
): EvaluationStatus {
  const isOos = segment === "TEST" || segment === "WALK_FORWARD" || segment === "HOLDOUT" || segment === "DEMO_FORWARD";

  if (trades < requirements.minimumTradesForEvaluation) return "INSUFFICIENT_SAMPLE";
  if (isOos && trades < requirements.minimumOosTrades) return "INSUFFICIENT_SAMPLE";

  if (trades >= requirements.minimumTradesForValid && (!isOos || trades >= requirements.minimumOosTradesForValid)) {
    return "VALID";
  }
  return "PRELIMINARY";
}

export function resolveRegimeEvaluationStatus(
  trades: number,
  requirements: ResearchSampleRequirements = DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
): EvaluationStatus {
  if (trades < requirements.minimumTradesForEvaluation) return "INSUFFICIENT_SAMPLE";
  if (trades < requirements.minimumTradesPerRegime) return "PRELIMINARY";
  if (trades >= requirements.minimumTradesForValid) return "VALID";
  return "PRELIMINARY";
}