import { type EvidenceThresholds, DEFAULT_EVIDENCE_THRESHOLDS } from "./strategyLifecycle.js";

/**
 * Bounded 0–1 ranking score for opportunity ordering.
 * Never used to increase leverage, chase losses, or Martingale.
 */
export function rankEvidenceScore(input: {
  trades: number;
  expectancyR: number | null;
  profitFactor: number | null;
  maxDrawdownPercent: number;
  thresholds?: Partial<EvidenceThresholds>;
}): number {
  const t = { ...DEFAULT_EVIDENCE_THRESHOLDS, ...input.thresholds };
  if (input.trades < t.minTradesForTransition) return 0;

  const expectancy = input.expectancyR ?? 0;
  const pf = input.profitFactor ?? 0;
  const expectancyTerm = Math.max(0, Math.min(1, expectancy / Math.max(t.minExpectancyR * 4, 0.2)));
  const pfTerm = Math.max(0, Math.min(1, (pf - 1) / Math.max(t.minProfitFactor, 0.1)));
  const sampleTerm = Math.max(0, Math.min(1, input.trades / Math.max(t.minForwardTrades, 1)));
  const ddPenalty = Math.max(0, Math.min(1, input.maxDrawdownPercent / Math.max(t.maxDrawdownPercent, 1)));

  const raw = 0.4 * expectancyTerm + 0.3 * pfTerm + 0.3 * sampleTerm;
  return Number(Math.max(0, raw * (1 - 0.5 * ddPenalty)).toFixed(4));
}

export function hasPositiveExpectancyEvidence(input: {
  trades: number;
  expectancyR: number | null;
  profitFactor: number | null;
  thresholds?: Partial<EvidenceThresholds>;
}): boolean {
  const t = { ...DEFAULT_EVIDENCE_THRESHOLDS, ...input.thresholds };
  return (
    input.trades >= t.minForwardTrades &&
    (input.expectancyR ?? 0) > 0 &&
    input.profitFactor != null &&
    input.profitFactor >= t.minProfitFactor
  );
}
