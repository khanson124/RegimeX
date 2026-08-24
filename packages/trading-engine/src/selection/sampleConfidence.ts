/**
 * Sample-size confidence for CFD strategy selection.
 * Reuses research evaluation thresholds conceptually:
 *   < minimumTradesForEvaluation → insufficient
 *   < minimumOosTrades → weak
 *   < minimumTradesForValid → moderate
 *   ≥ minimumTradesForValid → stronger
 */

import {
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS,
  type ResearchSampleRequirements
} from "@regimex/shared";

export type SampleConfidenceBand = "INSUFFICIENT" | "WEAK" | "MODERATE" | "STRONG";

export interface SampleConfidenceResult {
  band: SampleConfidenceBand;
  /** 0–1 multiplier used in validated scoring. */
  score: number;
  trades: number;
  reasons: string[];
}

export function resolveSampleConfidence(
  trades: number,
  requirements: ResearchSampleRequirements = DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
): SampleConfidenceResult {
  const reasons: string[] = [];
  if (trades < requirements.minimumTradesForEvaluation) {
    reasons.push(
      `Sample ${trades} < evaluation minimum ${requirements.minimumTradesForEvaluation} (insufficient)`
    );
    return { band: "INSUFFICIENT", score: 0.1, trades, reasons };
  }
  if (trades < requirements.minimumOosTrades) {
    reasons.push(
      `Sample ${trades} < OOS minimum ${requirements.minimumOosTrades} (weak evidence)`
    );
    return { band: "WEAK", score: 0.35, trades, reasons };
  }
  if (trades < requirements.minimumTradesForValid) {
    const t = trades - requirements.minimumOosTrades;
    const span = Math.max(1, requirements.minimumTradesForValid - requirements.minimumOosTrades);
    const score = 0.45 + 0.25 * Math.min(1, t / span);
    reasons.push(`Sample ${trades} is moderate (below valid threshold ${requirements.minimumTradesForValid})`);
    return { band: "MODERATE", score: Number(score.toFixed(3)), trades, reasons };
  }
  const extra = trades - requirements.minimumTradesForValid;
  const score = Math.min(1, 0.75 + extra / 400);
  reasons.push(`Sample ${trades} meets valid threshold (stronger evidence)`);
  return { band: "STRONG", score: Number(score.toFixed(3)), trades, reasons };
}
