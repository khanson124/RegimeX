/**
 * Robust CFD parameter-selection objective (offline research only).
 *
 * Exact formula (documented):
 *
 * score =
 *   + 35 * clamp(expectancyR / 0.5, -1, 1.5) * sampleFactor
 *   + 20 * min((profitFactor - 1) / 0.5, 1.5)          // 0 when PF null/<1
 *   + 15 * sampleFactor                                 // trade-count confidence
 *   + 10 * consistencyBonus                             // neighborhood / window
 *   − 20 * (maxDrawdownPercent / maxDrawdownCap)
 *   − 15 * instabilityPenalty                           // 0–1
 *   − 10 * lowSamplePenalty                             // 1 when trades < minTrades
 *   − 10 * downsideVolPenalty                           // loss-streak / loss share
 *
 * Raw net profit / total return / win rate are NOT primary terms.
 */

export interface CfdObjectiveInput {
  expectancyR: number;
  profitFactor: number | null;
  trades: number;
  maxDrawdownPercent: number;
  /** 0–1 neighborhood or cross-window stability. */
  consistencyScore?: number;
  /** 0–1 parameter instability (1 = wild). */
  instabilityPenalty?: number;
  longestLossStreak?: number;
  winRate?: number;
}

export interface CfdObjectiveConfig {
  maxDrawdownCap: number;
  minTrades: number;
  weights: {
    expectancyR: number;
    profitFactor: number;
    sample: number;
    consistency: number;
    drawdown: number;
    instability: number;
    lowSample: number;
    downside: number;
  };
}

export const DEFAULT_CFD_OBJECTIVE_CONFIG: CfdObjectiveConfig = {
  maxDrawdownCap: 15,
  minTrades: 10,
  weights: {
    expectancyR: 35,
    profitFactor: 20,
    sample: 15,
    consistency: 10,
    drawdown: 20,
    instability: 15,
    lowSample: 10,
    downside: 10
  }
};

export interface CfdObjectiveResult {
  score: number;
  components: Record<string, number>;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function scoreCfdObjective(
  input: CfdObjectiveInput,
  config: CfdObjectiveConfig = DEFAULT_CFD_OBJECTIVE_CONFIG
): CfdObjectiveResult {
  const w = config.weights;
  const sampleFactor = clamp(input.trades / Math.max(config.minTrades * 2, 1), 0.1, 1);
  const components: Record<string, number> = {};

  const exp =
    w.expectancyR * clamp(input.expectancyR / 0.5, -1, 1.5) * sampleFactor;
  components.expectancyR = Number(exp.toFixed(2));

  const pf = input.profitFactor ?? 0;
  const pfTerm =
    pf >= 1 ? w.profitFactor * Math.min((pf - 1) / 0.5, 1.5) : w.profitFactor * Math.max(pf - 1, -1);
  components.profitFactor = Number(pfTerm.toFixed(2));

  const sample = w.sample * sampleFactor;
  components.sample = Number(sample.toFixed(2));

  const consistency = w.consistency * (input.consistencyScore ?? 0.5);
  components.consistency = Number(consistency.toFixed(2));

  const dd = w.drawdown * (input.maxDrawdownPercent / config.maxDrawdownCap);
  components.drawdown = Number((-dd).toFixed(2));

  const instability = w.instability * (input.instabilityPenalty ?? 0);
  components.instability = Number((-instability).toFixed(2));

  const lowSample = input.trades < config.minTrades ? w.lowSample : 0;
  components.lowSample = Number((-lowSample).toFixed(2));

  const lossShare = 1 - (input.winRate ?? 0.5);
  const streakPenalty = Math.min((input.longestLossStreak ?? 0) / 10, 1);
  const downside = w.downside * Math.max(lossShare * 0.5, streakPenalty);
  components.downside = Number((-downside).toFixed(2));

  const score =
    components.expectancyR +
    components.profitFactor +
    components.sample +
    components.consistency +
    components.drawdown +
    components.instability +
    components.lowSample +
    components.downside;

  return { score: Number(score.toFixed(2)), components };
}
