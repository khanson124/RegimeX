import {
  type MarketRegime,
  type ResearchVerdict,
  type StrategySelectionAlternative,
  type StrategySelectionResult,
  DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS,
  type ResearchSampleRequirements
} from "@regimex/shared";
import { type TradingStrategy } from "../strategies/types.js";
import { resolveSampleConfidence } from "./sampleConfidence.js";
import { performanceMatchesConfig } from "./strategyVersioning.js";

/**
 * Validated, scoped historical performance for one strategy.
 * Must not mix incompatible symbols/intervals into one record.
 *
 * Binary research may populate expectancy (currency).
 * CFD research should populate expectancyR / averageR (netR preferred).
 */
export interface StrategyPerformanceRecord {
  strategyId: string;
  regime: MarketRegime;
  trades: number;
  profitFactor: number | null;
  /** Currency expectancy (legacy binary) or unused when expectancyR is set. */
  expectancy: number;
  outOfSampleExpectancy: number | null;
  winRate: number;
  maxDrawdownPercent: number;
  recentExpectancy: number | null;
  sharpeLike: number | null;
  stabilityScore: number | null;
  /** Scope */
  symbol?: string;
  interval?: string;
  executionModel?: "cfd_v1" | "rise_fall_v1";
  strategyVersion?: string;
  /** Must match live strategy config hash or evidence is ignored. */
  configHash?: string | null;
  /** CFD: netR expectancy (prefer for scoring). */
  expectancyR?: number | null;
  averageR?: number | null;
  averageGrossR?: number | null;
  researchVerdict?: ResearchVerdict | null;
  confidenceScore?: number | null;
  degradationPercent?: number | null;
  forwardTradeCount?: number;
  recentForwardExpectancyR?: number | null;
  updatedAt?: number;
  /** Milestone 4: multi-window OOS aggregates */
  medianExpectancyR?: number | null;
  percentPositiveExpectancyWindows?: number | null;
  walkForwardWindowCount?: number | null;
  holdoutExpectancyR?: number | null;
  parameterStabilityLevel?: string | null;
  promotionEligibility?: string | null;
  singleWindowDominated?: boolean | null;
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
  /** CFD / validated extras */
  sampleConfidence: number;
  researchVerdict: number;
  forwardPaper: number;
  degradationPenalty: number;
}

export interface SelectionFilters {
  minTrades: number;
  minProfitFactor: number;
  maxDrawdownPercent: number;
  requirePositiveExpectancy: boolean;
  requirePositiveOutOfSampleExpectancy: boolean;
  minRegimeSampleSize: number;
  recentPerformanceFloor: number;
  minRegimeConfidence: number;
  /** CFD: reject when expectancyR below this (e.g. -0.05). */
  minExpectancyR: number;
  /** Exclude NO_EDGE_DETECTED verdicts from execution. */
  excludeNoEdge: boolean;
  /** Exclude DEGRADING when degradationPercent exceeds this (0–100). */
  maxDegradationPercent: number;
}

export interface SelectionConfig {
  weights: SelectionWeights;
  filters: SelectionFilters;
  /**
   * VALIDATED: evidence influences ranking; missing evidence → bootstrap fallback
   * when no candidate qualifies, or per-candidate bootstrap if mode is hybrid.
   * BOOTSTRAP: regime-fit only.
   */
  mode: "VALIDATED" | "BOOTSTRAP";
  sampleRequirements?: ResearchSampleRequirements;
  /** When VALIDATED and nothing qualifies, fall back to BOOTSTRAP scoring. */
  bootstrapFallback: boolean;
}

/**
 * Validated selection formula (documented):
 *
 * score =
 *   + regimeFitWeight        * regimeFitNorm           (0–1)
 *   + expectancyWeight       * clamp(E / scale, -1, 1.5) * sampleConfidence
 *       where E = expectancyR if set else expectancy; scale = 0.5R or 0.1 currency
 *   + profitFactorWeight     * min((pf-1)/0.5, 1.5)
 *   + sampleConfidenceWeight * sampleConfidence
 *   + researchVerdictWeight  * verdictBonus (PROMISING 0.6, ROBUST 1.0, else 0)
 *   + forwardPaperWeight     * clamp(fwdER/0.3,-1,1.5) * forwardSampleFactor
 *   + winRateWeight          * winRate
 *   + recentPerformanceWeight * recentRatio (capped)
 *   − drawdownPenalty        * (ddPct / maxDd)
 *   − degradationPenalty     * min(degradationPercent/100, 1)
 *   − instability / overfitting / insufficient-sample penalties (legacy)
 *
 * Raw total return is never a scoring input.
 */
export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  weights: {
    profitFactor: 15,
    expectancy: 25,
    sharpeLike: 5,
    winRate: 5,
    recentPerformance: 8,
    regimeFit: 15,
    maxDrawdownPenalty: 15,
    instabilityPenalty: 8,
    overfittingPenalty: 8,
    insufficientSamplePenalty: 8,
    sampleConfidence: 15,
    researchVerdict: 10,
    forwardPaper: 10,
    degradationPenalty: 10
  },
  filters: {
    minTrades: 20,
    minProfitFactor: 1.05,
    maxDrawdownPercent: 15,
    requirePositiveExpectancy: true,
    requirePositiveOutOfSampleExpectancy: true,
    minRegimeSampleSize: 10,
    recentPerformanceFloor: 0.5,
    minRegimeConfidence: 0.5,
    minExpectancyR: -0.05,
    excludeNoEdge: true,
    maxDegradationPercent: 50
  },
  mode: "VALIDATED",
  bootstrapFallback: true,
  sampleRequirements: DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
};

export interface SelectionCandidate {
  strategy: TradingStrategy;
  enabled: boolean;
  performance: StrategyPerformanceRecord | null;
  /** Expected live config hash; stale performance is ignored when mismatched. */
  expectedConfigHash?: string | null;
}

interface ScoredCandidate {
  strategyId: string;
  score: number;
  reasons: string[];
  componentScores: Record<string, number>;
  usedBootstrap: boolean;
}

/**
 * Decides which strategy (if any) should act in the current regime.
 * Never selects on raw profit alone; uses a composite score with
 * drawdown/sample/degradation penalties and hard eligibility gates.
 */
export class StrategySelectionService {
  constructor(private readonly config: SelectionConfig = DEFAULT_SELECTION_CONFIG) {}

  select(
    regime: MarketRegime,
    regimeConfidence: number,
    candidates: ReadonlyArray<SelectionCandidate>
  ): StrategySelectionResult {
    const { filters } = this.config;
    const eligibilityRejections: string[] = [];

    if (regime === "UNKNOWN" || regime === "TRANSITION") {
      return this.noStrategy(regime, [`Regime ${regime} is not tradable`], "BOOTSTRAP");
    }
    if (regimeConfidence < filters.minRegimeConfidence) {
      return this.noStrategy(
        regime,
        [
          `Regime confidence ${regimeConfidence.toFixed(2)} below minimum ${filters.minRegimeConfidence}`
        ],
        this.config.mode
      );
    }

    const scored: ScoredCandidate[] = [];
    for (const candidate of candidates) {
      const result = this.scoreCandidate(candidate, regime, regimeConfidence, eligibilityRejections);
      if (result) scored.push(result);
    }

    let effectiveMode: "BOOTSTRAP" | "VALIDATED" = this.config.mode;
    if (scored.length === 0 && this.config.mode === "VALIDATED" && this.config.bootstrapFallback) {
      effectiveMode = "BOOTSTRAP";
      for (const candidate of candidates) {
        const result = this.scoreCandidate(
          candidate,
          regime,
          regimeConfidence,
          eligibilityRejections,
          "BOOTSTRAP"
        );
        if (result) scored.push(result);
      }
      if (scored.length > 0) {
        eligibilityRejections.push(
          "VALIDATED mode found no eligible evidence — fell back to BOOTSTRAP (regime fit)"
        );
      }
    }

    if (scored.length === 0) {
      return this.noStrategy(
        regime,
        ["No strategy passed eligibility and validation filters", ...eligibilityRejections.slice(0, 5)],
        effectiveMode,
        eligibilityRejections
      );
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    const alternatives: StrategySelectionAlternative[] = scored.slice(1).map((s) => ({
      strategyId: s.strategyId,
      score: Number(s.score.toFixed(1)),
      componentScores: s.componentScores
    }));

    const modeLabel = best.usedBootstrap ? "BOOTSTRAP" : effectiveMode;
    return {
      selectedStrategyId: best.strategyId,
      regime,
      selectionScore: Number(best.score.toFixed(1)),
      confidence: Number(Math.min(best.score / 100, 0.99).toFixed(2)),
      alternatives,
      reasons: [...best.reasons],
      selectionMode: modeLabel,
      componentScores: best.componentScores,
      eligibilityRejections
    };
  }

  private scoreCandidate(
    candidate: SelectionCandidate,
    regime: MarketRegime,
    _regimeConfidence: number,
    eligibilityRejections: string[],
    forceMode?: "BOOTSTRAP" | "VALIDATED"
  ): ScoredCandidate | null {
    const { strategy, enabled, performance, expectedConfigHash } = candidate;
    const { weights, filters } = this.config;
    const mode = forceMode ?? this.config.mode;

    if (!enabled) return null;
    if (!strategy.supportedRegimes.includes(regime)) {
      eligibilityRejections.push(`${strategy.id}: regime-incompatible with ${regime}`);
      return null;
    }

    const reasons: string[] = [`Supports regime ${regime}`];
    const componentScores: Record<string, number> = {};
    const regimeFit =
      1 / strategy.supportedRegimes.length + (strategy.supportedRegimes[0] === regime ? 0.25 : 0);
    const regimeFitScore = weights.regimeFit * regimeFit * 2;
    componentScores.regimeFit = Number(regimeFitScore.toFixed(2));

    let perf = performance;
    if (perf && !performanceMatchesConfig(perf.configHash, expectedConfigHash)) {
      eligibilityRejections.push(
        `${strategy.id}: performance config hash mismatch — stale evidence ignored`
      );
      perf = null;
    }

    if (!perf || perf.trades === 0) {
      if (mode === "VALIDATED" && !forceMode) return null;
      const score = 40 + weights.regimeFit * regimeFit;
      return {
        strategyId: strategy.id,
        score,
        reasons: [...reasons, "No validated history yet (bootstrap mode)"],
        componentScores: { ...componentScores, bootstrap: Number(score.toFixed(2)) },
        usedBootstrap: true
      };
    }

    // ---- Eligibility gates (fail closed) ----
    if (filters.excludeNoEdge && perf.researchVerdict === "NO_EDGE_DETECTED") {
      eligibilityRejections.push(`${strategy.id}: research verdict NO_EDGE_DETECTED — execution ineligible`);
      return null;
    }
    if (
      perf.researchVerdict === "DEGRADING" &&
      (perf.degradationPercent ?? 0) >= filters.maxDegradationPercent
    ) {
      eligibilityRejections.push(
        `${strategy.id}: severe degradation ${perf.degradationPercent?.toFixed(0)}% — execution ineligible`
      );
      return null;
    }
    if (perf.expectancyR != null && perf.expectancyR < filters.minExpectancyR) {
      eligibilityRejections.push(
        `${strategy.id}: expectancyR ${perf.expectancyR.toFixed(3)} below minimum ${filters.minExpectancyR}`
      );
      return null;
    }

    if (mode === "VALIDATED") {
      if (perf.trades < filters.minTrades) {
        eligibilityRejections.push(
          `${strategy.id}: trades ${perf.trades} < min ${filters.minTrades}`
        );
        return null;
      }
      if (perf.trades < filters.minRegimeSampleSize) return null;
      if (perf.profitFactor !== null && perf.profitFactor < filters.minProfitFactor) {
        eligibilityRejections.push(
          `${strategy.id}: profit factor ${perf.profitFactor.toFixed(2)} < ${filters.minProfitFactor}`
        );
        return null;
      }
      if (perf.maxDrawdownPercent > filters.maxDrawdownPercent) {
        eligibilityRejections.push(`${strategy.id}: drawdown exceeds limit`);
        return null;
      }
      const primaryExpectancy = perf.expectancyR ?? perf.expectancy;
      if (filters.requirePositiveExpectancy && primaryExpectancy <= 0) {
        eligibilityRejections.push(`${strategy.id}: non-positive expectancy`);
        return null;
      }
      if (
        filters.requirePositiveOutOfSampleExpectancy &&
        perf.outOfSampleExpectancy !== null &&
        perf.outOfSampleExpectancy <= 0
      ) {
        eligibilityRejections.push(`${strategy.id}: non-positive out-of-sample expectancy`);
        return null;
      }
      if (
        perf.recentExpectancy !== null &&
        perf.expectancy > 0 &&
        perf.expectancyR == null &&
        perf.recentExpectancy < perf.expectancy * filters.recentPerformanceFloor
      ) {
        eligibilityRejections.push(`${strategy.id}: recent performance below floor`);
        return null;
      }
    }

    const sample = resolveSampleConfidence(
      perf.trades,
      this.config.sampleRequirements ?? DEFAULT_RESEARCH_SAMPLE_REQUIREMENTS
    );
    componentScores.sampleConfidence = Number((weights.sampleConfidence * sample.score).toFixed(2));
    reasons.push(...sample.reasons);

    // Tiny samples must not dominate: expectancy contribution is scaled by sample confidence.
    let score = regimeFitScore;
    score += componentScores.sampleConfidence;

    const pf = perf.profitFactor ?? 1;
    const pfScore = weights.profitFactor * Math.min((pf - 1) / 0.5, 1.5);
    componentScores.profitFactor = Number(pfScore.toFixed(2));
    score += pfScore;

    const useR = perf.expectancyR != null;
    const expRaw = useR ? perf.expectancyR! : perf.expectancy;
    const expScale = useR ? 0.5 : 0.1;
    // Cap how much extreme expectancy can contribute on weak/moderate samples
    // so a tiny +5R run cannot dominate a large stable sample.
    const expCap =
      sample.band === "STRONG" ? 1.5 : sample.band === "MODERATE" ? 0.75 : 0.4;
    const expScore =
      weights.expectancy *
      Math.min(Math.max(expRaw / expScale, -1), expCap) *
      sample.score;
    componentScores.expectancy = Number(expScore.toFixed(2));
    score += expScore;

    if (perf.sharpeLike !== null) {
      const sh = weights.sharpeLike * Math.min(Math.max(perf.sharpeLike, -1), 1.5);
      componentScores.sharpeLike = Number(sh.toFixed(2));
      score += sh;
    }

    const wr = weights.winRate * perf.winRate;
    componentScores.winRate = Number(wr.toFixed(2));
    score += wr;

    if (perf.recentExpectancy !== null && (useR ? (perf.expectancyR ?? 0) > 0 : perf.expectancy > 0)) {
      const base = useR ? Math.max(perf.expectancyR ?? 0.01, 0.01) : Math.max(perf.expectancy, 0.01);
      const recent = weights.recentPerformance * Math.min(perf.recentExpectancy / base, 1.5);
      componentScores.recentPerformance = Number(recent.toFixed(2));
      score += recent;
    }

    // Research verdict bonus (never selects NO_EDGE — gated above)
    let verdictBonus = 0;
    if (perf.researchVerdict === "ROBUST") verdictBonus = 1;
    else if (perf.researchVerdict === "PROMISING") verdictBonus = 0.6;
    else if (perf.researchVerdict === "INSUFFICIENT_EVIDENCE") verdictBonus = 0.2;
    const verdictScore = weights.researchVerdict * verdictBonus;
    componentScores.researchVerdict = Number(verdictScore.toFixed(2));
    score += verdictScore;

    // Forward-paper (engine CFD closes only — caller must filter manuals)
    const fwdCount = perf.forwardTradeCount ?? 0;
    const fwdEr = perf.recentForwardExpectancyR;
    if (fwdCount > 0 && fwdEr != null) {
      const fwdSample = resolveSampleConfidence(fwdCount).score;
      const fwd =
        weights.forwardPaper * Math.min(Math.max(fwdEr / 0.3, -1), 1.5) * fwdSample;
      componentScores.forwardValidation = Number(fwd.toFixed(2));
      score += fwd;
      reasons.push(`Forward-paper ${fwdCount} trades, expectancyR ${fwdEr.toFixed(3)}`);
    } else {
      componentScores.forwardValidation = 0;
    }

    const ddPenalty =
      weights.maxDrawdownPenalty * (perf.maxDrawdownPercent / filters.maxDrawdownPercent);
    componentScores.drawdownPenalty = Number((-ddPenalty).toFixed(2));
    score -= ddPenalty;

    if (perf.degradationPercent != null && perf.degradationPercent > 0) {
      const deg =
        weights.degradationPenalty * Math.min(perf.degradationPercent / 100, 1);
      componentScores.degradationPenalty = Number((-deg).toFixed(2));
      score -= deg;
      reasons.push(`Degradation penalty ${perf.degradationPercent.toFixed(0)}%`);
    }

    if (perf.stabilityScore !== null) {
      score -= weights.instabilityPenalty * (1 - perf.stabilityScore);
      if (perf.stabilityScore < 0.4) {
        score -= weights.overfittingPenalty;
        reasons.push("Overfitting penalty applied (low stability score)");
      }
    }

    const sampleRatio = Math.min(perf.trades / (filters.minTrades * 2), 1);
    score -= weights.insufficientSamplePenalty * (1 - sampleRatio);

    // Prefer strategies with consistent multi-window OOS when available
    if (perf.percentPositiveExpectancyWindows != null) {
      const consistency =
        weights.sampleConfidence * 0.35 * Math.min(1, Math.max(0, perf.percentPositiveExpectancyWindows));
      componentScores.windowConsistency = Number(consistency.toFixed(2));
      score += consistency;
      if (perf.singleWindowDominated) {
        score -= weights.degradationPenalty * 0.5;
        componentScores.singleWindowPenalty = Number((-weights.degradationPenalty * 0.5).toFixed(2));
        reasons.push("Single-window dominance penalty applied");
      }
    }

    if (perf.holdoutExpectancyR != null && perf.holdoutExpectancyR < 0) {
      score -= weights.degradationPenalty * 0.4;
      reasons.push(`Holdout expectancyR ${perf.holdoutExpectancyR.toFixed(3)} penalty`);
    }

    reasons.push(
      `Profit factor ${pf.toFixed(2)} over ${perf.trades} trades`,
      useR
        ? `ExpectancyR ${expRaw.toFixed(3)} (netR, sample-weighted)`
        : `Expectancy ${expRaw.toFixed(3)} per trade`,
      `Max drawdown ${perf.maxDrawdownPercent.toFixed(1)}%`,
      perf.researchVerdict ? `Research verdict ${perf.researchVerdict}` : "No research verdict yet"
    );

    // Human-readable component summary for UI/logs
    reasons.unshift(
      `${strategy.id} selected components: ` +
        Object.entries(componentScores)
          .map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`)
          .join(", ")
    );

    return {
      strategyId: strategy.id,
      score: Math.max(score, 0),
      reasons,
      componentScores,
      usedBootstrap: false
    };
  }

  private noStrategy(
    regime: MarketRegime,
    reasons: string[],
    selectionMode: "BOOTSTRAP" | "VALIDATED",
    eligibilityRejections: string[] = []
  ): StrategySelectionResult {
    return {
      selectedStrategyId: null,
      regime,
      selectionScore: null,
      confidence: null,
      alternatives: [],
      reasons,
      selectionMode,
      componentScores: null,
      eligibilityRejections
    };
  }
}
