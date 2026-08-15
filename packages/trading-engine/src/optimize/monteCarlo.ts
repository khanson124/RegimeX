/**
 * Monte Carlo analysis interface — implementation is a later phase, but the
 * contract is prepared so callers can integrate now.
 */
export interface MonteCarloInput {
  /** Per-trade profits in original chronological order. */
  tradeProfits: ReadonlyArray<number>;
  startingBalance: number;
  iterations: number;
  /** Seed for a deterministic PRNG (results must be reproducible). */
  seed: number;
}

export interface MonteCarloResult {
  drawdownDistribution: { p50: number; p90: number; p99: number };
  probabilityOfRuin: number;
  expectedWorstLosingStreak: number;
}

export interface MonteCarloAnalyzer {
  analyze(input: MonteCarloInput): MonteCarloResult;
}
