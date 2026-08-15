/**
 * Grid-search parameter optimizer utilities. Job orchestration (queueing,
 * concurrency, cancellation) lives in the worker; this module owns the pure
 * combinatorics and ranking logic so it can be unit tested.
 */

export type ParameterSpace = Record<string, ReadonlyArray<number | boolean>>;

/** Count combinations WITHOUT generating them — used for the safety guard. */
export function countCombinations(space: ParameterSpace): number {
  return Object.values(space).reduce((acc, values) => acc * values.length, 1);
}

/** Generate all combinations deterministically (stable key order). */
export function generateCombinations(
  space: ParameterSpace
): Array<Record<string, number | boolean>> {
  const keys = Object.keys(space).sort();
  let combos: Array<Record<string, number | boolean>> = [{}];
  for (const key of keys) {
    const values = space[key]!;
    const next: Array<Record<string, number | boolean>> = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }
  return combos;
}

export interface CandidateResult {
  parameters: Record<string, number | boolean>;
  trainNetProfit: number;
  trainProfitFactor: number | null;
  trainTrades: number;
  testNetProfit: number;
  testProfitFactor: number | null;
  testTrades: number;
  testExpectancy: number;
  maxDrawdownPercent: number;
}

export interface RankedCandidate extends CandidateResult {
  score: number;
  stabilityScore: number;
  overfitWarning: boolean;
}

/**
 * Rank candidates using out-of-sample results, penalizing candidates whose
 * test performance collapses relative to train performance (overfitting)
 * and rewarding neighborhood stability (candidates whose parameter-space
 * neighbors also perform well).
 */
export function rankCandidates(candidates: ReadonlyArray<CandidateResult>): RankedCandidate[] {
  const ranked = candidates.map((c) => {
    const trainPf = c.trainProfitFactor ?? 0;
    const testPf = c.testProfitFactor ?? 0;
    const degradation = trainPf > 0 ? testPf / trainPf : 0;
    const overfitWarning = c.trainNetProfit > 0 && (c.testNetProfit <= 0 || degradation < 0.5);

    const stabilityScore = neighborhoodStability(c, candidates);

    let score = 0;
    score += Math.min(Math.max(c.testExpectancy / 0.1, -1), 2) * 30;
    score += Math.min(testPf, 3) * 15;
    score += stabilityScore * 20;
    score -= (c.maxDrawdownPercent / 10) * 10;
    if (overfitWarning) score -= 30;
    if (c.testTrades < 10) score -= 20;

    return {
      ...c,
      score: Number(score.toFixed(2)),
      stabilityScore: Number(stabilityScore.toFixed(3)),
      overfitWarning
    };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Stability = fraction of "neighbor" candidates (differing in exactly one
 * parameter) that also have positive out-of-sample net profit. Candidates
 * that only work with one exact parameter combination score near 0.
 */
function neighborhoodStability(
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
  if (neighbors.length === 0) return 0.5; // unknown, neutral
  const positive = neighbors.filter((n) => n.testNetProfit > 0).length;
  return positive / neighbors.length;
}
