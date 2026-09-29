/**
 * Offline AUTO strategy-selection counterfactual replay.
 *
 * Pass A mirrors production: rank eligible strategies, evaluate only the winner.
 * Pass B shadows: evaluate every eligible strategy on the same closed candle.
 * Pass C fallback: walk selector rank order until first executable BUY/SELL.
 *
 * No look-ahead: features/context use candles[0..i] only.
 * Does not place orders or mutate production selection behavior.
 */
import { type Candle, type MarketRegime, type RegimeResult, type StrategyDecision } from "@regimex/shared";
import {
  DEFAULT_FEATURE_CONFIG,
  extractFeatures,
  minimumCandlesForFeatures
} from "../features/featureExtractor.js";
import { RuleBasedRegimeClassifier, DEFAULT_REGIME_THRESHOLDS, type RegimeThresholds } from "../regime/classifier.js";
import {
  DEFAULT_SELECTION_CONFIG,
  StrategySelectionService,
  type SelectionCandidate,
  type StrategyPerformanceRecord
} from "../selection/strategySelector.js";
import { strategyAppliesToSession } from "../candles/mt5MtfWarmup.js";
import { applyMt5StrategySelectionAllowlist } from "../broker/mt5/engineRollout.js";
import { isCfdCapableStrategy } from "../strategies/cfdCapability.js";
import { type TradingStrategy } from "../strategies/types.js";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "../strategies/squeezeBreakout.js";
import { BollingerReversionStrategy, BOLLINGER_REVERSION_DEFAULTS } from "../strategies/bollingerReversion.js";
import {
  REPLAY_ENTRY_CONVENTION,
  simulatePassEconomicOutcomes,
  type ReplayEconomicComparison,
  type ReplayDiagnosticGroupRow,
  type ReplayDiagnosticGroupStats,
  type ReplayFallbackFromHoldDiagnostics,
  type ReplayEconomicSignal,
  type ReplayTradePlanSnapshot,
  buildFallbackFromHoldDiagnostics
} from "./autoSelectionReplayOutcomes.js";
import {
  EXTENSION_BUCKETS,
  STOP_DISTANCE_BUCKETS,
  buildEmaFallbackFromHoldDiagnostics,
  type EmaDiagnosticGroupStats,
  type EmaFallbackFromHoldDiagnostics
} from "./autoSelectionEmaFallbackDiagnostics.js";

export * from "./autoSelectionEmaFallbackDiagnostics.js";

export type {
  ReplayEconomicComparison,
  ReplayPassEconomicMetrics,
  ReplaySimulatedTrade,
  ReplayTradeOutcome,
  ReplayTradePlanSnapshot,
  ReplayDiagnosticGroupRow,
  ReplayDiagnosticGroupStats,
  ReplayFallbackFromHoldDiagnostics
} from "./autoSelectionReplayOutcomes.js";
export {
  REPLAY_ENTRY_CONVENTION,
  aggregatePassEconomicMetrics,
  buildReplayTradePlan,
  buildFallbackFromHoldDiagnostics,
  simulatePassEconomicOutcomes,
  simulateStopTargetWalk,
  REPLAY_UNATTRIBUTED_REGIME
} from "./autoSelectionReplayOutcomes.js";

/** Matches LiveEngineSession CANDLE_BUFFER_BASE. */
export const REPLAY_CANDLE_BUFFER_CAPACITY = 1500;

/** Default tick size for R_10 / Volatility Index offline stop geometry. */
export const REPLAY_DEFAULT_TICK_SIZE = 0.01;

export interface ReplayStrategyDefinition {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
  enabled: boolean;
}

export interface AutoSelectionReplayConfig {
  symbol: string;
  interval: string;
  /** Inclusive analysis window start (ms UTC). Candles before this are warmup-only. */
  analysisStartMs: number;
  /** Exclusive analysis window end (ms UTC). */
  analysisEndMs: number;
  selectionMode: "BOOTSTRAP" | "VALIDATED";
  executionBackend: "broker_demo_mt5" | "broker_real_mt5" | "paper_cfd";
  /** Same CSV semantics as MT5_ENGINE_STRATEGY_ALLOWLIST. Empty → fail-closed for MT5 backends. */
  strategyAllowlist: string[];
  strategies?: ReplayStrategyDefinition[];
  /**
   * Optional per-regime performance for VALIDATED scoring.
   * Missing evidence → bootstrap fallback (same as production).
   */
  performanceByRegime?: Map<string, Map<string, StrategyPerformanceRecord>>;
  candleBufferCapacity?: number;
  /** Defaults to DEFAULT_REGIME_THRESHOLDS; pass DB RegimeConfiguration when available. */
  regimeThresholds?: RegimeThresholds;
  /** Tick size for strategy CFD stop/target proposal (default 0.01 for R_10). */
  tickSize?: number;
}

export interface StrategyEvalSnapshot {
  strategyId: string;
  action: StrategyDecision["action"];
  confidence: number;
  entryReason: string[];
  invalidationReason: string[];
  candlesSinceLastSignal: number;
  forwardTrialBlocked: boolean;
  forwardTrialReason: string | null;
  /** Dry known submission blockers (allowlist already applied for eligibility). */
  submissionBlockers: string[];
  /** Candle close time that produced the decision (ms). */
  signalTimestampMs: number;
  /** Strategy decision metadata (structure levels etc.) for CFD stop/target proposal. */
  decisionMetadata: Record<string, unknown>;
  /**
   * Filled during economic simulation when this eval opened a scorable/unscorable trade plan.
   * Null when this eval did not produce an executable signal used by Pass A/C economics.
   */
  tradePlan: ReplayTradePlanSnapshot | null;
}

export interface FallbackEvalSnapshot {
  /** Strategy ids in selector rank order (winner first, then alternatives). */
  rankingOrder: string[];
  /** Evaluations attempted in rank order until an executable trade or exhaustion. */
  triedEvaluations: StrategyEvalSnapshot[];
  selectedStrategyId: string | null;
  action: StrategyDecision["action"] | null;
  evaluation: StrategyEvalSnapshot | null;
}

export interface AutoSelectionReplayBarResult {
  candleIndex: number;
  openTimeMs: number;
  closeTimeMs: number;
  close: number;
  regime: MarketRegime;
  regimeConfidence: number;
  eligibleStrategyIds: string[];
  production: {
    selectedStrategyId: string | null;
    selectionMode: string | null;
    selectionScore: number | null;
    alternatives: Array<{ strategyId: string; score: number }>;
    eligibilityRejections: string[];
    evaluation: StrategyEvalSnapshot | null;
  };
  shadow: StrategyEvalSnapshot[];
  /** Pass C: fallback walk of selector rank order. */
  fallback: FallbackEvalSnapshot;
  /** Production HOLD/NO_TRADE/none but at least one eligible shadow BUY. */
  missedBuyOpportunity: boolean;
  missedBuyStrategyIds: string[];
  /** True when previous analysis bar also missed a BUY from the same shadow strategy. */
  repeatedMissedBuySetup: boolean;
  /** Production ≠ SELL but at least one eligible shadow SELL. */
  missedSellOpportunity: boolean;
  missedSellStrategyIds: string[];
  repeatedMissedSellSetup: boolean;
}

export interface AutoSelectionReplayReport {
  generatedAtIso: string;
  config: {
    symbol: string;
    interval: string;
    analysisStartIso: string;
    analysisEndIso: string;
    selectionMode: string;
    executionBackend: string;
    strategyAllowlist: string[];
    strategyIds: string[];
  };
  coverage: {
    totalCandlesProvided: number;
    completeCandles: number;
    warmupBars: number;
    analysisBars: number;
    firstCandleIso: string | null;
    lastCandleIso: string | null;
    gapsInAnalysisWindow: number;
  };
  limitations: string[];
  counts: {
    analysisBars: number;
    productionHoldOrNoTrade: number;
    productionBuy: number;
    productionSell: number;
    missedBuyOpportunityBars: number;
    independentMissedBuyBars: number;
    repeatedMissedBuyBars: number;
    missedBuyByStrategy: Record<string, number>;
    missedBuyPassingForwardTrial: number;
    missedBuyBlockedByForwardTrial: number;
    missedSellOpportunityBars: number;
    independentMissedSellBars: number;
    repeatedMissedSellBars: number;
    missedSellByStrategy: Record<string, number>;
    missedSellPassingForwardTrial: number;
    missedSellBlockedByForwardTrial: number;
    fallbackHoldOrNoTrade: number;
    fallbackBuy: number;
    fallbackSell: number;
    fallbackTrades: number;
    fallbackByStrategy: Record<string, number>;
    fallbackFromProductionHold: number;
    fallbackFromProductionHoldByStrategy: Record<string, number>;
  };
  examples: AutoSelectionReplayBarResult[];
  bars: AutoSelectionReplayBarResult[];
  /** Pass A vs Pass C economic outcomes (R-multiples; no stake/lot PnL). */
  economic: ReplayEconomicComparison;
}

/** Mirrors apps/worker/src/engine/r10SqueezeForwardTrialGuard.ts — keep in sync via tests. */
export function replayForwardTrialBlockReason(input: {
  executionBackend: string;
  symbol: string;
  interval: string;
  strategyId: string;
  action: string;
}): string | null {
  if (
    input.executionBackend !== "broker_demo_mt5" ||
    input.symbol !== "R_10" ||
    input.strategyId !== "squeeze-breakout-v1"
  ) {
    return null;
  }
  if (input.action !== "BUY" && input.action !== "SELL") return null;
  const executable =
    input.interval === "1m" && (input.action === "BUY" || input.action === "SELL");
  return executable ? null : "R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY";
}

export function defaultR10ReplayStrategies(): ReplayStrategyDefinition[] {
  return [
    {
      strategy: new BreakoutMomentumStrategy(),
      parameters: { ...BREAKOUT_MOMENTUM_DEFAULTS },
      enabled: true
    },
    {
      strategy: new EmaPullbackStrategy(),
      parameters: { ...EMA_PULLBACK_DEFAULTS },
      enabled: true
    },
    {
      strategy: new SqueezeBreakoutStrategy(),
      parameters: { ...SQUEEZE_BREAKOUT_DEFAULTS },
      enabled: true
    },
    {
      strategy: new BollingerReversionStrategy(),
      parameters: { ...BOLLINGER_REVERSION_DEFAULTS },
      enabled: true
    }
  ];
}

/**
 * Strategies that can participate in this replay scope for warmup sizing.
 * Does not replace per-bar runtime eligibility (regime/confidence/history).
 */
export function strategiesForWarmupNeed(
  strategies: ReadonlyArray<ReplayStrategyDefinition>,
  config: Pick<AutoSelectionReplayConfig, "symbol" | "interval" | "executionBackend" | "strategyAllowlist">
): ReplayStrategyDefinition[] {
  let scoped = strategies.filter((s) => s.enabled);
  scoped = scoped.filter((s) =>
    strategyAppliesToSession(s.strategy, { symbol: config.symbol, interval: config.interval })
  );

  const mt5 =
    config.executionBackend === "broker_demo_mt5" || config.executionBackend === "broker_real_mt5";
  if (mt5) {
    scoped = applyMt5StrategySelectionAllowlist(
      scoped,
      (s) => s.strategy.id,
      config.executionBackend,
      {
        EXECUTION_MODE: config.executionBackend,
        REAL_MONEY_ENABLED: false,
        MT5_ENGINE_STRATEGY_ALLOWLIST: config.strategyAllowlist.join(",")
      }
    );
  } else if (config.strategyAllowlist.length > 0) {
    // Research / paper: honor an explicit allowlist so out-of-scope strategies
    // (e.g. XAU-only) cannot inflate warmup when R_10 allowlist is supplied.
    scoped = scoped.filter((s) => config.strategyAllowlist.includes(s.strategy.id));
  }
  return scoped;
}

export function computeWarmupNeed(
  strategies: ReadonlyArray<ReplayStrategyDefinition>,
  config: Pick<AutoSelectionReplayConfig, "symbol" | "interval" | "executionBackend" | "strategyAllowlist">
): number {
  const scoped = strategiesForWarmupNeed(strategies, config);
  const histories = scoped.map((s) => s.strategy.minimumHistory);
  return Math.max(minimumCandlesForFeatures(DEFAULT_FEATURE_CONFIG), ...(histories.length ? histories : [0]));
}

function assertClosedCandlesOnly(candles: ReadonlyArray<Candle>): string[] {
  const issues: string[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (!c.isComplete) issues.push(`candle[${i}] openTime=${c.openTime} isComplete=false`);
    if (i > 0 && candles[i]!.openTime < candles[i - 1]!.openTime) {
      issues.push(`candle[${i}] openTime not ascending`);
    }
  }
  return issues;
}

function countGapsMs(candles: ReadonlyArray<Candle>, intervalMs: number): number {
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (dt > intervalMs * 1.5) gaps += 1;
  }
  return gaps;
}

function evaluateStrategy(input: {
  strategy: TradingStrategy;
  parameters: Record<string, number | boolean | string>;
  candles: Candle[];
  features: ReturnType<typeof extractFeatures>;
  regime: RegimeResult;
  candlesSinceLastSignal: number;
  symbol: string;
  interval: string;
  executionBackend: string;
}): StrategyEvalSnapshot {
  const decision = input.strategy.evaluate({
    candles: input.candles,
    features: input.features,
    regime: input.regime,
    parameters: input.parameters,
    candlesSinceLastSignal: input.candlesSinceLastSignal
  });
  const forwardTrialReason = replayForwardTrialBlockReason({
    executionBackend: input.executionBackend,
    symbol: input.symbol,
    interval: input.interval,
    strategyId: input.strategy.id,
    action: decision.action
  });
  const submissionBlockers: string[] = [];
  if (forwardTrialReason) submissionBlockers.push(forwardTrialReason);
  return {
    strategyId: input.strategy.id,
    action: decision.action,
    confidence: decision.confidence,
    entryReason: [...decision.entryReason],
    invalidationReason: [...decision.invalidationReason],
    candlesSinceLastSignal: input.candlesSinceLastSignal,
    forwardTrialBlocked: forwardTrialReason != null,
    forwardTrialReason,
    submissionBlockers,
    signalTimestampMs: decision.signalTimestamp,
    decisionMetadata: { ...(decision.metadata ?? {}) },
    tradePlan: null
  };
}

function isExecutableTrade(ev: StrategyEvalSnapshot): boolean {
  return (ev.action === "BUY" || ev.action === "SELL") && !ev.forwardTrialBlocked;
}

function isProductionHoldOrNoTrade(ev: StrategyEvalSnapshot | null): boolean {
  if (!ev) return true;
  return ev.action !== "BUY" && ev.action !== "SELL";
}

/** Selector rank order: Pass A winner first, then alternatives by descending score. */
export function selectorRankingOrder(selection: {
  selectedStrategyId: string | null;
  alternatives: Array<{ strategyId: string; score: number }>;
}): string[] {
  const order: string[] = [];
  if (selection.selectedStrategyId) order.push(selection.selectedStrategyId);
  for (const a of selection.alternatives) {
    if (!order.includes(a.strategyId)) order.push(a.strategyId);
  }
  return order;
}

/**
 * Run Pass A (production mirror) + Pass B (shadow all eligible) + Pass C (fallback rank walk).
 */
export function runAutoSelectionCounterfactualReplay(
  candlesIn: ReadonlyArray<Candle>,
  config: AutoSelectionReplayConfig
): AutoSelectionReplayReport {
  const limitations: string[] = [];
  const strategies = config.strategies ?? defaultR10ReplayStrategies();
  const bufferCapacity = config.candleBufferCapacity ?? REPLAY_CANDLE_BUFFER_CAPACITY;
  const regimeThresholds = config.regimeThresholds ?? DEFAULT_REGIME_THRESHOLDS;
  const intervalMs = config.interval === "1m" ? 60_000 : config.interval === "5m" ? 300_000 : 60_000;

  const closedIssues = assertClosedCandlesOnly(candlesIn);
  if (closedIssues.length > 0) {
    limitations.push(`Closed-candle integrity issues: ${closedIssues.slice(0, 5).join("; ")}`);
  }

  const candles = candlesIn
    .filter((c) => c.isComplete)
    .slice()
    .sort((a, b) => a.openTime - b.openTime);

  if (candles.length === 0) {
    return emptyReport(config, strategies, limitations.concat("No complete candles provided"));
  }

  const warmupScoped = strategiesForWarmupNeed(strategies, config);
  const warmupNeed = computeWarmupNeed(strategies, config);
  if (warmupScoped.length < strategies.filter((s) => s.enabled).length) {
    limitations.push(
      `Warmup scoped to ${warmupScoped.length} strategy(ies) applicable to ${config.symbol}/${config.interval}` +
        (config.strategyAllowlist.length ? ` allowlist=[${config.strategyAllowlist.join(",")}]` : "") +
        ` (excluded ${strategies.filter((s) => s.enabled).length - warmupScoped.length} enabled out-of-scope)`
    );
  }

  const analysisCandles = candles.filter(
    (c) => c.openTime >= config.analysisStartMs && c.openTime < config.analysisEndMs
  );
  const gapsInAnalysisWindow = countGapsMs(analysisCandles, intervalMs);

  if (analysisCandles.length === 0) {
    limitations.push(
      `No complete ${config.symbol} ${config.interval} candles in analysis window ${new Date(config.analysisStartMs).toISOString()}–${new Date(config.analysisEndMs).toISOString()}`
    );
  }

  const firstAnalysisIdx = candles.findIndex(
    (c) => c.openTime >= config.analysisStartMs && c.openTime < config.analysisEndMs
  );
  if (firstAnalysisIdx >= 0 && firstAnalysisIdx < warmupNeed) {
    limitations.push(
      `Insufficient warmup before analysis window: have ${firstAnalysisIdx} bars before first analysis candle, need ≥${warmupNeed}`
    );
  }

  if (
    (config.executionBackend === "broker_demo_mt5" || config.executionBackend === "broker_real_mt5") &&
    config.strategyAllowlist.length === 0
  ) {
    limitations.push("MT5 strategy allowlist is empty — eligibility fail-closed (mirrors production)");
  }

  if (!config.performanceByRegime || config.performanceByRegime.size === 0) {
    limitations.push(
      "No StrategyRegimeMetric / performance map supplied — selection uses BOOTSTRAP scoring only (even if mode=VALIDATED, fallback applies when no evidence)"
    );
  }

  const selection = new StrategySelectionService({
    ...DEFAULT_SELECTION_CONFIG,
    mode: config.selectionMode,
    bootstrapFallback: true
  });
  const classifier = new RuleBasedRegimeClassifier();

  // Pass A: production-driven cooldown (only winner advances).
  const productionLastSignal = new Map<string, number>();
  // Pass B: per-strategy shadow cooldown (each eligible strategy advances independently).
  const shadowLastSignal = new Map<string, number>();
  // Pass C: independent fallback cooldown (selected fallback trade advances).
  const fallbackLastSignal = new Map<string, number>();
  const bars: AutoSelectionReplayBarResult[] = [];
  let prevMissedBuyByStrategy = new Set<string>();
  let prevMissedSellByStrategy = new Set<string>();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (candle.openTime < config.analysisStartMs || candle.openTime >= config.analysisEndMs) {
      continue;
    }
    if (i + 1 < warmupNeed) {
      limitations.push(`Skipped analysis bar ${new Date(candle.openTime).toISOString()} — below warmup`);
      continue;
    }

    // Live ring: keep last bufferCapacity closed candles ending at i (no look-ahead).
    const windowStart = Math.max(0, i + 1 - bufferCapacity);
    const ctxCandles = candles.slice(windowStart, i + 1);
    const features = extractFeatures(ctxCandles, DEFAULT_FEATURE_CONFIG);
    const latest = features[features.length - 1];
    if (!latest) continue;

    const regime = classifier.classify({
      features: latest,
      thresholds: regimeThresholds
    });

    let eligible = strategies.filter(
      (s) =>
        s.enabled &&
        s.strategy.supportedRegimes.includes(regime.regime) &&
        regime.confidence >= s.strategy.eligibility.minimumRegimeConfidence &&
        ctxCandles.length >= s.strategy.minimumHistory &&
        isCfdCapableStrategy(s.strategy.id) &&
        strategyAppliesToSession(s.strategy, { symbol: config.symbol, interval: config.interval })
    );
    eligible = applyMt5StrategySelectionAllowlist(
      eligible,
      (s) => s.strategy.id,
      config.executionBackend,
      {
        EXECUTION_MODE: config.executionBackend,
        REAL_MONEY_ENABLED: false,
        MT5_ENGINE_STRATEGY_ALLOWLIST: config.strategyAllowlist.join(",")
      }
    );

    const eligibleStrategyIds = eligible.map((s) => s.strategy.id);
    const eligibleById = new Map(eligible.map((s) => [s.strategy.id, s]));
    const perfMap = config.performanceByRegime?.get(regime.regime) ?? new Map();

    const candidates: SelectionCandidate[] = eligible.map((s) => ({
      strategy: s.strategy,
      enabled: s.enabled,
      performance: perfMap.get(s.strategy.id) ?? null
    }));

    const selectionResult = selection.select(regime.regime, regime.confidence, candidates);
    const selectedId = selectionResult.selectedStrategyId;
    const chosen = eligible.find((s) => s.strategy.id === selectedId) ?? null;
    const rankingOrder = selectorRankingOrder({
      selectedStrategyId: selectedId,
      alternatives: (selectionResult.alternatives ?? []).map((a) => ({
        strategyId: a.strategyId,
        score: a.score
      }))
    });

    let productionEval: StrategyEvalSnapshot | null = null;
    if (chosen) {
      const last = productionLastSignal.get(chosen.strategy.id);
      const since = last === undefined ? Number.POSITIVE_INFINITY : i - last;
      productionEval = evaluateStrategy({
        strategy: chosen.strategy,
        parameters: chosen.parameters,
        candles: ctxCandles,
        features,
        regime,
        candlesSinceLastSignal: since,
        symbol: config.symbol,
        interval: config.interval,
        executionBackend: config.executionBackend
      });
    }

    // Pass B — independent shadow cooldowns (preserve strategy cooldown semantics).
    const shadow: StrategyEvalSnapshot[] = [];
    for (const s of eligible) {
      const last = shadowLastSignal.get(s.strategy.id);
      const since = last === undefined ? Number.POSITIVE_INFINITY : i - last;
      shadow.push(
        evaluateStrategy({
          strategy: s.strategy,
          parameters: s.parameters,
          candles: ctxCandles,
          features,
          regime,
          candlesSinceLastSignal: since,
          symbol: config.symbol,
          interval: config.interval,
          executionBackend: config.executionBackend
        })
      );
    }

    // Pass C — walk selector rank order; first executable BUY/SELL wins.
    const triedEvaluations: StrategyEvalSnapshot[] = [];
    let fallbackEval: StrategyEvalSnapshot | null = null;
    for (const strategyId of rankingOrder) {
      const def = eligibleById.get(strategyId);
      if (!def) continue;
      const last = fallbackLastSignal.get(def.strategy.id);
      const since = last === undefined ? Number.POSITIVE_INFINITY : i - last;
      const ev = evaluateStrategy({
        strategy: def.strategy,
        parameters: def.parameters,
        candles: ctxCandles,
        features,
        regime,
        candlesSinceLastSignal: since,
        symbol: config.symbol,
        interval: config.interval,
        executionBackend: config.executionBackend
      });
      triedEvaluations.push(ev);
      if (isExecutableTrade(ev)) {
        fallbackEval = ev;
        break;
      }
    }

    const fallback: FallbackEvalSnapshot = {
      rankingOrder,
      triedEvaluations,
      selectedStrategyId: fallbackEval?.strategyId ?? null,
      action: fallbackEval?.action ?? null,
      evaluation: fallbackEval
    };

    const missedBuyOpportunity =
      productionEval?.action !== "BUY" && shadow.some((s) => s.action === "BUY");
    const missedBuyIds = missedBuyOpportunity
      ? shadow.filter((s) => s.action === "BUY").map((s) => s.strategyId)
      : [];
    const repeatedMissedBuySetup =
      missedBuyOpportunity && missedBuyIds.some((id) => prevMissedBuyByStrategy.has(id));

    const missedSellOpportunity =
      productionEval?.action !== "SELL" && shadow.some((s) => s.action === "SELL");
    const missedSellIds = missedSellOpportunity
      ? shadow.filter((s) => s.action === "SELL").map((s) => s.strategyId)
      : [];
    const repeatedMissedSellSetup =
      missedSellOpportunity && missedSellIds.some((id) => prevMissedSellByStrategy.has(id));

    bars.push({
      candleIndex: i,
      openTimeMs: candle.openTime,
      closeTimeMs: candle.closeTime,
      close: candle.close,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      eligibleStrategyIds,
      production: {
        selectedStrategyId: selectedId,
        selectionMode: selectionResult.selectionMode ?? null,
        selectionScore: selectionResult.selectionScore,
        alternatives: (selectionResult.alternatives ?? []).map((a) => ({
          strategyId: a.strategyId,
          score: a.score
        })),
        eligibilityRejections: selectionResult.eligibilityRejections ?? [],
        evaluation: productionEval
      },
      shadow,
      fallback,
      missedBuyOpportunity,
      missedBuyStrategyIds: missedBuyIds,
      repeatedMissedBuySetup,
      missedSellOpportunity,
      missedSellStrategyIds: missedSellIds,
      repeatedMissedSellSetup
    });

    prevMissedBuyByStrategy = new Set(missedBuyIds);
    prevMissedSellByStrategy = new Set(missedSellIds);

    // Pass A cooldown: only when production winner emits BUY/SELL and forward-trial would not block
    // (mirrors live: blocked forward-trial returns before lastSignalCandle.set).
    if (
      productionEval &&
      (productionEval.action === "BUY" || productionEval.action === "SELL") &&
      !productionEval.forwardTrialBlocked
    ) {
      productionLastSignal.set(productionEval.strategyId, i);
    }

    // Pass B cooldown: each shadow strategy advances independently on BUY/SELL (FT-blocked still
    // does not advance — same as production guard semantics).
    for (const ev of shadow) {
      if ((ev.action === "BUY" || ev.action === "SELL") && !ev.forwardTrialBlocked) {
        shadowLastSignal.set(ev.strategyId, i);
      }
    }

    // Pass C cooldown: only the selected fallback trade advances (independent of A/B).
    if (fallbackEval && isExecutableTrade(fallbackEval)) {
      fallbackLastSignal.set(fallbackEval.strategyId, i);
    }
  }

  const missedBuyByStrategy: Record<string, number> = {};
  const missedSellByStrategy: Record<string, number> = {};
  const fallbackByStrategy: Record<string, number> = {};
  const fallbackFromProductionHoldByStrategy: Record<string, number> = {};
  let missedBuyPassingForwardTrial = 0;
  let missedBuyBlockedByForwardTrial = 0;
  let missedSellPassingForwardTrial = 0;
  let missedSellBlockedByForwardTrial = 0;
  let productionHoldOrNoTrade = 0;
  let productionBuy = 0;
  let productionSell = 0;
  let independentMissedBuyBars = 0;
  let repeatedMissedBuyBars = 0;
  let independentMissedSellBars = 0;
  let repeatedMissedSellBars = 0;
  let fallbackHoldOrNoTrade = 0;
  let fallbackBuy = 0;
  let fallbackSell = 0;
  let fallbackFromProductionHold = 0;

  for (const b of bars) {
    const act = b.production.evaluation?.action;
    if (act === "BUY") productionBuy += 1;
    else if (act === "SELL") productionSell += 1;
    else productionHoldOrNoTrade += 1;

    if (b.missedBuyOpportunity) {
      if (b.repeatedMissedBuySetup) repeatedMissedBuyBars += 1;
      else independentMissedBuyBars += 1;
      for (const id of b.missedBuyStrategyIds) {
        missedBuyByStrategy[id] = (missedBuyByStrategy[id] ?? 0) + 1;
      }
      const buys = b.shadow.filter((s) => s.action === "BUY");
      if (buys.some((s) => !s.forwardTrialBlocked)) missedBuyPassingForwardTrial += 1;
      if (buys.length > 0 && buys.every((s) => s.forwardTrialBlocked)) {
        missedBuyBlockedByForwardTrial += 1;
      }
    }

    if (b.missedSellOpportunity) {
      if (b.repeatedMissedSellSetup) repeatedMissedSellBars += 1;
      else independentMissedSellBars += 1;
      for (const id of b.missedSellStrategyIds) {
        missedSellByStrategy[id] = (missedSellByStrategy[id] ?? 0) + 1;
      }
      const sells = b.shadow.filter((s) => s.action === "SELL");
      if (sells.some((s) => !s.forwardTrialBlocked)) missedSellPassingForwardTrial += 1;
      if (sells.length > 0 && sells.every((s) => s.forwardTrialBlocked)) {
        missedSellBlockedByForwardTrial += 1;
      }
    }

    const fb = b.fallback.action;
    if (fb === "BUY") {
      fallbackBuy += 1;
      fallbackByStrategy[b.fallback.selectedStrategyId!] =
        (fallbackByStrategy[b.fallback.selectedStrategyId!] ?? 0) + 1;
    } else if (fb === "SELL") {
      fallbackSell += 1;
      fallbackByStrategy[b.fallback.selectedStrategyId!] =
        (fallbackByStrategy[b.fallback.selectedStrategyId!] ?? 0) + 1;
    } else {
      fallbackHoldOrNoTrade += 1;
    }

    if (
      isProductionHoldOrNoTrade(b.production.evaluation) &&
      (fb === "BUY" || fb === "SELL") &&
      b.fallback.selectedStrategyId
    ) {
      fallbackFromProductionHold += 1;
      fallbackFromProductionHoldByStrategy[b.fallback.selectedStrategyId] =
        (fallbackFromProductionHoldByStrategy[b.fallback.selectedStrategyId] ?? 0) + 1;
    }
  }

  const examples = bars
    .filter((b) => b.missedBuyOpportunity || b.missedSellOpportunity || b.fallback.action === "BUY" || b.fallback.action === "SELL")
    .slice(0, 25);

  const economicSignals: ReplayEconomicSignal[] = [];
  for (const b of bars) {
    const prod = b.production.evaluation;
    if (prod && isExecutableTrade(prod)) {
      economicSignals.push({
        pass: "A",
        signalCandleIndex: b.candleIndex,
        evaluation: {
          strategyId: prod.strategyId,
          action: prod.action as "BUY" | "SELL",
          confidence: prod.confidence,
          signalTimestampMs: prod.signalTimestampMs,
          decisionMetadata: prod.decisionMetadata
        },
        fromProductionHold: false,
        regime: b.regime,
        regimeConfidence: b.regimeConfidence
      });
    }
    const fb = b.fallback.evaluation;
    if (fb && isExecutableTrade(fb)) {
      economicSignals.push({
        pass: "C",
        signalCandleIndex: b.candleIndex,
        evaluation: {
          strategyId: fb.strategyId,
          action: fb.action as "BUY" | "SELL",
          confidence: fb.confidence,
          signalTimestampMs: fb.signalTimestampMs,
          decisionMetadata: fb.decisionMetadata
        },
        fromProductionHold: isProductionHoldOrNoTrade(b.production.evaluation),
        regime: b.regime,
        regimeConfidence: b.regimeConfidence
      });
    }
  }

  const parametersByStrategyId = new Map(
    strategies.map((s) => [s.strategy.id, s.parameters] as const)
  );
  const tickSize = config.tickSize ?? REPLAY_DEFAULT_TICK_SIZE;
  const economic = simulatePassEconomicOutcomes({
    candles,
    signals: economicSignals,
    parametersByStrategyId,
    tickSize,
    featureLookback: bufferCapacity
  });

  // Attach trade plans back onto bar eval snapshots for inspectability.
  const planByKey = new Map<string, ReplayTradePlanSnapshot>();
  for (const t of economic.trades) {
    planByKey.set(`${t.pass}:${t.signalCandleIndex}`, t.tradePlan);
  }
  for (const b of bars) {
    const aPlan = planByKey.get(`A:${b.candleIndex}`);
    if (aPlan && b.production.evaluation) b.production.evaluation.tradePlan = aPlan;
    const cPlan = planByKey.get(`C:${b.candleIndex}`);
    if (cPlan && b.fallback.evaluation) b.fallback.evaluation.tradePlan = cPlan;
  }

  limitations.push(
    `Economic entry convention: ${economic.entryConvention} — ${economic.entryConventionNote}`
  );
  limitations.push(`Economic position model: ${economic.positionModel} — ${economic.positionModelNote}`);
  limitations.push(
    "OHLC cannot resolve intrabar ordering when both stop and target are touched in the same candle (outcome=AMBIGUOUS; excluded from win rate / total R)"
  );
  limitations.push("No slippage modeled in economic R replay");
  limitations.push("No spread/commission modeled in economic R replay");
  limitations.push(
    "Historical economic replay is not a live-fill guarantee (live enters at contemporaneous quote)"
  );

  return {
    generatedAtIso: new Date().toISOString(),
    config: {
      symbol: config.symbol,
      interval: config.interval,
      analysisStartIso: new Date(config.analysisStartMs).toISOString(),
      analysisEndIso: new Date(config.analysisEndMs).toISOString(),
      selectionMode: config.selectionMode,
      executionBackend: config.executionBackend,
      strategyAllowlist: config.strategyAllowlist,
      strategyIds: strategies.map((s) => s.strategy.id)
    },
    coverage: {
      totalCandlesProvided: candlesIn.length,
      completeCandles: candles.length,
      warmupBars: Math.min(warmupNeed, candles.length),
      analysisBars: bars.length,
      firstCandleIso: candles[0] ? new Date(candles[0].openTime).toISOString() : null,
      lastCandleIso: candles.length
        ? new Date(candles[candles.length - 1]!.openTime).toISOString()
        : null,
      gapsInAnalysisWindow
    },
    limitations,
    counts: {
      analysisBars: bars.length,
      productionHoldOrNoTrade,
      productionBuy,
      productionSell,
      missedBuyOpportunityBars: bars.filter((b) => b.missedBuyOpportunity).length,
      independentMissedBuyBars,
      repeatedMissedBuyBars,
      missedBuyByStrategy,
      missedBuyPassingForwardTrial,
      missedBuyBlockedByForwardTrial,
      missedSellOpportunityBars: bars.filter((b) => b.missedSellOpportunity).length,
      independentMissedSellBars,
      repeatedMissedSellBars,
      missedSellByStrategy,
      missedSellPassingForwardTrial,
      missedSellBlockedByForwardTrial,
      fallbackHoldOrNoTrade,
      fallbackBuy,
      fallbackSell,
      fallbackTrades: fallbackBuy + fallbackSell,
      fallbackByStrategy,
      fallbackFromProductionHold,
      fallbackFromProductionHoldByStrategy
    },
    examples,
    bars,
    economic
  };
}

function emptyCounts(): AutoSelectionReplayReport["counts"] {
  return {
    analysisBars: 0,
    productionHoldOrNoTrade: 0,
    productionBuy: 0,
    productionSell: 0,
    missedBuyOpportunityBars: 0,
    independentMissedBuyBars: 0,
    repeatedMissedBuyBars: 0,
    missedBuyByStrategy: {},
    missedBuyPassingForwardTrial: 0,
    missedBuyBlockedByForwardTrial: 0,
    missedSellOpportunityBars: 0,
    independentMissedSellBars: 0,
    repeatedMissedSellBars: 0,
    missedSellByStrategy: {},
    missedSellPassingForwardTrial: 0,
    missedSellBlockedByForwardTrial: 0,
    fallbackHoldOrNoTrade: 0,
    fallbackBuy: 0,
    fallbackSell: 0,
    fallbackTrades: 0,
    fallbackByStrategy: {},
    fallbackFromProductionHold: 0,
    fallbackFromProductionHoldByStrategy: {}
  };
}

function emptyEconomic(): ReplayEconomicComparison {
  const emptyPass = {
    totalSignals: 0,
    scorableTrades: 0,
    unscorable: 0,
    targetHits: 0,
    stopHits: 0,
    ambiguous: 0,
    openAtEnd: 0,
    winRate: null,
    totalRealizedR: 0,
    avgRPerResolvedTrade: null,
    medianR: null,
    maxDrawdownR: 0,
    longestLosingStreak: 0,
    avgBarsHeld: null,
    byStrategy: {},
    fromProductionHoldSignals: 0,
    fromProductionHoldResolvedR: 0,
    fromProductionHoldResolvedTrades: 0
  };
  return {
    entryConvention: REPLAY_ENTRY_CONVENTION,
    entryConventionNote:
      "Enter at the next closed candle's open after the signal candle.",
    positionModel: "SINGLE_POSITION_PER_PASS",
    positionModelNote: "Pass A and Pass C each allow at most one open position (independent).",
    tickSize: REPLAY_DEFAULT_TICK_SIZE,
    passA: emptyPass,
    passC: emptyPass,
    passCFallbackFromHold: buildFallbackFromHoldDiagnostics([]),
    emaFallbackFromHold: buildEmaFallbackFromHoldDiagnostics({
      trades: [],
      candles: [],
      contextBySignal: new Map()
    }),
    trades: []
  };
}

function emptyReport(
  config: AutoSelectionReplayConfig,
  strategies: ReplayStrategyDefinition[],
  limitations: string[]
): AutoSelectionReplayReport {
  return {
    generatedAtIso: new Date().toISOString(),
    config: {
      symbol: config.symbol,
      interval: config.interval,
      analysisStartIso: new Date(config.analysisStartMs).toISOString(),
      analysisEndIso: new Date(config.analysisEndMs).toISOString(),
      selectionMode: config.selectionMode,
      executionBackend: config.executionBackend,
      strategyAllowlist: config.strategyAllowlist,
      strategyIds: strategies.map((s) => s.strategy.id)
    },
    coverage: {
      totalCandlesProvided: 0,
      completeCandles: 0,
      warmupBars: 0,
      analysisBars: 0,
      firstCandleIso: null,
      lastCandleIso: null,
      gapsInAnalysisWindow: 0
    },
    limitations,
    counts: emptyCounts(),
    examples: [],
    bars: [],
    economic: emptyEconomic()
  };
}

function formatDiagnosticStats(s: ReplayDiagnosticGroupStats): string {
  const wr = s.winRate == null ? "—" : `${(s.winRate * 100).toFixed(1)}%`;
  const avg = s.avgR == null ? "—" : s.avgR.toFixed(2);
  return (
    `trades ${s.trades}; resolved ${s.resolvedTrades} (W ${s.wins} / L ${s.losses}); win rate ${wr}; ` +
    `total R ${s.totalR.toFixed(2)}; avg R ${avg}; ambiguous ${s.ambiguous}; open ${s.openAtEnd}; unscorable ${s.unscorable}`
  );
}

function formatDiagnosticRow(r: ReplayDiagnosticGroupRow): string {
  const wr = r.winRate == null ? "—" : `${(r.winRate * 100).toFixed(1)}%`;
  const avg = r.avgR == null ? "—" : r.avgR.toFixed(2);
  return (
    `- ${r.strategyId} ${r.direction} ${r.regime}: resolved ${r.resolvedTrades} (W ${r.wins} / L ${r.losses}); ` +
    `win rate ${wr}; total R ${r.totalR.toFixed(2)}; avg R ${avg}`
  );
}

/** Markdown summary of Pass C fallback-from-HOLD diagnostics (full nesting stays in JSON). */
export function formatFallbackFromHoldDiagnosticsMarkdown(
  d: ReplayFallbackFromHoldDiagnostics
): string[] {
  const lines: string[] = [];
  lines.push(`## Pass C fallback-from-HOLD diagnostics`);
  lines.push(
    `Diagnostic only — no gating or strategy disablement is derived from these numbers. Regime is the signal-candle regime.`
  );
  lines.push(`- Total: ${formatDiagnosticStats(d.totals)}`);
  lines.push("");
  lines.push(`### By strategy`);
  const strategies = Object.keys(d.byStrategy).sort();
  if (strategies.length === 0) lines.push(`- None`);
  for (const id of strategies) lines.push(`- ${id}: ${formatDiagnosticStats(d.byStrategy[id]!)}`);
  lines.push("");
  lines.push(`### By strategy + direction`);
  if (strategies.length === 0) lines.push(`- None`);
  for (const id of strategies) {
    const dirs = d.byStrategyDirection[id] ?? {};
    for (const dir of ["BUY", "SELL"] as const) {
      const s = dirs[dir];
      if (s) lines.push(`- ${id} ${dir}: ${formatDiagnosticStats(s)}`);
    }
  }
  lines.push("");
  lines.push(
    `### Worst groups (strategy + direction + regime, ≥${d.minResolvedForRanking} resolved, total R ascending, top ${d.rankingLimit})`
  );
  if (d.worstGroups.length === 0) lines.push(`- None meet the resolved-trade threshold`);
  for (const r of d.worstGroups) lines.push(formatDiagnosticRow(r));
  lines.push("");
  lines.push(
    `### Best groups (strategy + direction + regime, ≥${d.minResolvedForRanking} resolved, total R descending, top ${d.rankingLimit})`
  );
  if (d.bestGroups.length === 0) lines.push(`- None meet the resolved-trade threshold`);
  for (const r of d.bestGroups) lines.push(formatDiagnosticRow(r));
  lines.push("");
  lines.push(`Full strategy → direction → regime breakdown: JSON \`economic.passCFallbackFromHold.byStrategyDirectionRegime\`.`);
  return lines;
}

function formatEmaStats(s: EmaDiagnosticGroupStats): string {
  const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
  const f2 = (n: number | null) => (n == null ? "—" : n.toFixed(2));
  return (
    `trades ${s.trades}; resolved ${s.resolvedTrades} (W ${s.wins} / L ${s.losses}); win ${pct(s.winRate)}; ` +
    `total R ${s.totalR.toFixed(2)}; avg R ${f2(s.avgR)}; stop ${f2(s.avgStopDistanceAtr)} ATR; ` +
    `target ${f2(s.avgTargetDistanceAtr)} ATR; MFE avg ${f2(s.avgMfeR)}R / med ${f2(s.medianMfeR)}R; MAE avg ${f2(s.avgMaeR)}R`
  );
}

/** Markdown summary of EMA fallback-from-HOLD diagnostics (per-trade records stay in JSON). */
export function formatEmaFallbackFromHoldMarkdown(d: EmaFallbackFromHoldDiagnostics): string[] {
  const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
  const lines: string[] = [];
  lines.push(`## EMA fallback-from-HOLD diagnostics`);
  lines.push(
    `Scope: Pass C, fromProductionHold, ${d.strategyId}. Diagnostic only — no filter or parameter change is derived from this.`
  );
  lines.push(`- Overall: ${formatEmaStats(d.overall)}`);
  lines.push("");
  lines.push(`### BUY vs SELL`);
  for (const dir of ["BUY", "SELL"] as const) {
    const s = d.byDirection[dir];
    lines.push(`- ${dir}: ${s ? formatEmaStats(s) : "none"}`);
  }
  lines.push("");
  lines.push(`### By regime`);
  const regimes = Object.keys(d.byRegime).sort();
  if (regimes.length === 0) lines.push(`- None`);
  for (const r of regimes) lines.push(`- ${r}: ${formatEmaStats(d.byRegime[r]!)}`);
  lines.push("");
  lines.push(`### By direction + regime`);
  let anyDirRegime = false;
  for (const dir of ["BUY", "SELL"] as const) {
    const byRegime = d.byDirectionRegime[dir] ?? {};
    for (const r of Object.keys(byRegime).sort()) {
      anyDirRegime = true;
      lines.push(`- ${dir} ${r}: ${formatEmaStats(byRegime[r]!)}`);
    }
  }
  if (!anyDirRegime) lines.push(`- None`);
  lines.push("");
  lines.push(`### Extension from fast EMA (ATR, direction-signed)`);
  for (const b of EXTENSION_BUCKETS) {
    const s = d.byExtensionBucket[b];
    if (s) lines.push(`- ${b}: ${formatEmaStats(s)}`);
  }
  if (Object.keys(d.byExtensionBucket).length === 0) lines.push(`- None`);
  lines.push("");
  lines.push(`### Stop distance (ATR)`);
  for (const b of STOP_DISTANCE_BUCKETS) {
    const s = d.byStopDistanceBucket[b];
    if (s) lines.push(`- ${b}: ${formatEmaStats(s)}`);
  }
  if (Object.keys(d.byStopDistanceBucket).length === 0) lines.push(`- None`);
  lines.push("");
  lines.push(`### Favorable-before-stop (STOP trades, bars before the stop bar)`);
  const o = d.overall;
  lines.push(
    `- Stopped trades ${o.stoppedTrades}: reached +0.25R ${pct(o.stoppedReached025RPct)}; +0.5R ${pct(o.stoppedReached05RPct)}; +1.0R ${pct(o.stoppedReached10RPct)}`
  );
  for (const dir of ["BUY", "SELL"] as const) {
    const s = d.byDirection[dir];
    if (s && s.stoppedTrades > 0) {
      lines.push(
        `- ${dir} stopped ${s.stoppedTrades}: +0.25R ${pct(s.stoppedReached025RPct)}; +0.5R ${pct(s.stoppedReached05RPct)}; +1.0R ${pct(s.stoppedReached10RPct)}`
      );
    }
  }
  lines.push("");
  lines.push(`Per-trade records: JSON \`economic.emaFallbackFromHold.trades\`.`);
  return lines;
}

/** Format a concise markdown summary from a report. */
export function formatAutoSelectionReplayMarkdown(report: AutoSelectionReplayReport): string {
  const lines: string[] = [];
  lines.push(`# AUTO selection counterfactual replay`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAtIso}`);
  lines.push(
    `Window: ${report.config.analysisStartIso} → ${report.config.analysisEndIso} (${report.config.symbol} ${report.config.interval})`
  );
  lines.push(
    `Selection mode: ${report.config.selectionMode}; backend: ${report.config.executionBackend}`
  );
  lines.push(`Allowlist: ${report.config.strategyAllowlist.join(", ") || "(empty)"}`);
  lines.push("");
  lines.push(`## Coverage`);
  lines.push(
    `- Complete candles: ${report.coverage.completeCandles}; analysis bars: ${report.coverage.analysisBars}; gaps in window: ${report.coverage.gapsInAnalysisWindow}`
  );
  lines.push(
    `- Span: ${report.coverage.firstCandleIso ?? "—"} → ${report.coverage.lastCandleIso ?? "—"}`
  );
  lines.push(`- Warmup bars (scoped): ${report.coverage.warmupBars}`);
  lines.push("");
  lines.push(`## Limitations`);
  if (report.limitations.length === 0) lines.push(`- None reported`);
  else for (const l of report.limitations) lines.push(`- ${l}`);
  lines.push("");
  lines.push(`## Counts`);
  lines.push(
    `- Production trades: BUY ${report.counts.productionBuy}; SELL ${report.counts.productionSell}; HOLD/NO_TRADE ${report.counts.productionHoldOrNoTrade}`
  );
  lines.push(
    `- Fallback (Pass C) trades: BUY ${report.counts.fallbackBuy}; SELL ${report.counts.fallbackSell}; total ${report.counts.fallbackTrades}; HOLD/NO_TRADE ${report.counts.fallbackHoldOrNoTrade}`
  );
  lines.push(
    `- Fallback from production HOLD: ${report.counts.fallbackFromProductionHold}; by strategy: ${JSON.stringify(report.counts.fallbackFromProductionHoldByStrategy)}`
  );
  lines.push(`- Fallback by strategy: ${JSON.stringify(report.counts.fallbackByStrategy)}`);
  lines.push(
    `- Missed BUY opportunity bars (prod ≠ BUY, shadow BUY): ${report.counts.missedBuyOpportunityBars}`
  );
  lines.push(
    `- Independent missed BUY bars: ${report.counts.independentMissedBuyBars}; repeated: ${report.counts.repeatedMissedBuyBars}`
  );
  lines.push(
    `- Missed BUY FT-passing: ${report.counts.missedBuyPassingForwardTrial}; all FT-blocked: ${report.counts.missedBuyBlockedByForwardTrial}`
  );
  lines.push(`- Missed BUY by strategy: ${JSON.stringify(report.counts.missedBuyByStrategy)}`);
  lines.push(
    `- Missed SELL opportunity bars (prod ≠ SELL, shadow SELL): ${report.counts.missedSellOpportunityBars}`
  );
  lines.push(
    `- Independent missed SELL bars: ${report.counts.independentMissedSellBars}; repeated: ${report.counts.repeatedMissedSellBars}`
  );
  lines.push(
    `- Missed SELL FT-passing: ${report.counts.missedSellPassingForwardTrial}; all FT-blocked: ${report.counts.missedSellBlockedByForwardTrial}`
  );
  lines.push(`- Missed SELL by strategy: ${JSON.stringify(report.counts.missedSellByStrategy)}`);
  lines.push("");
  lines.push(`## Pass A vs Pass C (economic R)`);
  lines.push(`Entry: ${report.economic.entryConvention} — ${report.economic.entryConventionNote}`);
  lines.push(`Positions: ${report.economic.positionModel} — ${report.economic.positionModelNote}`);
  lines.push("");
  const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
  const num = (n: number | null, digits = 2) => (n == null ? "—" : n.toFixed(digits));
  const row = (label: string, a: string, c: string) => `- ${label}: A ${a} | C ${c}`;
  lines.push(
    row("Trades (signals)", String(report.economic.passA.totalSignals), String(report.economic.passC.totalSignals))
  );
  lines.push(
    row(
      "Resolved trades (TARGET+STOP)",
      String(report.economic.passA.targetHits + report.economic.passA.stopHits),
      String(report.economic.passC.targetHits + report.economic.passC.stopHits)
    )
  );
  lines.push(row("Win rate", pct(report.economic.passA.winRate), pct(report.economic.passC.winRate)));
  lines.push(
    row("Total R", num(report.economic.passA.totalRealizedR), num(report.economic.passC.totalRealizedR))
  );
  lines.push(
    row(
      "Avg R/trade",
      num(report.economic.passA.avgRPerResolvedTrade),
      num(report.economic.passC.avgRPerResolvedTrade)
    )
  );
  lines.push(
    row("Max drawdown (R)", num(report.economic.passA.maxDrawdownR), num(report.economic.passC.maxDrawdownR))
  );
  lines.push(
    row("Ambiguous", String(report.economic.passA.ambiguous), String(report.economic.passC.ambiguous))
  );
  lines.push(
    row("Unscorable", String(report.economic.passA.unscorable), String(report.economic.passC.unscorable))
  );
  lines.push(
    row("Open at end", String(report.economic.passA.openAtEnd), String(report.economic.passC.openAtEnd))
  );
  lines.push(
    `- Pass C from production HOLD: signals ${report.economic.passC.fromProductionHoldSignals}; resolved trades ${report.economic.passC.fromProductionHoldResolvedTrades}; resolved R ${num(report.economic.passC.fromProductionHoldResolvedR)}`
  );
  lines.push(`- Pass A by strategy: ${JSON.stringify(report.economic.passA.byStrategy)}`);
  lines.push(`- Pass C by strategy: ${JSON.stringify(report.economic.passC.byStrategy)}`);
  lines.push("");
  lines.push(...formatFallbackFromHoldDiagnosticsMarkdown(report.economic.passCFallbackFromHold));
  lines.push("");
  lines.push(...formatEmaFallbackFromHoldMarkdown(report.economic.emaFallbackFromHold));
  lines.push("");
  lines.push(`## Note`);
  lines.push(
    `- R-multiple comparison only — no stake/lot money PnL; not a profitability claim.`
  );
  lines.push(
    `- Selector-mechanics counts above remain valid independently of economic scoring.`
  );
  lines.push("");
  lines.push(`## Examples (up to 25)`);
  if (report.examples.length === 0) {
    lines.push(`- None`);
  } else {
    for (const e of report.examples) {
      const shadowBuys = e.shadow.filter((s) => s.action === "BUY");
      const shadowSells = e.shadow.filter((s) => s.action === "SELL");
      lines.push(
        `- ${new Date(e.openTimeMs).toISOString()} close=${e.close} regime=${e.regime}(${e.regimeConfidence.toFixed(2)}) prod=${e.production.selectedStrategyId}/${e.production.evaluation?.action ?? "none"} fallback=${e.fallback.selectedStrategyId ?? "none"}/${e.fallback.action ?? "HOLD"} rank=[${e.fallback.rankingOrder.join(">")}] shadowBUY=[${shadowBuys.map((s) => `${s.strategyId}${s.forwardTrialBlocked ? "!FT" : ""}`).join(",")}] shadowSELL=[${shadowSells.map((s) => `${s.strategyId}${s.forwardTrialBlocked ? "!FT" : ""}`).join(",")}]`
      );
      for (const s of [...shadowBuys, ...shadowSells].slice(0, 4)) {
        lines.push(
          `  - ${s.strategyId} ${s.action}: ${s.entryReason.slice(0, 2).join("; ") || s.invalidationReason.slice(0, 1).join("; ")} | FT=${s.forwardTrialReason ?? "ok"}`
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
