import {
  type MarketRegime,
  type StrategySelectionAlternative,
  type StrategySelectionResult
} from "@regimex/shared";
import { type TradingStrategy } from "../strategies/types.js";

/**
 * Validated, regime-specific historical performance for one strategy.
 * Produced by backtests; null metrics mean "not yet measured".
 */
export interface StrategyPerformanceRecord {
  strategyId: string;
  regime: MarketRegime;
  trades: number;
  profitFactor: number | null;
  expectancy: number;
  outOfSampleExpectancy: number | null;
  winRate: number;
  maxDrawdownPercent: number;
  /** Expectancy over the most recent window of trades. */
  recentExpectancy: number | null;
  /** Mean/stddev of per-trade returns; crude Sharpe-like ratio. */
  sharpeLike: number | null;
  /** 0-1; penalizes parameter-sensitive or window-sensitive results. */
  stabilityScore: number | null;
}

export interface SelectionWeights {
  profitFactor: number;
  expectancy: number;
  sharpeLike: number;
  winRate: number;
  recentPerformance: number;
  regimeFit: number;
  maxDrawdownPenalty: number;
  instabilityPenalty: number;
  overfittingPenalty: number;
  insufficientSamplePenalty: number;
}

export interface SelectionFilters {
  minTrades: number;
  minProfitFactor: number;
  maxDrawdownPercent: number;
  requirePositiveExpectancy: boolean;
  requirePositiveOutOfSampleExpectancy: boolean;
  minRegimeSampleSize: number;
  /** Recent expectancy must be >= this fraction of historical expectancy. */
  recentPerformanceFloor: number;
  minRegimeConfidence: number;
}

export interface SelectionConfig {
  weights: SelectionWeights;
  filters: SelectionFilters;
  /**
   * VALIDATED: strategies without qualifying history are excluded (live default).
   * BOOTSTRAP: strategies without history get a neutral score derived from
   * regime fit only — used inside backtests before history exists.
   */
  mode: "VALIDATED" | "BOOTSTRAP";
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  weights: {
    profitFactor: 20,
    expectancy: 20,
    sharpeLike: 10,
    winRate: 10,
    recentPerformance: 10,
    regimeFit: 15,
    maxDrawdownPenalty: 15,
    instabilityPenalty: 10,
    overfittingPenalty: 10,
    insufficientSamplePenalty: 10
  },
  filters: {
    minTrades: 30,
    minProfitFactor: 1.05,
    maxDrawdownPercent: 15,
    requirePositiveExpectancy: true,
    requirePositiveOutOfSampleExpectancy: true,
    minRegimeSampleSize: 10,
    recentPerformanceFloor: 0.5,
    minRegimeConfidence: 0.5
  },
  mode: "VALIDATED"
};

export interface SelectionCandidate {
  strategy: TradingStrategy;
  enabled: boolean;
  performance: StrategyPerformanceRecord | null;
}

interface ScoredCandidate {
  strategyId: string;
  score: number;
  reasons: string[];
}

/**
 * Decides which strategy (if any) should act in the current regime.
 * Never selects on raw profit alone; uses a composite score with
 * drawdown/instability/overfitting penalties and hard filters.
 * Returns NO_STRATEGY (null id) when nothing qualifies.
 */
export class StrategySelectionService {
  constructor(private readonly config: SelectionConfig = DEFAULT_SELECTION_CONFIG) {}

  select(
    regime: MarketRegime,
    regimeConfidence: number,
    candidates: ReadonlyArray<SelectionCandidate>
  ): StrategySelectionResult {
    const { filters } = this.config;
    const reasons: string[] = [];

    if (regime === "UNKNOWN" || regime === "TRANSITION") {
      return this.noStrategy(regime, [`Regime ${regime} is not tradable`]);
    }
    if (regimeConfidence < filters.minRegimeConfidence) {
      return this.noStrategy(regime, [
        `Regime confidence ${regimeConfidence.toFixed(2)} below minimum ${filters.minRegimeConfidence}`
      ]);
    }

    const scored: ScoredCandidate[] = [];
    for (const candidate of candidates) {
      const result = this.scoreCandidate(candidate, regime, regimeConfidence);
      if (result) scored.push(result);
    }

    if (scored.length === 0) {
      return this.noStrategy(regime, ["No strategy passed eligibility and validation filters"]);
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    const alternatives: StrategySelectionAlternative[] = scored
      .slice(1)
      .map((s) => ({ strategyId: s.strategyId, score: Number(s.score.toFixed(1)) }));

    return {
      selectedStrategyId: best.strategyId,
      regime,
      selectionScore: Number(best.score.toFixed(1)),
      confidence: Number(Math.min(best.score / 100, 0.99).toFixed(2)),
      alternatives,
      reasons: [...best.reasons, ...reasons]
    };
  }

  private scoreCandidate(
    candidate: SelectionCandidate,
    regime: MarketRegime,
    _regimeConfidence: number
  ): ScoredCandidate | null {
    const { strategy, enabled, performance } = candidate;
    const { weights, filters, mode } = this.config;

    if (!enabled) return null;
    if (!strategy.supportedRegimes.includes(regime)) return null;

    const reasons: string[] = [`Supports regime ${regime}`];
    // Regime-fit component: how central this regime is to the strategy design.
    const regimeFit = 1 / strategy.supportedRegimes.length + (strategy.supportedRegimes[0] === regime ? 0.25 : 0);

    if (!performance || performance.trades === 0) {
      if (mode === "VALIDATED") return null;
      // BOOTSTRAP: neutral score from regime fit only.
      return {
        strategyId: strategy.id,
        score: 40 + weights.regimeFit * regimeFit,
        reasons: [...reasons, "No validated history yet (bootstrap mode)"]
      };
    }

    // ---- Hard filters ----
    if (performance.trades < filters.minTrades) return null;
    if (performance.trades < filters.minRegimeSampleSize) return null;
    if (performance.profitFactor !== null && performance.profitFactor < filters.minProfitFactor) return null;
    if (performance.maxDrawdownPercent > filters.maxDrawdownPercent) return null;
    if (filters.requirePositiveExpectancy && performance.expectancy <= 0) return null;
    if (
      filters.requirePositiveOutOfSampleExpectancy &&
      performance.outOfSampleExpectancy !== null &&
      performance.outOfSampleExpectancy <= 0
    ) {
      return null;
    }
    if (
      performance.recentExpectancy !== null &&
      performance.expectancy > 0 &&
      performance.recentExpectancy < performance.expectancy * filters.recentPerformanceFloor
    ) {
      return null;
    }

    // ---- Composite score ----
    let score = 0;
    const pf = performance.profitFactor ?? 1;
    score += weights.profitFactor * Math.min((pf - 1) / 0.5, 1.5);
    score += weights.expectancy * Math.min(Math.max(performance.expectancy / 0.1, -1), 1.5);
    if (performance.sharpeLike !== null) {
      score += weights.sharpeLike * Math.min(Math.max(performance.sharpeLike, -1), 1.5);
    }
    score += weights.winRate * performance.winRate;
    if (performance.recentExpectancy !== null && performance.expectancy > 0) {
      score += weights.recentPerformance * Math.min(performance.recentExpectancy / performance.expectancy, 1.5);
    }
    score += weights.regimeFit * regimeFit * 2;

    // Penalties
    score -= weights.maxDrawdownPenalty * (performance.maxDrawdownPercent / filters.maxDrawdownPercent);
    if (performance.stabilityScore !== null) {
      score -= weights.instabilityPenalty * (1 - performance.stabilityScore);
      if (performance.stabilityScore < 0.4) {
        score -= weights.overfittingPenalty;
        reasons.push("Overfitting penalty applied (low stability score)");
      }
    }
    const sampleRatio = Math.min(performance.trades / (filters.minTrades * 2), 1);
    score -= weights.insufficientSamplePenalty * (1 - sampleRatio);

    reasons.push(
      `Profit factor ${pf.toFixed(2)} over ${performance.trades} trades`,
      `Expectancy ${performance.expectancy.toFixed(3)} per trade`,
      `Max drawdown ${performance.maxDrawdownPercent.toFixed(1)}% within limit`,
      performance.outOfSampleExpectancy !== null
        ? `Out-of-sample expectancy ${performance.outOfSampleExpectancy.toFixed(3)}`
        : "Out-of-sample expectancy not yet measured"
    );

    return { strategyId: strategy.id, score: Math.max(score, 0), reasons };
  }

  private noStrategy(regime: MarketRegime, reasons: string[]): StrategySelectionResult {
    return {
      selectedStrategyId: null,
      regime,
      selectionScore: null,
      confidence: null,
      alternatives: [],
      reasons
    };
  }
}
