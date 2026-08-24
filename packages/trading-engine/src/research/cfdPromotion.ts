import {
  type ParameterStabilityLevel,
  type ResearchSampleRequirements,
  type ResearchVerdict,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS,
  PROMOTION_ELIGIBILITIES,
  type PromotionEligibility
} from "@regimex/shared";
import { type CfdWalkForwardAggregate } from "./cfdWalkForwardAggregates.js";

export { PROMOTION_ELIGIBILITIES, type PromotionEligibility };

/**
 * Research-level promotion eligibility — metadata/advice only.
 * Never auto-deploys or mutates live strategy parameters.
 */

export interface PromotionEligibilityInput {
  verdict: ResearchVerdict;
  aggregate: CfdWalkForwardAggregate;
  holdoutExpectancyR: number | null;
  holdoutTrades: number;
  parameterStabilityLevel: ParameterStabilityLevel;
  parameterStabilityScore: number | null;
  forwardTradeCount: number;
  forwardExpectancyR: number | null;
  /** Historical vs forward degradation fraction (0–1), optional. */
  forwardDegradation?: number | null;
  outperformsBaselines: boolean;
  requirements?: ResearchSampleRequirements;
}

export interface PromotionEligibilityResult {
  eligibility: PromotionEligibility;
  reasons: string[];
}

export function computePromotionEligibility(
  input: PromotionEligibilityInput
): PromotionEligibilityResult {
  const req = input.requirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS;
  const reasons: string[] = [];

  if (input.verdict === "INSUFFICIENT_EVIDENCE") {
    return { eligibility: "REJECTED", reasons: ["Insufficient research evidence"] };
  }
  if (input.verdict === "NO_EDGE_DETECTED") {
    return { eligibility: "REJECTED", reasons: ["Research verdict NO_EDGE_DETECTED"] };
  }
  if (input.verdict === "DEGRADING") {
    return { eligibility: "REJECTED", reasons: ["Research verdict DEGRADING"] };
  }
  if (!input.outperformsBaselines) {
    reasons.push("Does not clearly outperform CFD baselines");
  }
  if (input.aggregate.totalValidationTrades < req.minimumOosTrades) {
    return {
      eligibility: "REJECTED",
      reasons: [
        `OOS trades ${input.aggregate.totalValidationTrades} < minimum ${req.minimumOosTrades}`
      ]
    };
  }
  if (input.aggregate.percentPositiveExpectancyWindows < 0.5) {
    return {
      eligibility: "REJECTED",
      reasons: [
        `Only ${(input.aggregate.percentPositiveExpectancyWindows * 100).toFixed(0)}% windows have positive expectancyR`
      ]
    };
  }
  if (
    input.holdoutTrades >= req.minimumOosTrades &&
    (input.holdoutExpectancyR == null || input.holdoutExpectancyR <= 0)
  ) {
    return {
      eligibility: "REJECTED",
      reasons: ["Final holdout expectancyR is non-positive"]
    };
  }
  if (input.parameterStabilityLevel === "LOW") {
    reasons.push("Low parameter stability across windows");
  }
  if (
    input.forwardTradeCount >= req.minimumTradesForEvaluation &&
    input.forwardExpectancyR != null &&
    input.forwardExpectancyR < 0
  ) {
    reasons.push("Forward-paper expectancyR is negative");
  }
  if ((input.forwardDegradation ?? 0) >= 0.5) {
    reasons.push("Severe historical→forward degradation");
  }

  if (input.verdict === "ROBUST" && reasons.length === 0 && input.outperformsBaselines) {
    if (
      input.aggregate.totalValidationTrades >= req.minimumOosTradesForValid &&
      input.holdoutTrades >= req.minimumOosTrades &&
      (input.holdoutExpectancyR ?? 0) > 0 &&
      input.parameterStabilityLevel !== "LOW" &&
      (input.forwardTradeCount < req.minimumTradesForEvaluation ||
        (input.forwardExpectancyR ?? 0) >= 0)
    ) {
      return {
        eligibility: "VALIDATED",
        reasons: ["Meets ROBUST criteria with holdout, stability, and baseline edge"]
      };
    }
    return {
      eligibility: "CANDIDATE",
      reasons: ["ROBUST but awaiting fuller holdout/forward confirmation", ...reasons]
    };
  }

  if (input.verdict === "PROMISING") {
    if (reasons.some((r) => r.includes("Forward-paper") || r.includes("degradation"))) {
      return { eligibility: "EXPERIMENTAL", reasons };
    }
    return {
      eligibility: "CANDIDATE",
      reasons: reasons.length ? reasons : ["PROMISING — candidate for further paper validation"]
    };
  }

  return { eligibility: "EXPERIMENTAL", reasons: reasons.length ? reasons : ["Needs more evidence"] };
}
