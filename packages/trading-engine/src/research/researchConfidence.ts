import {
  type EvaluationStatus,
  type ParameterStabilityLevel,
  type ResearchSampleRequirements,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
} from "@regimex/shared";

export interface ResearchConfidenceInput {
  totalTrades: number;
  oosTrades: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdownPercent: number;
  walkForwardProfitableWindows: number;
  walkForwardTotalWindows: number;
  parameterStabilityScore: number | null;
  inSamplePf: number | null;
  oosPf: number | null;
  segmentIsOos: boolean;
  requirements?: ResearchSampleRequirements;
}

export interface ResearchConfidenceResult {
  score: number;
  evaluationStatus: EvaluationStatus;
  reasons: string[];
  parameterStabilityLevel: ParameterStabilityLevel;
}

export function computeResearchConfidence(input: ResearchConfidenceInput): ResearchConfidenceResult {
  const req = input.requirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS;
  const reasons: string[] = [];
  let score = 0;

  // Sample size (0-25)
  if (input.totalTrades >= req.minimumTradesForValid) {
    score += 25;
    reasons.push(`+ ${input.totalTrades} historical trades`);
  } else if (input.totalTrades >= req.minimumTradesForEvaluation) {
    score += 10 + Math.min(14, Math.floor((input.totalTrades / req.minimumTradesForValid) * 14));
    reasons.push(`~ ${input.totalTrades} trades (preliminary sample)`);
  } else {
    reasons.push(`- Only ${input.totalTrades} trades (insufficient sample)`);
  }

  // OOS consistency (0-25)
  if (input.walkForwardTotalWindows > 0) {
    const ratio = input.walkForwardProfitableWindows / input.walkForwardTotalWindows;
    score += Math.round(ratio * 25);
    reasons.push(
      ratio >= 0.6
        ? `+ Profitable in ${input.walkForwardProfitableWindows}/${input.walkForwardTotalWindows} walk-forward windows`
        : `- Profitable in only ${input.walkForwardProfitableWindows}/${input.walkForwardTotalWindows} walk-forward windows`
    );
  } else if (input.segmentIsOos && input.oosTrades >= req.minimumOosTrades) {
    score += 15;
    reasons.push(`+ ${input.oosTrades} out-of-sample trades`);
  }

  // Expectancy + PF (0-20)
  if (input.expectancy > 0) {
    score += 10;
    reasons.push("+ Positive expectancy");
  } else {
    reasons.push("- Non-positive expectancy");
  }
  if (input.profitFactor !== null && input.profitFactor >= 1.05) {
    score += Math.min(10, Math.round((input.profitFactor - 1) * 20));
    reasons.push(`+ Profit factor ${input.profitFactor.toFixed(2)}`);
  } else if (input.profitFactor !== null) {
    reasons.push(`- Profit factor ${input.profitFactor.toFixed(2)} below 1.05`);
  }

  // Drawdown penalty (0-15)
  const ddPenalty = Math.min(15, Math.round(input.maxDrawdownPercent));
  score += 15 - ddPenalty;
  if (input.maxDrawdownPercent > 15) {
    reasons.push(`- ${input.maxDrawdownPercent.toFixed(1)}% maximum drawdown`);
  } else {
    reasons.push(`+ Drawdown contained (${input.maxDrawdownPercent.toFixed(1)}%)`);
  }

  // Parameter stability (0-15)
  let parameterStabilityLevel: ParameterStabilityLevel = "UNKNOWN";
  if (input.parameterStabilityScore !== null) {
    score += Math.round(input.parameterStabilityScore * 15);
    parameterStabilityLevel =
      input.parameterStabilityScore >= 0.7 ? "HIGH" : input.parameterStabilityScore >= 0.4 ? "MEDIUM" : "LOW";
    reasons.push(
      parameterStabilityLevel === "HIGH"
        ? "+ Stable parameter region"
        : parameterStabilityLevel === "MEDIUM"
          ? "~ Moderate parameter stability"
          : "- Fragile parameter region"
    );
  }

  // IS/OOS degradation
  if (input.inSamplePf !== null && input.oosPf !== null && input.inSamplePf > 0) {
    const degradation = input.oosPf / input.inSamplePf;
    if (degradation < 0.7) {
      score -= 10;
      reasons.push(`- ${Math.round((1 - degradation) * 100)}% OOS performance degradation`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  let evaluationStatus: EvaluationStatus = "INSUFFICIENT_SAMPLE";
  if (input.totalTrades < req.minimumTradesForEvaluation) {
    evaluationStatus = "INSUFFICIENT_SAMPLE";
  } else if (
    input.totalTrades >= req.minimumTradesForValid &&
    (!input.segmentIsOos || input.oosTrades >= req.minimumOosTradesForValid)
  ) {
    evaluationStatus = "VALID";
  } else {
    evaluationStatus = "PRELIMINARY";
  }

  return { score, evaluationStatus, reasons, parameterStabilityLevel };
}
