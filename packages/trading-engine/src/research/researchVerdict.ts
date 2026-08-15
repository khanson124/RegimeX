import {
  type EvaluationStatus,
  type ParameterStabilityLevel,
  type ResearchSampleRequirements,
  type ResearchVerdict,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
} from "@regimex/shared";
import { type BacktestSummary } from "../backtest/metrics.js";
import { type BaselineComparisonResult } from "./baselines.js";
import { type DegradationAnalysisResult } from "./degradationAnalysis.js";

export interface ResearchVerdictInput {
  confidenceScore: number;
  confidenceStatus: EvaluationStatus;
  walkForward: BacktestSummary | null;
  holdout: BacktestSummary | null;
  demoForward: BacktestSummary | null;
  walkForwardProfitableWindows: number;
  walkForwardTotalWindows: number;
  parameterStabilityLevel: ParameterStabilityLevel;
  parameterStabilityScore: number | null;
  baselines: BaselineComparisonResult | null;
  degradation: DegradationAnalysisResult | null;
  requirements?: ResearchSampleRequirements;
}

export interface ResearchVerdictResult {
  verdict: ResearchVerdict;
  confidence: number;
  reasons: string[];
  conclusion: string;
}

export function computeResearchVerdict(input: ResearchVerdictInput): ResearchVerdictResult {
  const req = input.requirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS;
  const reasons: string[] = [];
  const wf = input.walkForward;
  const holdout = input.holdout;
  const demo = input.demoForward;

  const wfTrades = wf?.totalTrades ?? 0;
  const holdoutTrades = holdout?.totalTrades ?? 0;
  const demoTrades = demo?.totalTrades ?? 0;

  if (wfTrades < req.minimumTradesForEvaluation && holdoutTrades < req.minimumTradesForEvaluation) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: Math.min(input.confidenceScore, 40),
      reasons: [`- Only ${wfTrades} walk-forward trades and ${holdoutTrades} holdout trades`],
      conclusion:
        "Not enough out-of-sample trades to evaluate whether RegimeX has a detectable edge."
    };
  }

  let positiveSignals = 0;
  let negativeSignals = 0;

  const wfPf = wf?.profitFactor ?? null;
  const holdoutPf = holdout?.profitFactor ?? null;
  const wfExpectancy = wf?.expectancy ?? 0;
  const holdoutExpectancy = holdout?.expectancy ?? 0;

  if (wfExpectancy > 0 && wfPf !== null && wfPf >= 1) {
    positiveSignals++;
    reasons.push(`+ Walk-forward PF ${wfPf.toFixed(2)} with positive expectancy`);
  } else if (wfTrades >= req.minimumOosTrades) {
    negativeSignals++;
    reasons.push(`- Walk-forward PF ${wfPf?.toFixed(2) ?? "n/a"} or non-positive expectancy`);
  }

  if (input.walkForwardTotalWindows > 0) {
    const ratio = input.walkForwardProfitableWindows / input.walkForwardTotalWindows;
    if (ratio >= 0.6) {
      positiveSignals++;
      reasons.push(
        `+ Positive expectancy across ${input.walkForwardProfitableWindows}/${input.walkForwardTotalWindows} walk-forward windows`
      );
    } else {
      negativeSignals++;
      reasons.push(
        `- Profitable in only ${input.walkForwardProfitableWindows}/${input.walkForwardTotalWindows} walk-forward windows`
      );
    }
  }

  if (holdoutPf !== null && holdoutExpectancy > 0 && holdoutPf >= 1) {
    positiveSignals++;
    reasons.push(`+ Final holdout PF ${holdoutPf.toFixed(2)}`);
  } else if (holdoutTrades >= req.minimumOosTrades) {
    negativeSignals++;
    reasons.push(`- Final holdout did not show positive expectancy (PF ${holdoutPf?.toFixed(2) ?? "n/a"})`);
  }

  const baselines = input.baselines;
  if (baselines?.randomBeatRate != null) {
    if (baselines.randomBeatRate >= 0.9) {
      positiveSignals++;
      reasons.push(
        `+ Outperformed random baseline in ${Math.round(baselines.randomBeatRate * 100)}% of simulations`
      );
    } else if (baselines.randomBeatRate < 0.5) {
      negativeSignals++;
      reasons.push(`- Underperformed random baseline (${Math.round(baselines.randomBeatRate * 100)}% beat rate)`);
    }
  }

  if (baselines?.regimePfImprovementPercent != null) {
    if (baselines.regimePfImprovementPercent >= 5) {
      positiveSignals++;
      reasons.push(
        `+ Regime filtering improved PF by ${baselines.regimePfImprovementPercent.toFixed(1)}%`
      );
    } else if (baselines.regimePfImprovementPercent < -5) {
      negativeSignals++;
      reasons.push(
        `- Regime filtering reduced PF by ${Math.abs(baselines.regimePfImprovementPercent).toFixed(1)}%`
      );
    }
  }

  if (input.parameterStabilityLevel === "HIGH") {
    positiveSignals++;
    reasons.push("+ Stable parameter neighborhood across windows");
  } else if (input.parameterStabilityLevel === "LOW") {
    negativeSignals++;
    reasons.push("- Parameter sets varied widely across walk-forward windows");
  }

  if (
    input.degradation?.worstLevel === "SEVERE_DEGRADATION" ||
    input.degradation?.worstLevel === "HIGH_DEGRADATION"
  ) {
    negativeSignals++;
    reasons.push(
      `- Performance degradation flagged as ${input.degradation.worstLevel.replace(/_/g, " ").toLowerCase()}`
    );
  } else if (input.degradation?.worstLevel === "LOW_DEGRADATION") {
    positiveSignals++;
    reasons.push("+ Performance held up across research stages");
  }

  if (demoTrades > 0) {
    if (demoTrades < req.minimumTradesForValid) {
      reasons.push(`- Demo-forward sample only ${demoTrades} trades (PRELIMINARY)`);
    } else if ((demo?.profitFactor ?? 0) >= 1 && (demo?.expectancy ?? 0) > 0) {
      positiveSignals++;
      reasons.push(`+ Demo-forward PF ${demo?.profitFactor?.toFixed(2) ?? "n/a"}`);
    }
  } else {
    reasons.push("~ Demo-forward data not yet attached");
  }

  if (
    negativeSignals >= 3 &&
    (wfPf === null || wfPf < 1) &&
    (holdoutPf === null || holdoutPf < 1)
  ) {
    return {
      verdict: "NO_EDGE_DETECTED",
      confidence: Math.max(10, 100 - negativeSignals * 15),
      reasons,
      conclusion:
        "Historical and out-of-sample evidence does not support a detectable edge for this strategy/regime combination."
    };
  }

  if (input.degradation?.worstLevel === "SEVERE_DEGRADATION" && (holdoutPf ?? 0) < 1) {
    return {
      verdict: "DEGRADING",
      confidence: input.confidenceScore,
      reasons,
      conclusion:
        "Evidence shows meaningful performance degradation across validation stages — treat results as fragile."
    };
  }

  const robust =
    positiveSignals >= 4 &&
    holdoutTrades >= req.minimumOosTradesForValid &&
    (holdoutPf ?? 0) >= 1.05 &&
    input.parameterStabilityLevel !== "LOW" &&
    demoTrades >= req.minimumTradesForValid &&
    (demo?.profitFactor ?? 0) >= 1;

  if (robust) {
    return {
      verdict: "ROBUST",
      confidence: input.confidenceScore,
      reasons,
      conclusion:
        "Multiple validation stages, baselines, and demo-forward evidence align — still not a guarantee of future profitability."
    };
  }

  if (positiveSignals >= 2 && negativeSignals <= 2) {
    return {
      verdict: "PROMISING",
      confidence: input.confidenceScore,
      reasons,
      conclusion:
        "Evidence suggests the strategy/regime combination has historically maintained positive expectancy outside optimization data, but demo-forward evidence may not yet be sufficient to consider it robust."
    };
  }

  if (negativeSignals > positiveSignals) {
    return {
      verdict: "NO_EDGE_DETECTED",
      confidence: Math.max(15, input.confidenceScore - 20),
      reasons,
      conclusion: "Validation results lean negative — no reliable edge detected under current evidence."
    };
  }

  return {
    verdict: "INSUFFICIENT_EVIDENCE",
    confidence: input.confidenceScore,
    reasons,
    conclusion:
      "Mixed or incomplete evidence — run a full experiment with adequate sample size before drawing conclusions."
  };
}
