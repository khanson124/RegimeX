import { type MetricSegment, type ResearchSampleRequirements } from "@regimex/shared";
import {
  computeSummary,
  groupPerformance,
  type BacktestSummary,
  type SimulatedTrade
} from "../backtest/metrics.js";
import { computeResearchConfidence } from "./researchConfidence.js";
import { computeRiskAdjustedReturn, resolveEvaluationStatus, resolveRegimeEvaluationStatus } from "./evaluationStatus.js";

export interface StrategyRegimeMetricRow {
  symbol: string;
  interval: string;
  strategyId: string;
  regime: string;
  segment: MetricSegment;
  evaluationStatus: ReturnType<typeof resolveRegimeEvaluationStatus>;
  summary: BacktestSummary;
  riskAdjustedReturn: number | null;
  researchConfidence: number | null;
  researchConfidenceReasons: string[];
  parameterStabilityScore: number | null;
  parameterStabilityLevel: string | null;
}

export function buildStrategyRegimeMetrics(
  trades: ReadonlyArray<SimulatedTrade>,
  symbol: string,
  interval: string,
  segment: MetricSegment,
  startingBalance: number,
  requirements?: ResearchSampleRequirements,
  opts?: {
    walkForwardProfitableWindows?: number;
    walkForwardTotalWindows?: number;
    parameterStabilityScore?: number | null;
    inSamplePf?: number | null;
    oosPf?: number | null;
  }
): StrategyRegimeMetricRow[] {
  const byStrategyRegime = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const key = `${t.strategyId}::${t.regime}`;
    const bucket = byStrategyRegime.get(key);
    if (bucket) bucket.push(t);
    else byStrategyRegime.set(key, [t]);
  }

  const rows: StrategyRegimeMetricRow[] = [];
  for (const [key, group] of byStrategyRegime) {
    const [strategyId, regime] = key.split("::") as [string, string];
    const { summary } = computeSummary(group, startingBalance);
    const profits = group.map((t) => t.profit);
    const evaluationStatus = resolveRegimeEvaluationStatus(summary.totalTrades, requirements);
    const segmentStatus = resolveEvaluationStatus(summary.totalTrades, segment, requirements);
    const confidence = computeResearchConfidence({
      totalTrades: summary.totalTrades,
      oosTrades: summary.totalTrades,
      profitFactor: summary.profitFactor,
      expectancy: summary.expectancy,
      maxDrawdownPercent: summary.maxDrawdownPercent * 100,
      walkForwardProfitableWindows: opts?.walkForwardProfitableWindows ?? 0,
      walkForwardTotalWindows: opts?.walkForwardTotalWindows ?? 0,
      parameterStabilityScore: opts?.parameterStabilityScore ?? null,
      inSamplePf: opts?.inSamplePf ?? null,
      oosPf: opts?.oosPf ?? summary.profitFactor,
      segmentIsOos: segment === "WALK_FORWARD" || segment === "HOLDOUT" || segment === "DEMO_FORWARD"
    });

    rows.push({
      symbol,
      interval,
      strategyId,
      regime,
      segment,
      evaluationStatus: evaluationStatus === "INSUFFICIENT_SAMPLE" ? segmentStatus : evaluationStatus,
      summary,
      riskAdjustedReturn: computeRiskAdjustedReturn(profits),
      researchConfidence: confidence.score,
      researchConfidenceReasons: confidence.reasons,
      parameterStabilityScore: opts?.parameterStabilityScore ?? null,
      parameterStabilityLevel: confidence.parameterStabilityLevel
    });
  }

  // Overall per strategy
  const strategyGroups = groupPerformance(trades, (t) => t.strategyId);
  for (const g of strategyGroups) {
    const strategyTrades = trades.filter((t) => t.strategyId === g.key);
    const { summary } = computeSummary(strategyTrades, startingBalance);
    const confidence = computeResearchConfidence({
      totalTrades: summary.totalTrades,
      oosTrades: summary.totalTrades,
      profitFactor: summary.profitFactor,
      expectancy: summary.expectancy,
      maxDrawdownPercent: summary.maxDrawdownPercent * 100,
      walkForwardProfitableWindows: opts?.walkForwardProfitableWindows ?? 0,
      walkForwardTotalWindows: opts?.walkForwardTotalWindows ?? 0,
      parameterStabilityScore: opts?.parameterStabilityScore ?? null,
      inSamplePf: opts?.inSamplePf ?? null,
      oosPf: opts?.oosPf ?? summary.profitFactor,
      segmentIsOos: segment === "WALK_FORWARD" || segment === "HOLDOUT" || segment === "DEMO_FORWARD"
    });
    rows.push({
      symbol,
      interval,
      strategyId: g.key,
      regime: "ALL",
      segment,
      evaluationStatus: resolveEvaluationStatus(summary.totalTrades, segment, requirements),
      summary,
      riskAdjustedReturn: computeRiskAdjustedReturn(strategyTrades.map((t) => t.profit)),
      researchConfidence: confidence.score,
      researchConfidenceReasons: confidence.reasons,
      parameterStabilityScore: opts?.parameterStabilityScore ?? null,
      parameterStabilityLevel: confidence.parameterStabilityLevel
    });
  }

  return rows;
}
