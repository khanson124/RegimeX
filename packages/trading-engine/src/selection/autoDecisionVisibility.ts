/**
 * Pure helpers for AUTO decision visibility (DecisionLog.featureSummary enrichment).
 * Does not change selection or strategy evaluate() behaviour.
 */
import {
  type AutoAlternativeSignalObservation,
  type AutoCandidateEligibilityRow,
  type AutoDecisionOutcome,
  type AutoSelectionComparisonRow,
  isAutoDecisionOutcome
} from "@regimex/shared";

const MAX_CANDIDATE_ROWS = 16;
const MAX_REASON_LEN = 160;
const MAX_ALT_REASONS = 3;

export function truncateReason(reason: string, max = MAX_REASON_LEN): string {
  const t = reason.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function classifyHoldInvalidationReasons(
  invalidationReasons: ReadonlyArray<string>
): Extract<AutoDecisionOutcome, "NO_SIGNAL" | "STRATEGY_COOLDOWN"> {
  const joined = invalidationReasons.join("\n");
  if (/cooldown active/i.test(joined)) return "STRATEGY_COOLDOWN";
  return "NO_SIGNAL";
}

export function classifyNoStrategyOutcome(
  candidateEligibility: ReadonlyArray<AutoCandidateEligibilityRow>
): Extract<AutoDecisionOutcome, "NO_STRATEGY" | "REGIME_CONFIDENCE_REJECTED"> {
  const rejected = candidateEligibility.filter((c) => !c.eligible);
  if (rejected.length === 0) return "NO_STRATEGY";
  const allConfidence = rejected.every(
    (c) =>
      c.rejectionReason != null &&
      /regime confidence|minimumRegimeConfidence|below minimum regime/i.test(c.rejectionReason)
  );
  if (allConfidence && rejected.length === candidateEligibility.length) {
    return "REGIME_CONFIDENCE_REJECTED";
  }
  // If every evaluated strategy failed only on regime confidence (and some were never
  // considered for other reasons), still prefer REGIME_CONFIDENCE when that is the
  // sole gate among session-applicable strategies.
  const confidenceRejects = rejected.filter(
    (c) =>
      c.rejectionReason != null &&
      /regime confidence|minimumRegimeConfidence|below minimum regime/i.test(c.rejectionReason)
  );
  const otherRejects = rejected.filter((c) => !confidenceRejects.includes(c));
  if (confidenceRejects.length > 0 && otherRejects.length === 0) {
    return "REGIME_CONFIDENCE_REJECTED";
  }
  return "NO_STRATEGY";
}

export function resolveHoldDecisionOutcome(input: {
  invalidationReasons: ReadonlyArray<string>;
  alternativeSignals: ReadonlyArray<AutoAlternativeSignalObservation>;
}): AutoDecisionOutcome {
  if (input.alternativeSignals.length > 0) return "ALTERNATIVE_SIGNAL_OBSERVED";
  return classifyHoldInvalidationReasons(input.invalidationReasons);
}

export function buildSelectionWhy(input: {
  selectedStrategyId: string;
  selectionMode: string | null;
  selectionScore: number | null;
  reasons: ReadonlyArray<string>;
  alternatives: ReadonlyArray<{ strategyId: string; score: number }>;
}): string[] {
  const why: string[] = [];
  why.push(`Selected ${input.selectedStrategyId}`);
  if (input.selectionMode) why.push(`mode=${input.selectionMode}`);
  if (input.selectionScore != null && Number.isFinite(input.selectionScore)) {
    why.push(`score=${input.selectionScore}`);
  }
  for (const r of input.reasons.slice(0, 4)) {
    why.push(truncateReason(r));
  }
  if (input.alternatives.length > 0) {
    const alt = input.alternatives
      .slice(0, 4)
      .map((a) => `${a.strategyId}:${a.score}`)
      .join(", ");
    why.push(`over [${alt}]`);
  } else {
    why.push("no scored alternatives");
  }
  return why;
}

export function toSelectionComparisonRows(input: {
  selectedStrategyId: string;
  selectionScore: number | null;
  alternatives: ReadonlyArray<{ strategyId: string; score: number }>;
}): AutoSelectionComparisonRow[] {
  const rows: AutoSelectionComparisonRow[] = [
    {
      strategyId: input.selectedStrategyId,
      score: input.selectionScore,
      selected: true
    },
    ...input.alternatives.map((a) => ({
      strategyId: a.strategyId,
      score: a.score,
      selected: false
    }))
  ];
  return rows.slice(0, MAX_CANDIDATE_ROWS);
}

export function capCandidateEligibility(
  rows: ReadonlyArray<AutoCandidateEligibilityRow>
): AutoCandidateEligibilityRow[] {
  return rows.slice(0, MAX_CANDIDATE_ROWS).map((r) => ({
    strategyId: r.strategyId,
    eligible: r.eligible,
    rejectionReason: r.rejectionReason ? truncateReason(r.rejectionReason) : null
  }));
}

export function alternativeSignalsFromShadowCandidates(
  candidates: ReadonlyArray<{
    strategyId: string;
    action: string;
    entryReason: string[];
    shadowSignalEligible: boolean;
    forwardTrialBlocked: boolean;
    forwardTrialReason: string | null;
    repeatedSetup: boolean;
    isProductionSelected: boolean;
  }>
): AutoAlternativeSignalObservation[] {
  const out: AutoAlternativeSignalObservation[] = [];
  for (const c of candidates) {
    if (c.isProductionSelected) continue;
    if (c.action !== "BUY" && c.action !== "SELL") continue;
    out.push({
      strategyId: c.strategyId,
      action: c.action,
      entryReason: c.entryReason.slice(0, MAX_ALT_REASONS).map((r) => truncateReason(r, 120)),
      forwardTrialBlocked: c.forwardTrialBlocked,
      forwardTrialReason: c.forwardTrialReason,
      repeatedSetup: c.repeatedSetup
    });
  }
  return out.slice(0, 8);
}

/** Read decisionOutcome from DecisionLog.featureSummary for dashboard/API. */
export function decisionOutcomeFromFeatureSummary(summary: unknown): AutoDecisionOutcome | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const raw = (summary as { decisionOutcome?: unknown }).decisionOutcome;
  return isAutoDecisionOutcome(raw) ? raw : null;
}
