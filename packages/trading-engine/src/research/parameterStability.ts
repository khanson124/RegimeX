import { type CandidateResult } from "../optimize/gridSearch.js";

export type ParameterSet = Record<string, number | boolean>;

/**
 * Fraction of single-parameter neighbors with positive OOS net profit.
 * Re-exported from grid search logic for research reporting.
 */
export function neighborhoodStabilityScore(
  candidate: CandidateResult,
  all: ReadonlyArray<CandidateResult>
): number {
  const keys = Object.keys(candidate.parameters);
  const neighbors = all.filter((other) => {
    if (other === candidate) return false;
    let diffs = 0;
    for (const k of keys) {
      if (other.parameters[k] !== candidate.parameters[k]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  });
  if (neighbors.length === 0) return 0.5;
  const positive = neighbors.filter((n) => n.testNetProfit > 0).length;
  return positive / neighbors.length;
}

export interface ParameterStabilityReport {
  score: number;
  level: "LOW" | "MEDIUM" | "HIGH";
  neighborCount: number;
  positiveNeighborCount: number;
}

export function buildParameterStabilityReport(
  candidate: CandidateResult,
  all: ReadonlyArray<CandidateResult>
): ParameterStabilityReport {
  const score = neighborhoodStabilityScore(candidate, all);
  const keys = Object.keys(candidate.parameters);
  const neighbors = all.filter((other) => {
    if (other === candidate) return false;
    let diffs = 0;
    for (const k of keys) {
      if (other.parameters[k] !== candidate.parameters[k]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  });
  const positiveNeighborCount = neighbors.filter((n) => n.testNetProfit > 0).length;
  return {
    score,
    level: score >= 0.7 ? "HIGH" : score >= 0.4 ? "MEDIUM" : "LOW",
    neighborCount: neighbors.length,
    positiveNeighborCount
  };
}
