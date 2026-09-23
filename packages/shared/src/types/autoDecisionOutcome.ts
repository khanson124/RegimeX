/**
 * Operator-facing AUTO / HOLD decision outcomes for DecisionLog.featureSummary.
 * Extends observability without replacing AutonomousDecisionCode or DecisionLog eventType.
 */
export const AUTO_DECISION_OUTCOMES = [
  "NO_STRATEGY",
  "NO_SIGNAL",
  "REGIME_CONFIDENCE_REJECTED",
  "STRATEGY_COOLDOWN",
  "RISK_REJECTED",
  "DIRECTION_BLOCKED",
  "ALTERNATIVE_SIGNAL_OBSERVED"
] as const;

export type AutoDecisionOutcome = (typeof AUTO_DECISION_OUTCOMES)[number];

export function isAutoDecisionOutcome(value: unknown): value is AutoDecisionOutcome {
  return typeof value === "string" && (AUTO_DECISION_OUTCOMES as readonly string[]).includes(value);
}

/** Compact per-candidate eligibility row stored in DecisionLog.featureSummary (capped by caller). */
export interface AutoCandidateEligibilityRow {
  strategyId: string;
  eligible: boolean;
  rejectionReason: string | null;
}

export interface AutoAlternativeSignalObservation {
  strategyId: string;
  action: "BUY" | "SELL";
  entryReason: string[];
  forwardTrialBlocked: boolean;
  forwardTrialReason: string | null;
  repeatedSetup: boolean;
}

export interface AutoSelectionComparisonRow {
  strategyId: string;
  score: number | null;
  selected: boolean;
}
