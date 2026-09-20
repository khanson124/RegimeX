/**
 * Opt-in AUTO multi-strategy shadow evaluation.
 *
 * Evaluates every production-eligible strategy on the same closed-candle context
 * as the production winner evaluation. Results are observational only:
 * - never create executable intents
 * - never submit to brokers / MT5
 * - never mutate production cooldown / selection
 *
 * Signal eligibility (strategy action + forward-trial annotation) is intentionally
 * separated from full risk / volume / quote / capacity / broker readiness, which
 * shadow mode does not assess.
 */
import {
  type MarketRegime,
  type StrategyDecision,
  type StrategySelectionResult
} from "@regimex/shared";
import { type StrategyContext, type TradingStrategy } from "../strategies/types.js";
import { replayForwardTrialBlockReason } from "../research/autoSelectionCounterfactualReplay.js";

export type AutoShadowForwardTrialChecker = (input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
}) => string | null;

export interface AutoShadowEligibleStrategy {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
}

export interface AutoShadowCandidateResult {
  strategyId: string;
  /** 1 = production selected winner; 2..n = selection alternatives by descending score; null = not scored. */
  rank: number | null;
  selectionScore: number | null;
  action: StrategyDecision["action"];
  confidence: number;
  entryReason: string[];
  invalidationReason: string[];
  candlesSinceLastSignal: number;
  /** Strategy emitted BUY/SELL and is not blocked by known forward-trial guards. */
  shadowSignalEligible: boolean;
  forwardTrialBlocked: boolean;
  forwardTrialReason: string | null;
  /**
   * Full execution readiness is never claimed by shadow mode.
   * Always NOT_ASSESSED — risk, volume, quotes, capacity, and broker gates are out of scope.
   */
  executionReadiness: "NOT_ASSESSED";
  /** True when this strategy also produced an alternative BUY/SELL on the prior shadow bar. */
  repeatedSetup: boolean;
  isProductionSelected: boolean;
}

export interface AutoShadowEvaluationReport {
  timestampMs: number;
  openTimeMs: number;
  candleIndex: number;
  symbol: string;
  interval: string;
  regime: MarketRegime;
  regimeConfidence: number;
  selectionMode: string | null;
  production: {
    selectedStrategyId: string | null;
    selectionScore: number | null;
    action: StrategyDecision["action"] | null;
    entryReason: string[];
    invalidationReason: string[];
  };
  candidates: AutoShadowCandidateResult[];
  /** Production HOLD/NO_TRADE (or null) while another eligible strategy emitted BUY or SELL. */
  productionHoldWithAlternativeSignals: boolean;
  alternativeSignalStrategyIds: string[];
  independentAlternativeSignalStrategyIds: string[];
  repeatedAlternativeSignalStrategyIds: string[];
  /** Compact one-line comparison for logs / DecisionLog reasons. */
  comparisonSummary: string;
}

export interface EvaluateAutoShadowInput {
  timestampMs: number;
  openTimeMs: number;
  candleIndex: number;
  symbol: string;
  interval: string;
  executionBackend: string;
  regime: MarketRegime;
  regimeConfidence: number;
  selectionResult: Pick<
    StrategySelectionResult,
    "selectedStrategyId" | "selectionScore" | "selectionMode" | "alternatives"
  >;
  productionDecision: StrategyDecision | null;
  eligible: ReadonlyArray<AutoShadowEligibleStrategy>;
  /** Shared closed-candle context (same as production evaluate). */
  context: Omit<StrategyContext, "parameters" | "candlesSinceLastSignal">;
  /**
   * Shadow-only cooldown map (strategyId → candleIndex of last shadow BUY/SELL).
   * Must not be the production lastSignalCandle map.
   */
  shadowLastSignalCandle: ReadonlyMap<string, number>;
  /** Strategy IDs that produced alternative BUY/SELL on the previous analysis bar. */
  previousAlternativeSignalIds?: ReadonlySet<string>;
  forwardTrialBlockReason?: AutoShadowForwardTrialChecker;
}

export interface EvaluateAutoShadowResult {
  report: AutoShadowEvaluationReport;
  /** Caller applies these only to the shadow cooldown map. */
  shadowCooldownUpdates: Array<{ strategyId: string; candleIndex: number }>;
}

const defaultForwardTrialChecker: AutoShadowForwardTrialChecker = (input) =>
  replayForwardTrialBlockReason(input);

function buildRankMap(
  selection: EvaluateAutoShadowInput["selectionResult"]
): Map<string, { rank: number; score: number | null }> {
  const map = new Map<string, { rank: number; score: number | null }>();
  if (selection.selectedStrategyId) {
    map.set(selection.selectedStrategyId, {
      rank: 1,
      score: selection.selectionScore
    });
  }
  const alts = selection.alternatives ?? [];
  for (let i = 0; i < alts.length; i++) {
    const a = alts[i]!;
    if (map.has(a.strategyId)) continue;
    map.set(a.strategyId, { rank: i + 2, score: a.score });
  }
  return map;
}

function isTradeAction(action: StrategyDecision["action"] | null | undefined): boolean {
  return action === "BUY" || action === "SELL";
}

function productionIsHoldLike(action: StrategyDecision["action"] | null | undefined): boolean {
  return action == null || action === "HOLD";
}

/**
 * Evaluate all production-eligible strategies for shadow comparison.
 * Pure aside from reading strategy.evaluate (strategies must remain pure).
 */
export function evaluateAutoShadowCandidates(input: EvaluateAutoShadowInput): EvaluateAutoShadowResult {
  const ft = input.forwardTrialBlockReason ?? defaultForwardTrialChecker;
  const ranks = buildRankMap(input.selectionResult);
  const prev = input.previousAlternativeSignalIds ?? new Set<string>();
  const productionAction = input.productionDecision?.action ?? null;
  const selectedId = input.selectionResult.selectedStrategyId;

  const candidates: AutoShadowCandidateResult[] = [];
  const shadowCooldownUpdates: Array<{ strategyId: string; candleIndex: number }> = [];

  for (const item of input.eligible) {
    const last = input.shadowLastSignalCandle.get(item.strategy.id);
    const since = last === undefined ? Number.POSITIVE_INFINITY : input.candleIndex - last;
    const decision = item.strategy.evaluate({
      ...input.context,
      parameters: item.parameters,
      candlesSinceLastSignal: since
    });

    const forwardTrialReason = isTradeAction(decision.action)
      ? ft({
          executionBackend: input.executionBackend,
          symbol: input.symbol,
          interval: input.interval,
          strategyId: item.strategy.id,
          action: decision.action
        })
      : null;
    const forwardTrialBlocked = forwardTrialReason != null;
    const shadowSignalEligible = isTradeAction(decision.action) && !forwardTrialBlocked;
    const isProductionSelected = item.strategy.id === selectedId;

    const countsAsAlternative =
      shadowSignalEligible &&
      (productionIsHoldLike(productionAction) || item.strategy.id !== selectedId);

    const repeatedSetup = countsAsAlternative && prev.has(item.strategy.id);

    const ranked = ranks.get(item.strategy.id);
    candidates.push({
      strategyId: item.strategy.id,
      rank: ranked?.rank ?? null,
      selectionScore: ranked?.score ?? null,
      action: decision.action,
      confidence: decision.confidence,
      entryReason: [...decision.entryReason],
      invalidationReason: [...decision.invalidationReason],
      candlesSinceLastSignal: since,
      shadowSignalEligible,
      forwardTrialBlocked,
      forwardTrialReason,
      executionReadiness: "NOT_ASSESSED",
      repeatedSetup,
      isProductionSelected
    });

    // Shadow cooldown only — never production. Skip FT-blocked (mirrors live guard).
    if (isTradeAction(decision.action) && !forwardTrialBlocked) {
      shadowCooldownUpdates.push({ strategyId: item.strategy.id, candleIndex: input.candleIndex });
    }
  }

  candidates.sort((a, b) => {
    const ra = a.rank ?? 999;
    const rb = b.rank ?? 999;
    if (ra !== rb) return ra - rb;
    return a.strategyId.localeCompare(b.strategyId);
  });

  const alternativeSignalStrategyIds = candidates
    .filter((c) => {
      if (!c.shadowSignalEligible) return false;
      if (productionIsHoldLike(productionAction)) return true;
      return !c.isProductionSelected;
    })
    .map((c) => c.strategyId);

  const productionHoldWithAlternativeSignals =
    productionIsHoldLike(productionAction) && alternativeSignalStrategyIds.length > 0;

  const repeatedAlternativeSignalStrategyIds = candidates
    .filter((c) => c.repeatedSetup && alternativeSignalStrategyIds.includes(c.strategyId))
    .map((c) => c.strategyId);

  const independentAlternativeSignalStrategyIds = alternativeSignalStrategyIds.filter(
    (id) => !repeatedAlternativeSignalStrategyIds.includes(id)
  );

  const comparisonSummary = formatAutoShadowComparisonSummary({
    productionAction,
    productionStrategyId: selectedId,
    regime: input.regime,
    alternativeCandidates: candidates.filter((c) =>
      alternativeSignalStrategyIds.includes(c.strategyId)
    )
  });

  return {
    report: {
      timestampMs: input.timestampMs,
      openTimeMs: input.openTimeMs,
      candleIndex: input.candleIndex,
      symbol: input.symbol,
      interval: input.interval,
      regime: input.regime,
      regimeConfidence: input.regimeConfidence,
      selectionMode: input.selectionResult.selectionMode ?? null,
      production: {
        selectedStrategyId: selectedId,
        selectionScore: input.selectionResult.selectionScore,
        action: productionAction,
        entryReason: input.productionDecision ? [...input.productionDecision.entryReason] : [],
        invalidationReason: input.productionDecision
          ? [...input.productionDecision.invalidationReason]
          : []
      },
      candidates,
      productionHoldWithAlternativeSignals,
      alternativeSignalStrategyIds,
      independentAlternativeSignalStrategyIds,
      repeatedAlternativeSignalStrategyIds,
      comparisonSummary
    },
    shadowCooldownUpdates
  };
}

export function formatAutoShadowComparisonSummary(input: {
  productionAction: StrategyDecision["action"] | null;
  productionStrategyId: string | null;
  regime: MarketRegime;
  alternativeCandidates: ReadonlyArray<
    Pick<AutoShadowCandidateResult, "strategyId" | "action" | "rank" | "repeatedSetup" | "forwardTrialBlocked">
  >;
}): string {
  const prod = `${input.productionStrategyId ?? "none"}/${input.productionAction ?? "none"}`;
  if (input.alternativeCandidates.length === 0) {
    return `AUTO_SHADOW prod=${prod} regime=${input.regime} alternatives=none`;
  }
  const alts = input.alternativeCandidates
    .map((c) => {
      const flags = [
        c.rank != null ? `r${c.rank}` : "r?",
        c.repeatedSetup ? "repeat" : "indep",
        c.forwardTrialBlocked ? "FT-block" : null
      ]
        .filter(Boolean)
        .join(",");
      return `${c.strategyId}:${c.action}(${flags})`;
    })
    .join(" ");
  return `AUTO_SHADOW prod=${prod} regime=${input.regime} vs ${alts}`;
}

/** Apply shadow cooldown updates to a dedicated map (never production). */
export function applyAutoShadowCooldownUpdates(
  shadowLastSignalCandle: Map<string, number>,
  updates: ReadonlyArray<{ strategyId: string; candleIndex: number }>
): void {
  for (const u of updates) {
    shadowLastSignalCandle.set(u.strategyId, u.candleIndex);
  }
}
