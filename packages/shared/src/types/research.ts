/** How a research metric row was computed. */
export const METRIC_SEGMENTS = [
  "OVERALL",
  "TRAIN",
  "TEST",
  "WALK_FORWARD",
  "HOLDOUT",
  "DEMO_FORWARD",
  "PAPER_FORWARD",
  /** Broker-demo CFD forward — never blended with paper or historical OOS. */
  "BROKER_DEMO_FORWARD",
  "BASELINE"
] as const;

export type MetricSegment = (typeof METRIC_SEGMENTS)[number];

/** Sample-size gate for trusting a metric row. */
export const EVALUATION_STATUSES = ["INSUFFICIENT_SAMPLE", "PRELIMINARY", "VALID"] as const;

export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/** Structured decision outcome for trade candidates. */
export const CANDIDATE_DECISION_CODES = [
  "TRADE",
  "NO_STRATEGY",
  "NO_SIGNAL",
  "REJECT_STRATEGY",
  "REJECT_REGIME",
  "REJECT_CONFIDENCE",
  "REJECT_RISK",
  "REJECT_COOLDOWN",
  "REJECT_CAPACITY"
] as const;

export type CandidateDecisionCode = (typeof CANDIDATE_DECISION_CODES)[number];

export const RESEARCH_RUN_MODES = ["SIMPLE", "WALK_FORWARD", "EXPERIMENT"] as const;

export type ResearchRunMode = (typeof RESEARCH_RUN_MODES)[number];

export const RESEARCH_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
] as const;

export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

/** Origin of a TradeCandidate — distinguishes research context. */
export const TRADE_CANDIDATE_ORIGINS = [
  "LIVE",
  "BACKTEST",
  "WALK_FORWARD_TEST",
  "FINAL_HOLDOUT",
  "DEMO_FORWARD"
] as const;

export type TradeCandidateOrigin = (typeof TRADE_CANDIDATE_ORIGINS)[number];

/** Alias for backward compatibility. */
export const TRADE_CANDIDATE_SOURCES = TRADE_CANDIDATE_ORIGINS;

/** @deprecated Use TradeCandidateOrigin */
export type TradeCandidateSource = TradeCandidateOrigin;

export const HYPOTHETICAL_OUTCOMES = ["WIN", "LOSS", "PUSH", "PENDING", "INSUFFICIENT_DATA"] as const;

export type HypotheticalOutcome = (typeof HYPOTHETICAL_OUTCOMES)[number];

/** Configurable minimum sample gates for research evaluation. */
export interface ResearchSampleRequirements {
  minimumTradesForEvaluation: number;
  minimumTradesPerRegime: number;
  minimumOosTrades: number;
  minimumTradesForValid: number;
  minimumOosTradesForValid: number;
}

export const DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS: ResearchSampleRequirements = {
  minimumTradesForEvaluation: 10,
  minimumTradesPerRegime: 30,
  minimumOosTrades: 20,
  minimumTradesForValid: 100,
  minimumOosTradesForValid: 50
};

/** Parameter stability classification exposed to UI. */
export const PARAMETER_STABILITY_LEVELS = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;

export type ParameterStabilityLevel = (typeof PARAMETER_STABILITY_LEVELS)[number];

export const RESEARCH_VERDICTS = [
  "INSUFFICIENT_EVIDENCE",
  "NO_EDGE_DETECTED",
  "PROMISING",
  "ROBUST",
  "DEGRADING"
] as const;

export type ResearchVerdict = (typeof RESEARCH_VERDICTS)[number];

/** Research-only promotion advice — never auto-deployed. */
export const PROMOTION_ELIGIBILITIES = [
  "REJECTED",
  "EXPERIMENTAL",
  "CANDIDATE",
  "VALIDATED"
] as const;

export type PromotionEligibility = (typeof PROMOTION_ELIGIBILITIES)[number];

export const DEGRADATION_LEVELS = [
  "LOW_DEGRADATION",
  "MODERATE_DEGRADATION",
  "HIGH_DEGRADATION",
  "SEVERE_DEGRADATION"
] as const;

export type DegradationLevel = (typeof DEGRADATION_LEVELS)[number];

export const BASELINE_TYPES = [
  "RANDOM",
  "ALWAYS_CALL",
  "ALWAYS_PUT",
  "NO_REGIME_FILTER",
  "ALWAYS_LONG",
  "ALWAYS_SHORT",
  "RANDOM_DIRECTION",
  "NO_TRADE"
] as const;

export type BaselineType = (typeof BASELINE_TYPES)[number];

export interface DegradationThresholds {
  moderateRatio: number;
  highRatio: number;
  severeRatio: number;
}

export const DEFAULT_DEGRADATION_THRESHOLDS: DegradationThresholds = {
  moderateRatio: 0.85,
  highRatio: 0.7,
  severeRatio: 0.5
};

export type RegimeFilterMode = "ENABLED" | "DISABLED";
