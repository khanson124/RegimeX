import {
  type EvaluationStatus,
  type ParameterStabilityLevel,
  type ResearchSampleRequirements,
  type ResearchVerdict,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
} from "@regimex/shared";
import { type CfdBacktestSummary } from "../backtest/cfdMetrics.js";
import { type CfdBaselineComparisonResult } from "./cfdBaselines.js";
import { type DegradationAnalysisResult } from "./degradationAnalysis.js";
import {
  isSingleWindowDominated,
  type CfdWalkForwardAggregate
} from "./cfdWalkForwardAggregates.js";

export interface CfdResearchVerdictInput {
  confidenceScore: number;
  confidenceStatus: EvaluationStatus;
  aggregate: CfdWalkForwardAggregate;
  walkForwardSummary: CfdBacktestSummary | null;
  holdoutSummary: CfdBacktestSummary | null;
  /** Paper / broker-demo forward — kept separate from historical OOS. */
  forwardSummary: CfdBacktestSummary | null;
  parameterStabilityLevel: ParameterStabilityLevel;
  parameterStabilityScore: number | null;
  baselines: CfdBaselineComparisonResult | null;
  degradation: DegradationAnalysisResult | null;
  /** Strategy validation expectancyR vs best simple baseline on aggregate. */
  outperformsBaselines: boolean;
  requirements?: ResearchSampleRequirements;
}

export interface CfdResearchVerdictResult {
  verdict: ResearchVerdict;
  confidence: number;
  reasons: string[];
  conclusion: string;
  historicalEvidence: {
    weightedExpectancyR: number;
    medianExpectancyR: number;
    percentPositiveExpectancyWindows: number;
    totalValidationTrades: number;
    singleWindowDominated: boolean;
  };
  forwardEvidence: {
    trades: number;
    expectancyR: number | null;
  };
  degradationNotes: string[];
}

/**
 * Hardened CFD research verdict.
 * One excellent window must not produce ROBUST.
 */
export function computeCfdResearchVerdict(
  input: CfdResearchVerdictInput
): CfdResearchVerdictResult {
  const req = input.requirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS;
  const reasons: string[] = [];
  const degradationNotes: string[] = [];
  const agg = input.aggregate;
  const holdout = input.holdoutSummary;
  const forward = input.forwardSummary;

  const historicalEvidence = {
    weightedExpectancyR: agg.weightedExpectancyR,
    medianExpectancyR: agg.medianExpectancyR,
    percentPositiveExpectancyWindows: agg.percentPositiveExpectancyWindows,
    totalValidationTrades: agg.totalValidationTrades,
    singleWindowDominated: isSingleWindowDominated(agg)
  };
  const forwardEvidence = {
    trades: forward?.totalTrades ?? 0,
    expectancyR: forward ? forward.expectancyR : null
  };

  if (
    agg.totalValidationTrades < req.minimumTradesForEvaluation &&
    (holdout?.totalTrades ?? 0) < req.minimumTradesForEvaluation
  ) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: Math.min(input.confidenceScore, 40),
      reasons: [
        `- Only ${agg.totalValidationTrades} walk-forward validation trades and ${holdout?.totalTrades ?? 0} holdout trades`
      ],
      conclusion: "Not enough out-of-sample CFD trades to evaluate edge.",
      historicalEvidence,
      forwardEvidence,
      degradationNotes
    };
  }

  let positive = 0;
  let negative = 0;

  if (agg.weightedExpectancyR > 0 && (agg.profitFactor ?? 0) >= 1) {
    positive++;
    reasons.push(
      `+ Weighted OOS expectancyR ${agg.weightedExpectancyR.toFixed(3)} (median ${agg.medianExpectancyR.toFixed(3)})`
    );
  } else if (agg.totalValidationTrades >= req.minimumOosTrades) {
    negative++;
    reasons.push(
      `- Non-positive weighted OOS expectancyR ${agg.weightedExpectancyR.toFixed(3)}`
    );
  }

  if (agg.windowCount > 0) {
    if (agg.percentPositiveExpectancyWindows >= 0.6) {
      positive++;
      reasons.push(
        `+ Positive expectancyR in ${(agg.percentPositiveExpectancyWindows * 100).toFixed(0)}% of ${agg.windowCount} windows`
      );
    } else {
      negative++;
      reasons.push(
        `- Positive expectancyR in only ${(agg.percentPositiveExpectancyWindows * 100).toFixed(0)}% of windows`
      );
    }
  }

  if (historicalEvidence.singleWindowDominated) {
    negative += 2;
    reasons.push("- Result dominated by one winning window while majority are weak/negative");
  }

  if (agg.expectancyRVariability > 0.5 && agg.windowCount >= 3) {
    negative++;
    reasons.push(
      `- High between-window expectancyR variability (${agg.expectancyRVariability.toFixed(2)})`
    );
  }

  if (holdout && holdout.totalTrades >= req.minimumOosTrades) {
    if (holdout.expectancyR > 0 && (holdout.profitFactor ?? 0) >= 1) {
      positive++;
      reasons.push(`+ Final holdout expectancyR ${holdout.expectancyR.toFixed(3)}`);
    } else {
      negative += 2;
      reasons.push(
        `- Final holdout expectancyR ${holdout.expectancyR.toFixed(3)} (materially weak)`
      );
    }
  }

  if (input.outperformsBaselines) {
    positive++;
    reasons.push("+ Outperforms simple CFD baselines (LONG/SHORT/RANDOM) on validation");
  } else if (input.baselines) {
    negative++;
    reasons.push("- Does not clearly outperform simple CFD baselines");
  }

  if (input.parameterStabilityLevel === "HIGH") {
    positive++;
    reasons.push("+ High parameter stability across windows");
  } else if (input.parameterStabilityLevel === "LOW") {
    negative++;
    reasons.push("- Severe parameter instability across independently optimized windows");
  }

  if (input.degradation?.worstLevel === "SEVERE_DEGRADATION") {
    negative += 2;
    degradationNotes.push("Severe train→OOS→holdout degradation");
    reasons.push("- Severe performance degradation across research ladder");
  } else if (input.degradation?.worstLevel === "HIGH_DEGRADATION") {
    negative++;
    degradationNotes.push("High degradation on research ladder");
  }

  if (forward && forward.totalTrades >= req.minimumTradesForEvaluation) {
    if (forward.expectancyR > 0) {
      positive++;
      reasons.push(
        `+ Forward-paper expectancyR ${forward.expectancyR.toFixed(3)} over ${forward.totalTrades} trades`
      );
    } else {
      negative++;
      degradationNotes.push(
        `Historical OOS E[R] ${agg.weightedExpectancyR.toFixed(3)} vs forward E[R] ${forward.expectancyR.toFixed(3)}`
      );
      reasons.push(
        `- Forward-paper expectancyR ${forward.expectancyR.toFixed(3)} (historical/forward divergence)`
      );
    }
  }

  if (agg.maxDrawdownPercent > 20) {
    negative++;
    reasons.push(`- High OOS max drawdown ${agg.maxDrawdownPercent.toFixed(1)}%`);
  }

  let verdict: ResearchVerdict;
  let conclusion: string;
  let confidence = input.confidenceScore;

  if (negative >= positive + 2 || (holdout && holdout.expectancyR < -0.1 && holdout.totalTrades >= req.minimumOosTrades)) {
    verdict = negative >= 3 && positive === 0 ? "NO_EDGE_DETECTED" : "DEGRADING";
    if (
      input.degradation?.worstLevel === "SEVERE_DEGRADATION" ||
      (forward &&
        forward.totalTrades >= req.minimumTradesForEvaluation &&
        forward.expectancyR < 0 &&
        agg.weightedExpectancyR > 0)
    ) {
      verdict = "DEGRADING";
    }
    if (positive === 0 && agg.weightedExpectancyR <= 0) {
      verdict = "NO_EDGE_DETECTED";
    }
    conclusion =
      verdict === "NO_EDGE_DETECTED"
        ? "CFD evidence does not support a reliable edge."
        : "Edge appears to degrade out of sample or in forward paper.";
    confidence = Math.min(confidence, 55);
  } else if (
    positive >= 4 &&
    negative <= 1 &&
    !historicalEvidence.singleWindowDominated &&
    agg.totalValidationTrades >= req.minimumOosTradesForValid &&
    input.parameterStabilityLevel !== "LOW" &&
    (holdout?.expectancyR ?? 0) > 0
  ) {
    verdict = "ROBUST";
    conclusion = "Consistent multi-window CFD OOS evidence with acceptable holdout and stability.";
  } else if (positive > negative) {
    verdict = "PROMISING";
    conclusion = "Some CFD OOS support exists but consistency, holdout, or baselines need confirmation.";
    confidence = Math.min(confidence, 70);
  } else if (agg.totalValidationTrades < req.minimumOosTrades) {
    verdict = "INSUFFICIENT_EVIDENCE";
    conclusion = "Sample remains too thin for a confident CFD verdict.";
    confidence = Math.min(confidence, 45);
  } else {
    verdict = "NO_EDGE_DETECTED";
    conclusion = "Mixed or weak CFD OOS results — no clear edge.";
    confidence = Math.min(confidence, 50);
  }

  return {
    verdict,
    confidence,
    reasons,
    conclusion,
    historicalEvidence,
    forwardEvidence,
    degradationNotes
  };
}

/** Compare strategy aggregate expectancyR vs best of ALWAYS_LONG / ALWAYS_SHORT / RANDOM median. */
export function strategyOutperformsCfdBaselines(
  strategyExpectancyR: number,
  baselines: CfdBaselineComparisonResult | null
): boolean {
  if (!baselines) return false;
  const comps: number[] = [];
  if (baselines.alwaysLong) comps.push(baselines.alwaysLong.expectancyR);
  if (baselines.alwaysShort) comps.push(baselines.alwaysShort.expectancyR);
  if (baselines.randomDirection?.medianExpectancyR != null) {
    comps.push(baselines.randomDirection.medianExpectancyR);
  }
  if (comps.length === 0) return false;
  const bestBaseline = Math.max(...comps);
  return strategyExpectancyR > bestBaseline && strategyExpectancyR > 0;
}
