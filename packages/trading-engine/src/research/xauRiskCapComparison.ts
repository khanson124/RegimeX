/**
 * Research-only XAUUSD broker-min-volume risk-cap comparison for xau-trend-pullback-v1.
 *
 * Two modes:
 * - CONTROLLED_SHARED_SIGNAL: one signal stream (cooldown advances on every BUY/SELL) shared by
 *   every cap, so a cap only decides whether a signal can be sized at the broker minimum lot
 *   (DefaultPositionSizingService.calculateRaw → resolveMt5EngineVolume).
 * - PRODUCTION_FAITHFUL_CHRONOLOGICAL: each cap walks the bars independently and advances the
 *   cooldown via shouldConsumeStrategySignalCooldown, as the live MT5 session does, so rejected
 *   signals leave the strategy eligible on later bars.
 *
 * Stops, targets and R outcomes never depend on the cap. Economic outcomes reuse the
 * counterfactual replay simulator: NEXT_CANDLE_OPEN entry, proposeCfdStopTarget plan (strategy
 * stop/target preserved via metadata), same-bar stop+target = AMBIGUOUS, single position per
 * variant. No spread/commission/slippage.
 */
import {
  type Candle,
  type InstrumentMetadata,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type RegimeResult,
  type StrategyDecision
} from "@regimex/shared";
import {
  MIN_VOLUME_EXCEEDS_RISK,
  resolveMt5EngineVolume,
  type Mt5EngineVolumeDecision
} from "../broker/mt5/engineVolume.js";
import { shouldConsumeStrategySignalCooldown } from "../broker/mt5/strategySignalCooldown.js";
import { validateCandleOhlc } from "../candles/candleIntegrity.js";
import {
  XAU_TREND_PULLBACK_H4_MINIMUM_BARS,
  XAU_TREND_PULLBACK_M15_MINIMUM_BARS
} from "../candles/mt5MtfWarmup.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { DEFAULT_FEATURE_CONFIG, extractFeatures } from "../features/featureExtractor.js";
import { XauTrendPullbackStrategy, XAU_TREND_PULLBACK_DEFAULTS } from "../strategies/xauTrendPullback.js";
import { type TradingStrategy } from "../strategies/types.js";
import {
  aggregatePassEconomicMetrics,
  buildReplayTradePlan,
  simulatePassEconomicOutcomes,
  type ReplayEconomicSignal,
  type ReplayPassEconomicMetrics,
  type ReplaySimulatedTrade,
  type ReplayTradePlanSnapshot
} from "./autoSelectionReplayOutcomes.js";
import {
  analyzeCandleContinuity,
  type ReplayCandleContinuityDiagnostics
} from "./autoSelectionReplaySimulationDiagnostics.js";

export const XAU_RISK_CAP_STRATEGY_ID = "xau-trend-pullback-v1";
export const XAU_RISK_CAP_PERCENTS = [0.1, 0.2, 0.25, 0.3, 0.35] as const;
export const XAU_RISK_CAP_CURRENT_DEMO_PERCENT = 0.1;
export const XAU_BROKER_MIN_VOLUME = 0.01;
export const XAU_BROKER_VOLUME_STEP = 0.01;
/** Mirrors LiveEngineSession.resolveCandleBufferCapacity for the XAU M15 warm-up requirement. */
export const XAU_M15_BUFFER_CAPACITY = Math.max(1500, XAU_TREND_PULLBACK_M15_MINIMUM_BARS + 100);
/** Mirrors the live MT5 context restore window: max(minimumBars + 20, 120) completed H4 bars. */
export const XAU_H4_CONTEXT_WINDOW = Math.max(XAU_TREND_PULLBACK_H4_MINIMUM_BARS + 20, 120);
export const XAU_REPLAY_FEATURE_LOOKBACK = 1500;
export const UNSCORABLE_PLAN = "UNSCORABLE_PLAN";

const M15_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/** xau-trend-pullback-v1 reads neither `features` nor `regime` (see XauTrendPullbackStrategy.evaluate). */
const PLACEHOLDER_REGIME: RegimeResult = {
  regime: "UNKNOWN",
  confidence: 0,
  scores: { trend: 0, momentum: 0, volatility: 0, range: 0, breakout: 0 },
  reasons: [],
  timestamp: 0,
  classifierVersion: "xau-risk-cap-research-placeholder"
};

export function capKey(capPercent: number): string {
  return `${capPercent.toFixed(2)}%`;
}

export interface XauSignalGenerationResult {
  signals: ReplayEconomicSignal[];
  decisions: Array<{ candleIndex: number; decision: StrategyDecision }>;
  evaluatedBars: number;
  holdReasonCounts: Record<string, number>;
  firstBarWithFullWarmupIso: string | null;
  barsWithInsufficientH4: number;
}

export interface XauStrategyWalkInput {
  m15: ReadonlyArray<Candle>;
  h4: ReadonlyArray<Candle>;
  analysisStartMs: number;
  analysisEndMs: number;
  parameters: Record<string, number | boolean | string>;
  strategy?: TradingStrategy;
  m15BufferCapacity?: number;
  h4ContextWindow?: number;
  /** Decisions keyed by `${candleIndex}:${candlesSinceLastSignal}`; valid only for one strategy + parameter set. */
  evaluationCache?: Map<string, StrategyDecision>;
}

/**
 * Evaluate the strategy on every analysis-window M15 close exactly once, as the live session does:
 * rolling native-15m buffer and completed native H4 context as-of the M15 close. `onSignal` decides
 * whether a BUY/SELL consumes the cooldown (live: lastSignalCandle = candleIndex).
 */
function walkXauStrategy(
  input: XauStrategyWalkInput,
  onSignal: (candleIndex: number, decision: StrategyDecision, candlesSinceLastSignal: number) => boolean
): XauSignalGenerationResult {
  const strategy = input.strategy ?? new XauTrendPullbackStrategy();
  const cap = input.m15BufferCapacity ?? XAU_M15_BUFFER_CAPACITY;
  const h4Window = input.h4ContextWindow ?? XAU_H4_CONTEXT_WINDOW;
  const signals: ReplayEconomicSignal[] = [];
  const decisions: XauSignalGenerationResult["decisions"] = [];
  const holdReasonCounts: Record<string, number> = {};
  let lastSignal: number | undefined;
  let evaluatedBars = 0;
  let firstWarm: number | null = null;
  let barsWithInsufficientH4 = 0;
  let h4Ptr = -1;

  for (let i = 0; i < input.m15.length; i++) {
    const bar = input.m15[i]!;
    while (h4Ptr + 1 < input.h4.length && input.h4[h4Ptr + 1]!.closeTime <= bar.closeTime) h4Ptr++;
    if (bar.openTime < input.analysisStartMs || bar.openTime >= input.analysisEndMs) continue;
    evaluatedBars += 1;

    const window = input.m15.slice(Math.max(0, i + 1 - cap), i + 1);
    const h4Ctx = h4Ptr >= 0 ? input.h4.slice(Math.max(0, h4Ptr + 1 - h4Window), h4Ptr + 1) : [];
    if (h4Ctx.length < XAU_TREND_PULLBACK_H4_MINIMUM_BARS) barsWithInsufficientH4 += 1;
    else if (firstWarm == null && window.length >= strategy.minimumHistory) firstWarm = bar.openTime;

    const since = lastSignal === undefined ? Number.POSITIVE_INFINITY : i - lastSignal;
    const cacheKey = `${i}:${since}`;
    let decision = input.evaluationCache?.get(cacheKey);
    if (!decision) {
      decision = strategy.evaluate({
        candles: window,
        features: [] as MarketFeatureSnapshot[],
        regime: { ...PLACEHOLDER_REGIME, timestamp: bar.closeTime },
        parameters: input.parameters,
        candlesSinceLastSignal: since,
        contextCandles: h4Ctx.length > 0 ? { "4h": h4Ctx } : undefined
      });
      input.evaluationCache?.set(cacheKey, decision);
    }
    decisions.push({ candleIndex: i, decision });

    if (decision.action === "BUY" || decision.action === "SELL") {
      if (onSignal(i, decision, since)) lastSignal = i;
      signals.push(toEconomicSignal(i, decision));
    } else {
      const codes = (decision.metadata?.entryQualityReasonCodes as string[] | undefined) ?? ["HOLD"];
      for (const c of codes) holdReasonCounts[c] = (holdReasonCounts[c] ?? 0) + 1;
    }
  }

  return {
    signals,
    decisions,
    evaluatedBars,
    holdReasonCounts,
    firstBarWithFullWarmupIso: firstWarm == null ? null : new Date(firstWarm).toISOString(),
    barsWithInsufficientH4
  };
}

function toEconomicSignal(candleIndex: number, decision: StrategyDecision): ReplayEconomicSignal {
  return {
    pass: "C",
    signalCandleIndex: candleIndex,
    evaluation: {
      strategyId: decision.strategyId,
      action: decision.action,
      confidence: decision.confidence,
      signalTimestampMs: decision.signalTimestamp,
      decisionMetadata: (decision.metadata ?? {}) as Record<string, unknown>
    },
    fromProductionHold: false
  };
}

/** CONTROLLED_SHARED_SIGNAL stream: the cooldown advances on every BUY/SELL, independent of any cap. */
export function generateXauTrendPullbackSignals(input: XauStrategyWalkInput): XauSignalGenerationResult {
  return walkXauStrategy(input, () => true);
}

export interface BrokerMinVolumeAdmission {
  admitted: boolean;
  reasonCode: string | null;
  rawVolume: number | null;
  allowedRiskAmount: number | null;
  riskAtBrokerMinVolume: number | null;
  finalVolume: number | null;
  volume: Mt5EngineVolumeDecision | null;
}

/** Production MT5 sizing chain for one entry/stop at one risk %. */
export function evaluateBrokerMinVolumeAdmission(input: {
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  equity: number;
  riskPercent: number;
  instrument: InstrumentMetadata;
  engineMaxVolume: number;
}): BrokerMinVolumeAdmission {
  const raw = new DefaultPositionSizingService().calculateRaw({
    equity: input.equity,
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    riskPerTradePercent: input.riskPercent,
    instrument: input.instrument
  });
  if (!raw.success || raw.rawVolume == null) {
    return {
      admitted: false,
      reasonCode: "RISK_BLOCKED",
      rawVolume: null,
      allowedRiskAmount: raw.riskAmount,
      riskAtBrokerMinVolume: null,
      finalVolume: null,
      volume: null
    };
  }
  const volume = resolveMt5EngineVolume({
    equity: input.equity,
    riskPerTradePercent: input.riskPercent,
    riskSizedVolume: raw.rawVolume,
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    instrument: input.instrument,
    engineMaxVolume: input.engineMaxVolume
  });
  return {
    admitted: volume.wouldSubmit && volume.finalVolume != null,
    reasonCode: volume.reasonCode,
    rawVolume: raw.rawVolume,
    allowedRiskAmount: volume.allowedRiskAmount,
    riskAtBrokerMinVolume: volume.riskAtBrokerMinVolume,
    finalVolume: volume.finalVolume,
    volume
  };
}

/** The simulator's NEXT_CANDLE_OPEN trade plan for a signal (same inputs as simulatePassEconomicOutcomes). */
function planAtNextOpen(
  m15: ReadonlyArray<Candle>,
  s: ReplayEconomicSignal,
  parameters: Record<string, number | boolean | string>,
  tickSize: number
): { entryCandle: Candle | undefined; plan: ReplayTradePlanSnapshot | null; scorable: boolean } {
  const entryCandle = m15[s.signalCandleIndex + 1];
  let plan: ReplayTradePlanSnapshot | null = null;
  if (entryCandle) {
    const window = m15.slice(Math.max(0, s.signalCandleIndex + 1 - XAU_REPLAY_FEATURE_LOOKBACK), s.signalCandleIndex + 1);
    const features = extractFeatures(window, DEFAULT_FEATURE_CONFIG).at(-1);
    if (features) {
      plan = buildReplayTradePlan({
        strategyId: s.evaluation.strategyId,
        action: s.evaluation.action as PositionDirection,
        confidence: s.evaluation.confidence,
        signalTimestampMs: s.evaluation.signalTimestampMs,
        entryPrice: entryCandle.open,
        features,
        candles: window,
        metadata: s.evaluation.decisionMetadata,
        tickSize,
        parameters
      });
    }
  }
  const scorable = !!plan?.scorable && plan.stopLoss != null && plan.takeProfit != null && entryCandle != null;
  return { entryCandle, plan, scorable };
}

/** Mirrors Mt5CfdRuntime's mapping of a failed volume decision to an autonomous decision code. */
function volumeRejectionDecisionCode(reasonCode: string | null): string {
  return reasonCode === MIN_VOLUME_EXCEEDS_RISK ||
    reasonCode === "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME" ||
    reasonCode === "STOP_INVALID"
    ? reasonCode
    : "RISK_BLOCKED";
}

export const PRODUCTION_FAITHFUL_COOLDOWN_POLICY =
  "shouldConsumeStrategySignalCooldown({ opened, decisionCode }) per cap — OPENED consumes; MIN_VOLUME_EXCEEDS_RISK, MAX_CONCURRENT_POSITIONS (position open) and STOP_INVALID do not";

export type XauProductionSignalOutcome = "OPENED" | "SKIPPED_OPEN_POSITION" | "UNSCORABLE_PLAN" | "VOLUME_REJECTED";

export interface XauProductionSignalEvent {
  signalCandleIndex: number;
  signalTimeIso: string;
  direction: PositionDirection;
  /** null = no prior consumed signal (live: POSITIVE_INFINITY). */
  candlesSinceLastSignal: number | null;
  outcome: XauProductionSignalOutcome;
  /** Autonomous decision code the live MT5 runtime would return for this signal. */
  decisionCode: string;
  cooldownConsumed: boolean;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskAtBrokerMinVolume: number | null;
}

export interface XauProductionFaithfulCapResult {
  capPercent: number;
  capKey: string;
  strategyEvaluations: number;
  signalsGenerated: number;
  buySignals: number;
  sellSignals: number;
  rejectedMinVolumeExceedsRisk: number;
  rejectedOther: Record<string, number>;
  admittedSignals: number;
  entries: number;
  skippedCooldown: number;
  skippedOpenPosition: number;
  cooldownConsumptions: number;
  resolvedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  openAtEnd: number;
  ambiguous: number;
  byDirection: Record<PositionDirection, XauGroupStats>;
  holdReasonCounts: Record<string, number>;
  /** The replay simulator, fed this cap's signal path + admission gate, reproduces the chronological trades. */
  simulatorCrossCheck: { matches: boolean; mismatches: string[] };
  events: XauProductionSignalEvent[];
  metrics: ReplayPassEconomicMetrics;
  trades: ReplaySimulatedTrade[];
}

/**
 * PRODUCTION_FAITHFUL_CHRONOLOGICAL for one cap: walk every M15 close with this cap's own cooldown
 * and position state. A BUY/SELL while a position is open is blocked by the capacity gate
 * (MAX_CONCURRENT_POSITIONS, evaluated before sizing live); otherwise it is sized at the next open
 * with the original stop. Cooldown advances only when shouldConsumeStrategySignalCooldown says so.
 */
export function simulateXauProductionFaithfulCap(input: XauStrategyWalkInput & {
  capPercent: number;
  equity: number;
  instrument: InstrumentMetadata;
  engineMaxVolume: number;
}): XauProductionFaithfulCapResult {
  const strategy = input.strategy ?? new XauTrendPullbackStrategy();
  const tickSize = input.instrument.tickSize;
  const paramsById = new Map([[strategy.id, input.parameters]]);
  const admission = (direction: PositionDirection, entryPrice: number, stopLoss: number) =>
    evaluateBrokerMinVolumeAdmission({
      direction,
      entryPrice,
      stopLoss,
      equity: input.equity,
      riskPercent: input.capPercent,
      instrument: input.instrument,
      engineMaxVolume: input.engineMaxVolume
    });

  const events: XauProductionSignalEvent[] = [];
  const chronologicalTrades: ReplaySimulatedTrade[] = [];
  let open: ReplaySimulatedTrade | null = null;

  const walk = walkXauStrategy({ ...input, strategy }, (i, decision, since) => {
    const sig = toEconomicSignal(i, decision);
    const direction = decision.action as PositionDirection;
    // Simulator order per bar: enter pending → resolve open against the bar → queue signals if flat.
    if (open && (open.outcome === "OPEN_AT_END" || open.exitCandleIndex == null || open.exitCandleIndex > i)) {
      events.push(eventOf(i, decision, since, "SKIPPED_OPEN_POSITION", "MAX_CONCURRENT_POSITIONS", false, null, null));
      return false;
    }
    open = null;
    const { entryCandle, plan, scorable } = planAtNextOpen(input.m15, sig, input.parameters, tickSize);
    if (!scorable) {
      const consumed = shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "STOP_INVALID" });
      events.push(eventOf(i, decision, since, "UNSCORABLE_PLAN", "STOP_INVALID", consumed, plan, entryCandle?.open ?? null));
      return consumed;
    }
    const a = admission(direction, entryCandle!.open, plan!.stopLoss!);
    if (!a.admitted) {
      const code = volumeRejectionDecisionCode(a.reasonCode);
      const consumed = shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: code });
      events.push({ ...eventOf(i, decision, since, "VOLUME_REJECTED", code, consumed, plan, entryCandle!.open), riskAtBrokerMinVolume: a.riskAtBrokerMinVolume });
      return consumed;
    }
    const trade = simulatePassEconomicOutcomes({
      candles: input.m15,
      signals: [sig],
      parametersByStrategyId: paramsById,
      tickSize,
      featureLookback: XAU_REPLAY_FEATURE_LOOKBACK
    }).trades[0]!;
    open = trade;
    chronologicalTrades.push(trade);
    const consumed = shouldConsumeStrategySignalCooldown({ opened: true, decisionCode: "OPENED" });
    events.push({ ...eventOf(i, decision, since, "OPENED", "OPENED", consumed, plan, entryCandle!.open), riskAtBrokerMinVolume: a.riskAtBrokerMinVolume });
    return consumed;
  });

  const econ = simulatePassEconomicOutcomes({
    candles: input.m15,
    signals: walk.signals,
    parametersByStrategyId: paramsById,
    tickSize,
    featureLookback: XAU_REPLAY_FEATURE_LOOKBACK,
    entryGate: (ctx) => {
      if (ctx.plan.stopLoss == null) return { reject: true, reason: UNSCORABLE_PLAN };
      const a = admission(ctx.direction, ctx.entryPrice, ctx.plan.stopLoss);
      return a.admitted ? { reject: false, reason: null } : { reject: true, reason: a.reasonCode ?? "NO_TRADE" };
    }
  });
  const trades = econ.trades.filter((t) => t.pass === "C");
  const entered = trades.filter((t) => t.outcome !== "UNSCORABLE");
  const d = econ.simulationDiagnostics.C;
  const mismatches: string[] = [];
  if (JSON.stringify(entered) !== JSON.stringify(chronologicalTrades)) mismatches.push("entered trades differ from chronological opens");
  const skippedOpen = events.filter((e) => e.outcome === "SKIPPED_OPEN_POSITION").length;
  if (d.signalsSkippedOpenPosition !== skippedOpen) mismatches.push(`skipped-open ${d.signalsSkippedOpenPosition} vs ${skippedOpen}`);
  const volumeRejected = events.filter((e) => e.outcome === "VOLUME_REJECTED");
  if (d.signalsRejectedByResearchGate !== volumeRejected.length) mismatches.push(`gate rejections ${d.signalsRejectedByResearchGate} vs ${volumeRejected.length}`);

  const metrics = aggregatePassEconomicMetrics(trades);
  const all = tradeStats(trades);
  return {
    capPercent: input.capPercent,
    capKey: capKey(input.capPercent),
    strategyEvaluations: walk.evaluatedBars,
    signalsGenerated: walk.signals.length,
    buySignals: walk.signals.filter((s) => s.evaluation.action === "BUY").length,
    sellSignals: walk.signals.filter((s) => s.evaluation.action === "SELL").length,
    rejectedMinVolumeExceedsRisk: volumeRejected.filter((e) => e.decisionCode === MIN_VOLUME_EXCEEDS_RISK).length,
    rejectedOther: tally(
      events.filter((e) => e.outcome === "UNSCORABLE_PLAN" || (e.outcome === "VOLUME_REJECTED" && e.decisionCode !== MIN_VOLUME_EXCEEDS_RISK)),
      (e) => e.decisionCode
    ),
    admittedSignals: events.filter((e) => e.outcome === "OPENED").length,
    entries: all.entries,
    skippedCooldown: walk.holdReasonCounts.COOLDOWN_ACTIVE ?? 0,
    skippedOpenPosition: skippedOpen,
    cooldownConsumptions: events.filter((e) => e.cooldownConsumed).length,
    resolvedTrades: all.resolved,
    wins: all.wins,
    losses: all.losses,
    winRate: all.winRate,
    totalR: all.totalR,
    avgR: all.avgR,
    maxDrawdownR: metrics.maxDrawdownR,
    longestLosingStreak: metrics.longestLosingStreak,
    openAtEnd: all.openAtEnd,
    ambiguous: all.ambiguous,
    byDirection: {
      BUY: tradeStats(trades.filter((t) => t.direction === "BUY")),
      SELL: tradeStats(trades.filter((t) => t.direction === "SELL"))
    },
    holdReasonCounts: walk.holdReasonCounts,
    simulatorCrossCheck: { matches: mismatches.length === 0, mismatches },
    events,
    metrics,
    trades
  };
}

function eventOf(
  i: number,
  decision: StrategyDecision,
  since: number,
  outcome: XauProductionSignalOutcome,
  decisionCode: string,
  cooldownConsumed: boolean,
  plan: ReplayTradePlanSnapshot | null,
  entryPrice: number | null
): XauProductionSignalEvent {
  return {
    signalCandleIndex: i,
    signalTimeIso: new Date(decision.signalTimestamp).toISOString(),
    direction: decision.action as PositionDirection,
    candlesSinceLastSignal: Number.isFinite(since) ? since : null,
    outcome,
    decisionCode,
    cooldownConsumed,
    entryPrice,
    stopLoss: plan?.stopLoss ?? null,
    takeProfit: plan?.takeProfit ?? null,
    riskAtBrokerMinVolume: null
  };
}

export interface XauModeDivergenceRow {
  capPercent: number;
  capKey: string;
  controlledSignals: number;
  productionFaithfulSignals: number;
  signalsUniqueToControlled: number;
  signalsUniqueToProductionFaithful: number;
  controlledEntries: number;
  productionFaithfulEntries: number;
  entriesUniqueToControlled: number;
  entriesUniqueToProductionFaithful: number;
  controlledTotalR: number;
  productionFaithfulTotalR: number;
  /** Production-faithful total R − controlled total R. */
  totalRDifference: number;
  uniqueToControlledSignalTimes: string[];
  uniqueToProductionFaithfulSignalTimes: string[];
}

export interface XauRiskCapSignalRow {
  signalCandleIndex: number;
  signalTimeIso: string;
  direction: PositionDirection;
  strategyStopLoss: number | null;
  strategyTakeProfit: number | null;
  intendedR: number | null;
  entryTimeIso: string | null;
  entryPrice: number | null;
  plan: ReplayTradePlanSnapshot | null;
  stopDistance: number | null;
  riskAtBrokerMinVolume: number | null;
  /** Account risk % needed to trade exactly the broker minimum lot at this stop. */
  requiredRiskPercentForMinLot: number | null;
  admissionByCap: Record<string, { admitted: boolean; reasonCode: string | null; rawVolume: number | null; finalVolume: number | null }>;
  lowestAdmittingCapPercent: number | null;
  admissionBand: string;
  /** This signal alone, ignoring other positions (same simulator, single-signal run). */
  standalone: Pick<ReplaySimulatedTrade, "outcome" | "realizedR" | "barsHeld"> & { exitTimeIso: string | null };
}

export interface XauGroupStats {
  signals: number;
  entries: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  ambiguous: number;
  openAtEnd: number;
  unscorable: number;
}

export interface XauRiskCapVariantResult {
  capPercent: number;
  capKey: string;
  totalStrategySignals: number;
  signalsAdmitted: number;
  signalsRejectedMinVolumeExceedsRisk: number;
  signalsRejectedOther: Record<string, number>;
  admissionRate: number | null;
  simulation: {
    signalsSeen: number;
    gateRejections: number;
    entries: number;
    resolvedTrades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalR: number;
    avgR: number | null;
    maxDrawdownR: number;
    longestLosingStreak: number;
    openAtEnd: number;
    ambiguous: number;
    skippedWhilePositionOpen: number;
    byDirection: Record<PositionDirection, XauGroupStats>;
  };
  metrics: ReplayPassEconomicMetrics;
  trades: ReplaySimulatedTrade[];
}

export interface XauIncrementRow {
  fromCapPercent: number;
  toCapPercent: number;
  /** Signals admitted at `to` but not `from`, each scored standalone. */
  newlyAdmittedSignals: XauGroupStats;
  /** Single-position simulation: trades present at `to` but not `from`. */
  simulatedTradesAdded: XauGroupStats;
  /** Single-position simulation: trades present at `from` but displaced at `to`. */
  simulatedTradesDisplaced: XauGroupStats;
  simulatedNetDeltaR: number;
  reconciles: boolean;
}

export interface XauDataIntegrity {
  analysisStartIso: string;
  analysisEndIso: string;
  m15: {
    rowsLoaded: number;
    completeCleanCandles: number;
    analysisWindowCandles: number;
    excludedByRestoreFilter: number;
    restoreFilterDiagnostics: string[];
    sources: Record<string, number>;
    firstIso: string | null;
    lastIso: string | null;
    gaps: { count: number; weekendGaps: number; nonWeekendGaps: number; missingBars: number; largest: Array<{ afterIso: string; nextIso: string; missingBars: number; weekend: boolean }> };
    malformed: Record<string, number>;
    continuity: ReplayCandleContinuityDiagnostics;
  };
  h4: {
    rowsLoaded: number;
    completeCleanCandles: number;
    sources: Record<string, number>;
    firstIso: string | null;
    lastIso: string | null;
    malformed: Record<string, number>;
    gaps: number;
    analysisBarsWithInsufficientH4: number;
    firstBarWithFullWarmupIso: string | null;
  };
}

export interface XauRiskCapComparisonReport {
  generatedAtIso: string;
  kind: "XAU_RISK_CAP_BROKER_MIN_VOLUME_COMPARISON";
  config: {
    symbol: string;
    interval: "15m";
    strategyId: string;
    parameters: Record<string, number | boolean | string>;
    parametersSource: string;
    equity: number;
    riskCapsPercent: number[];
    currentDemoRiskCapPercent: number;
    instrument: InstrumentMetadata;
    instrumentSource: string;
    engineMaxVolume: number;
    m15BufferCapacity: number;
    h4ContextWindow: number;
  };
  signalGeneration: {
    evaluatedBars: number;
    strategySignals: number;
    buy: number;
    sell: number;
    holdReasonCounts: Record<string, number>;
    cooldownPolicy: string;
  };
  variants: XauRiskCapVariantResult[];
  admissionBands: Array<{ band: string; stats: XauGroupStats }>;
  increments: XauIncrementRow[];
  reconciliation: {
    admissionMonotonic: boolean;
    monotonicViolations: number;
    identicalSignalSetAcrossVariants: boolean;
    bandsSumToAdmittedStandalone: boolean;
    simulatedIncrementsReconcile: boolean;
    requiredPercentBandMismatches: number;
  };
  signals: XauRiskCapSignalRow[];
  dataIntegrity: XauDataIntegrity;
  limitations: string[];
  comparisonModes: {
    controlled: { id: "CONTROLLED_SHARED_SIGNAL"; purpose: string };
    productionFaithful: { id: "PRODUCTION_FAITHFUL_CHRONOLOGICAL"; purpose: string };
  };
  productionFaithful: {
    cooldownPolicy: string;
    variants: XauProductionFaithfulCapResult[];
    simulatorCrossCheckAllMatch: boolean;
    limitations: string[];
  };
  divergence: XauModeDivergenceRow[];
}

function emptyStats(): XauGroupStats {
  return { signals: 0, entries: 0, resolved: 0, wins: 0, losses: 0, winRate: null, totalR: 0, avgR: null, ambiguous: 0, openAtEnd: 0, unscorable: 0 };
}

function addOutcome(s: XauGroupStats, outcome: ReplaySimulatedTrade["outcome"], realizedR: number | null, entered: boolean): void {
  s.signals += 1;
  if (entered) s.entries += 1;
  if (outcome === "TARGET" || outcome === "STOP") {
    s.resolved += 1;
    s.totalR += realizedR ?? 0;
    if (outcome === "TARGET") s.wins += 1;
    else s.losses += 1;
  } else if (outcome === "AMBIGUOUS") s.ambiguous += 1;
  else if (outcome === "OPEN_AT_END") s.openAtEnd += 1;
  else s.unscorable += 1;
}

function finishStats(s: XauGroupStats): XauGroupStats {
  s.winRate = s.resolved > 0 ? s.wins / s.resolved : null;
  s.avgR = s.resolved > 0 ? s.totalR / s.resolved : null;
  return s;
}

function tradeStats(trades: ReadonlyArray<ReplaySimulatedTrade>): XauGroupStats {
  const s = emptyStats();
  for (const t of trades) addOutcome(s, t.outcome, t.realizedR, t.outcome !== "UNSCORABLE" && t.entryTimeMs != null);
  return finishStats(s);
}

function rowStats(rows: ReadonlyArray<XauRiskCapSignalRow>): XauGroupStats {
  const s = emptyStats();
  for (const r of rows) addOutcome(s, r.standalone.outcome, r.standalone.realizedR, r.entryPrice != null && r.standalone.outcome !== "UNSCORABLE");
  return finishStats(s);
}

export function admissionBandLabel(lowestAdmittingCap: number | null, caps: ReadonlyArray<number>, scorable: boolean): string {
  if (!scorable) return UNSCORABLE_PLAN;
  if (lowestAdmittingCap == null) return `>${caps[caps.length - 1]!.toFixed(2)}%`;
  const idx = caps.indexOf(lowestAdmittingCap);
  return idx <= 0
    ? `<=${lowestAdmittingCap.toFixed(2)}%`
    : `>${caps[idx - 1]!.toFixed(2)} to <=${lowestAdmittingCap.toFixed(2)}%`;
}

function bandFromRequiredPercent(required: number | null, caps: ReadonlyArray<number>): string {
  if (required == null) return UNSCORABLE_PLAN;
  const lowest = caps.find((c) => required <= c + 1e-12) ?? null;
  return admissionBandLabel(lowest, caps, true);
}

function tally<T>(items: ReadonlyArray<T>, key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function malformedCounts(candles: ReadonlyArray<Candle>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candles) {
    const v = validateCandleOhlc(c);
    if (!v.valid) out[v.code] = (out[v.code] ?? 0) + 1;
  }
  return out;
}

function spansWeekend(fromMs: number, toMs: number): boolean {
  for (let t = fromMs; t <= toMs; t += DAY_MS / 4) {
    const d = new Date(t).getUTCDay();
    if (d === 6 || d === 0) return true;
  }
  return false;
}

function m15Gaps(candles: ReadonlyArray<Candle>): XauDataIntegrity["m15"]["gaps"] {
  const all: Array<{ afterIso: string; nextIso: string; missingBars: number; weekend: boolean }> = [];
  let missingBars = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (dt <= M15_MS * 1.5) continue;
    const missing = Math.round(dt / M15_MS) - 1;
    missingBars += missing;
    all.push({
      afterIso: new Date(candles[i - 1]!.openTime).toISOString(),
      nextIso: new Date(candles[i]!.openTime).toISOString(),
      missingBars: missing,
      weekend: spansWeekend(candles[i - 1]!.openTime, candles[i]!.openTime)
    });
  }
  const weekendGaps = all.filter((g) => g.weekend).length;
  return {
    count: all.length,
    weekendGaps,
    nonWeekendGaps: all.length - weekendGaps,
    missingBars,
    largest: [...all].sort((a, b) => b.missingBars - a.missingBars).slice(0, 15)
  };
}

export function runXauRiskCapComparison(input: {
  symbol: string;
  /** Clean complete native 15m candles (warm-up + analysis), ascending. */
  m15: ReadonlyArray<Candle>;
  /** Clean complete native H4 context candles, ascending. */
  h4: ReadonlyArray<Candle>;
  analysisStartMs: number;
  analysisEndMs: number;
  equity: number;
  instrument: InstrumentMetadata;
  engineMaxVolume: number;
  riskCapsPercent?: ReadonlyArray<number>;
  parameters?: Record<string, number | boolean | string>;
  parametersSource?: string;
  instrumentSource?: string;
  strategy?: TradingStrategy;
  integrityInputs?: {
    m15RowsLoaded: number;
    m15RestoreDiagnostics: string[];
    m15Raw: ReadonlyArray<Candle>;
    h4RowsLoaded: number;
    h4Raw: ReadonlyArray<Candle>;
  };
  extraLimitations?: string[];
}): XauRiskCapComparisonReport {
  const caps = [...(input.riskCapsPercent ?? XAU_RISK_CAP_PERCENTS)].sort((a, b) => a - b);
  const strategy = input.strategy ?? new XauTrendPullbackStrategy();
  const parameters = input.parameters ?? { ...XAU_TREND_PULLBACK_DEFAULTS };
  const m15 = [...input.m15].sort((a, b) => a.openTime - b.openTime);
  const h4 = [...input.h4].sort((a, b) => a.openTime - b.openTime);
  const tickSize = input.instrument.tickSize;
  const paramsById = new Map([[strategy.id, parameters]]);

  const evaluationCache = new Map<string, StrategyDecision>();
  const gen = generateXauTrendPullbackSignals({
    m15,
    h4,
    analysisStartMs: input.analysisStartMs,
    analysisEndMs: input.analysisEndMs,
    parameters,
    strategy,
    evaluationCache
  });

  const admission = (direction: PositionDirection, entryPrice: number, stopLoss: number, riskPercent: number) =>
    evaluateBrokerMinVolumeAdmission({
      direction,
      entryPrice,
      stopLoss,
      equity: input.equity,
      riskPercent,
      instrument: input.instrument,
      engineMaxVolume: input.engineMaxVolume
    });

  const rows: XauRiskCapSignalRow[] = gen.signals.map((s) => {
    const direction = s.evaluation.action as PositionDirection;
    const meta = s.evaluation.decisionMetadata;
    const { entryCandle, plan, scorable } = planAtNextOpen(m15, s, parameters, tickSize);
    const admissionByCap: XauRiskCapSignalRow["admissionByCap"] = {};
    let riskAtMin: number | null = null;
    for (const cap of caps) {
      if (!scorable) {
        admissionByCap[capKey(cap)] = { admitted: false, reasonCode: UNSCORABLE_PLAN, rawVolume: null, finalVolume: null };
        continue;
      }
      const a = admission(direction, entryCandle!.open, plan!.stopLoss!, cap);
      riskAtMin = a.riskAtBrokerMinVolume ?? riskAtMin;
      admissionByCap[capKey(cap)] = { admitted: a.admitted, reasonCode: a.reasonCode, rawVolume: a.rawVolume, finalVolume: a.finalVolume };
    }
    const lowest = caps.find((c) => admissionByCap[capKey(c)]!.admitted) ?? null;
    const standaloneRun = simulatePassEconomicOutcomes({
      candles: m15,
      signals: [s],
      parametersByStrategyId: paramsById,
      tickSize,
      featureLookback: XAU_REPLAY_FEATURE_LOOKBACK
    }).trades[0];
    return {
      signalCandleIndex: s.signalCandleIndex,
      signalTimeIso: new Date(s.evaluation.signalTimestampMs).toISOString(),
      direction,
      strategyStopLoss: typeof meta.stopLoss === "number" ? meta.stopLoss : null,
      strategyTakeProfit: typeof meta.takeProfit === "number" ? meta.takeProfit : null,
      intendedR: typeof meta.intendedR === "number" ? meta.intendedR : null,
      entryTimeIso: entryCandle ? new Date(entryCandle.openTime).toISOString() : null,
      entryPrice: entryCandle?.open ?? null,
      plan,
      stopDistance: scorable ? Math.abs(entryCandle!.open - plan!.stopLoss!) : null,
      riskAtBrokerMinVolume: riskAtMin,
      requiredRiskPercentForMinLot: riskAtMin == null ? null : (riskAtMin / input.equity) * 100,
      admissionByCap,
      lowestAdmittingCapPercent: lowest,
      admissionBand: admissionBandLabel(lowest, caps, scorable),
      standalone: {
        outcome: standaloneRun?.outcome ?? "UNSCORABLE",
        realizedR: standaloneRun?.realizedR ?? null,
        barsHeld: standaloneRun?.barsHeld ?? null,
        exitTimeIso: standaloneRun?.exitTimeMs != null ? new Date(standaloneRun.exitTimeMs).toISOString() : null
      }
    };
  });
  const rowByIndex = new Map(rows.map((r) => [r.signalCandleIndex, r] as const));

  const variants = caps.map((cap): XauRiskCapVariantResult => {
    const key = capKey(cap);
    const econ = simulatePassEconomicOutcomes({
      candles: m15,
      signals: gen.signals,
      parametersByStrategyId: paramsById,
      tickSize,
      featureLookback: XAU_REPLAY_FEATURE_LOOKBACK,
      entryGate: (ctx) => {
        if (ctx.plan.stopLoss == null) return { reject: true, reason: UNSCORABLE_PLAN };
        const a = admission(ctx.direction, ctx.entryPrice, ctx.plan.stopLoss, cap);
        return a.admitted
          ? { reject: false, reason: null }
          : {
              reject: true,
              reason: a.reasonCode ?? "NO_TRADE",
              detail: { riskAtBrokerMinVolume: a.riskAtBrokerMinVolume, allowedRiskAmount: a.allowedRiskAmount }
            };
      }
    });
    const trades = econ.trades.filter((t) => t.pass === "C");
    const d = econ.simulationDiagnostics.C;
    const metrics = aggregatePassEconomicMetrics(trades);
    const all = tradeStats(trades);
    const perSignal = rows.map((r) => r.admissionByCap[key]!);
    const admitted = perSignal.filter((a) => a.admitted).length;
    return {
      capPercent: cap,
      capKey: key,
      totalStrategySignals: rows.length,
      signalsAdmitted: admitted,
      signalsRejectedMinVolumeExceedsRisk: perSignal.filter((a) => !a.admitted && a.reasonCode === MIN_VOLUME_EXCEEDS_RISK).length,
      signalsRejectedOther: tally(
        perSignal.filter((a) => !a.admitted && a.reasonCode !== MIN_VOLUME_EXCEEDS_RISK),
        (a) => a.reasonCode ?? "NO_TRADE"
      ),
      admissionRate: rows.length > 0 ? admitted / rows.length : null,
      simulation: {
        signalsSeen: d.executableSignalsSeen,
        gateRejections: d.signalsRejectedByResearchGate,
        entries: all.entries,
        resolvedTrades: all.resolved,
        wins: all.wins,
        losses: all.losses,
        winRate: all.winRate,
        totalR: all.totalR,
        avgR: all.avgR,
        maxDrawdownR: metrics.maxDrawdownR,
        longestLosingStreak: metrics.longestLosingStreak,
        openAtEnd: all.openAtEnd,
        ambiguous: all.ambiguous,
        skippedWhilePositionOpen: d.signalsSkippedOpenPosition,
        byDirection: {
          BUY: tradeStats(trades.filter((t) => t.direction === "BUY")),
          SELL: tradeStats(trades.filter((t) => t.direction === "SELL"))
        }
      },
      metrics,
      trades
    };
  });

  const bandOrder = [
    ...caps.map((c) => admissionBandLabel(c, caps, true)),
    admissionBandLabel(null, caps, true),
    UNSCORABLE_PLAN
  ];
  const admissionBands = bandOrder.map((band) => ({ band, stats: rowStats(rows.filter((r) => r.admissionBand === band)) }));

  const EPS = 1e-9;
  const increments: XauIncrementRow[] = [];
  for (let k = 1; k < caps.length; k++) {
    const lo = variants[k - 1]!;
    const hi = variants[k]!;
    const loIdx = new Set(lo.trades.map((t) => t.signalCandleIndex));
    const hiIdx = new Set(hi.trades.map((t) => t.signalCandleIndex));
    const added = tradeStats(hi.trades.filter((t) => !loIdx.has(t.signalCandleIndex)));
    const displaced = tradeStats(lo.trades.filter((t) => !hiIdx.has(t.signalCandleIndex)));
    const net = hi.simulation.totalR - lo.simulation.totalR;
    increments.push({
      fromCapPercent: lo.capPercent,
      toCapPercent: hi.capPercent,
      newlyAdmittedSignals: rowStats(rows.filter((r) => r.admissionByCap[hi.capKey]!.admitted && !r.admissionByCap[lo.capKey]!.admitted)),
      simulatedTradesAdded: added,
      simulatedTradesDisplaced: displaced,
      simulatedNetDeltaR: net,
      reconciles: Math.abs(added.totalR - displaced.totalR - net) < EPS
    });
  }

  let monotonicViolations = 0;
  for (const r of rows) {
    let seen = false;
    for (const c of caps) {
      const a = r.admissionByCap[capKey(c)]!.admitted;
      if (seen && !a) monotonicViolations += 1;
      seen = seen || a;
    }
  }
  const bandsSumToAdmittedStandalone = caps.every((cap, idx) => {
    const admittedR = rowStats(rows.filter((r) => r.admissionByCap[capKey(cap)]!.admitted)).totalR;
    const bandR = admissionBands.slice(0, idx + 1).reduce((a, b) => a + b.stats.totalR, 0);
    return Math.abs(admittedR - bandR) < EPS;
  });
  const identical = variants.every(
    (v) => v.totalStrategySignals === rows.length && v.simulation.signalsSeen === gen.signals.length
  );

  const analysisM15 = m15.filter((c) => c.openTime >= input.analysisStartMs && c.openTime < input.analysisEndMs);
  const ii = input.integrityInputs;
  const h4Gaps = h4.reduce((n, c, i) => (i > 0 && c.openTime - h4[i - 1]!.openTime > 4 * 3_600_000 * 1.5 ? n + 1 : n), 0);

  const productionFaithfulVariants = caps.map((cap) =>
    simulateXauProductionFaithfulCap({
      m15,
      h4,
      analysisStartMs: input.analysisStartMs,
      analysisEndMs: input.analysisEndMs,
      parameters,
      strategy,
      evaluationCache,
      capPercent: cap,
      equity: input.equity,
      instrument: input.instrument,
      engineMaxVolume: input.engineMaxVolume
    })
  );

  const signalId = (s: { signalCandleIndex: number; direction: PositionDirection }) => `${s.signalCandleIndex}:${s.direction}`;
  const controlledSignalIds = new Set(rows.map(signalId));
  const timeOf = new Map<string, string>(rows.map((r) => [signalId(r), r.signalTimeIso] as const));
  const divergence = caps.map((cap, k): XauModeDivergenceRow => {
    const ctrl = variants[k]!;
    const pf = productionFaithfulVariants[k]!;
    const pfSignalIds = new Set(pf.events.map(signalId));
    for (const e of pf.events) timeOf.set(signalId(e), e.signalTimeIso);
    const enteredIds = (ts: ReadonlyArray<ReplaySimulatedTrade>) =>
      new Set(ts.filter((t) => t.outcome !== "UNSCORABLE" && t.entryTimeMs != null).map(signalId));
    const ctrlEntries = enteredIds(ctrl.trades);
    const pfEntries = enteredIds(pf.trades);
    const onlyCtrl = [...controlledSignalIds].filter((x) => !pfSignalIds.has(x));
    const onlyPf = [...pfSignalIds].filter((x) => !controlledSignalIds.has(x));
    return {
      capPercent: cap,
      capKey: capKey(cap),
      controlledSignals: controlledSignalIds.size,
      productionFaithfulSignals: pfSignalIds.size,
      signalsUniqueToControlled: onlyCtrl.length,
      signalsUniqueToProductionFaithful: onlyPf.length,
      controlledEntries: ctrlEntries.size,
      productionFaithfulEntries: pfEntries.size,
      entriesUniqueToControlled: [...ctrlEntries].filter((x) => !pfEntries.has(x)).length,
      entriesUniqueToProductionFaithful: [...pfEntries].filter((x) => !ctrlEntries.has(x)).length,
      controlledTotalR: ctrl.simulation.totalR,
      productionFaithfulTotalR: pf.totalR,
      totalRDifference: pf.totalR - ctrl.simulation.totalR,
      uniqueToControlledSignalTimes: onlyCtrl.map((x) => timeOf.get(x)!),
      uniqueToProductionFaithfulSignalTimes: onlyPf.map((x) => timeOf.get(x)!)
    };
  });

  const productionFaithfulLimitations = [
    "Cooldown source: LiveEngineSession MT5 path sets lastSignalCandle only when shouldConsumeStrategySignalCooldown({ opened, decisionCode }) is true (OPENED / EXECUTION_REJECTED / EXECUTION_AMBIGUOUS). Broker rejections and ambiguous fills are not modeled, so only OPENED consumes here.",
    "A BUY/SELL while this cap's position is open is recorded as MAX_CONCURRENT_POSITIONS (live capacity gate runs before sizing) and does not consume cooldown. Live capacity is account-wide; positions on other symbols are not modeled.",
    "Risk-engine gates (daily loss, max daily trades, consecutive-loss cooldown, min seconds between trades) and worker restarts (which reset the in-memory cooldown map) are not modeled.",
    "Each admitted trade is scored by the replay simulator; the whole per-cap signal path is then replayed through the simulator with the admission gate as a cross-check."
  ];

  const limitations = [
    ...(input.extraLimitations ?? []),
    "No spread, commission, swap or slippage modeled — R is gross, identical to the counterfactual replay simulator.",
    "Entry at NEXT_CANDLE_OPEN (M15 open after the signal close); live MT5 fills at the contemporaneous ask/bid.",
    "Sizing uses the modeled entry (next open) and the strategy's original stop; live sizing uses the preflight quote and may widen the stop via broker stops-level adaptation (not modeled — historical stops_level unavailable).",
    "Risk cap changes only admission at the broker minimum lot; R outcomes are never scaled by account dollars.",
    `Cooldown advances on every strategy BUY/SELL regardless of admission so all caps share one signal stream. Live, MIN_VOLUME_EXCEEDS_RISK does not consume the cooldown (shouldConsumeStrategySignalCooldown), so production can re-signal on following bars.`,
    `H4 context: last ${XAU_H4_CONTEXT_WINDOW} completed native H4 bars as of each M15 close (live restore window); live context refresh cadence is not modeled.`,
    `Account equity fixed at ${input.equity} for every signal; required risk % scales inversely with equity.`,
    `Live DEMO also clamps risk by MT5_ENGINE_MAX_RISK_PERCENT; caps above it are hypothetical comparisons only.`,
    "AMBIGUOUS (same-bar stop+target) and OPEN_AT_END trades carry no R.",
    "Research only — no recommendation, nothing applied to DEMO/REAL."
  ];

  return {
    generatedAtIso: new Date().toISOString(),
    kind: "XAU_RISK_CAP_BROKER_MIN_VOLUME_COMPARISON",
    config: {
      symbol: input.symbol,
      interval: "15m",
      strategyId: strategy.id,
      parameters,
      parametersSource: input.parametersSource ?? "XAU_TREND_PULLBACK_DEFAULTS",
      equity: input.equity,
      riskCapsPercent: caps,
      currentDemoRiskCapPercent: XAU_RISK_CAP_CURRENT_DEMO_PERCENT,
      instrument: input.instrument,
      instrumentSource: input.instrumentSource ?? "provided",
      engineMaxVolume: input.engineMaxVolume,
      m15BufferCapacity: XAU_M15_BUFFER_CAPACITY,
      h4ContextWindow: XAU_H4_CONTEXT_WINDOW
    },
    signalGeneration: {
      evaluatedBars: gen.evaluatedBars,
      strategySignals: gen.signals.length,
      buy: gen.signals.filter((s) => s.evaluation.action === "BUY").length,
      sell: gen.signals.filter((s) => s.evaluation.action === "SELL").length,
      holdReasonCounts: gen.holdReasonCounts,
      cooldownPolicy: "ADVANCE_ON_EVERY_STRATEGY_SIGNAL (cap-independent)"
    },
    variants,
    admissionBands,
    increments,
    reconciliation: {
      admissionMonotonic: monotonicViolations === 0,
      monotonicViolations,
      identicalSignalSetAcrossVariants: identical,
      bandsSumToAdmittedStandalone,
      simulatedIncrementsReconcile: increments.every((x) => x.reconciles),
      requiredPercentBandMismatches: rows.filter(
        (r) => r.admissionBand !== UNSCORABLE_PLAN && bandFromRequiredPercent(r.requiredRiskPercentForMinLot, caps) !== r.admissionBand
      ).length
    },
    signals: rows,
    dataIntegrity: {
      analysisStartIso: new Date(input.analysisStartMs).toISOString(),
      analysisEndIso: new Date(input.analysisEndMs).toISOString(),
      m15: {
        rowsLoaded: ii?.m15RowsLoaded ?? m15.length,
        completeCleanCandles: m15.length,
        analysisWindowCandles: analysisM15.length,
        excludedByRestoreFilter: (ii?.m15RowsLoaded ?? m15.length) - m15.length,
        restoreFilterDiagnostics: ii?.m15RestoreDiagnostics ?? [],
        sources: tally(m15, (c) => c.source),
        firstIso: m15[0] ? new Date(m15[0].openTime).toISOString() : null,
        lastIso: m15.length ? new Date(m15[m15.length - 1]!.openTime).toISOString() : null,
        gaps: m15Gaps(analysisM15),
        malformed: malformedCounts(ii?.m15Raw ?? m15),
        continuity: analyzeCandleContinuity(analysisM15)
      },
      h4: {
        rowsLoaded: ii?.h4RowsLoaded ?? h4.length,
        completeCleanCandles: h4.length,
        sources: tally(h4, (c) => c.source),
        firstIso: h4[0] ? new Date(h4[0].openTime).toISOString() : null,
        lastIso: h4.length ? new Date(h4[h4.length - 1]!.openTime).toISOString() : null,
        malformed: malformedCounts(ii?.h4Raw ?? h4),
        gaps: h4Gaps,
        analysisBarsWithInsufficientH4: gen.barsWithInsufficientH4,
        firstBarWithFullWarmupIso: gen.firstBarWithFullWarmupIso
      }
    },
    limitations,
    comparisonModes: {
      controlled: { id: "CONTROLLED_SHARED_SIGNAL", purpose: CONTROLLED_PURPOSE },
      productionFaithful: { id: "PRODUCTION_FAITHFUL_CHRONOLOGICAL", purpose: PRODUCTION_FAITHFUL_PURPOSE }
    },
    productionFaithful: {
      cooldownPolicy: PRODUCTION_FAITHFUL_COOLDOWN_POLICY,
      variants: productionFaithfulVariants,
      simulatorCrossCheckAllMatch: productionFaithfulVariants.every((v) => v.simulatorCrossCheck.matches),
      limitations: productionFaithfulLimitations
    },
    divergence
  };
}

const CONTROLLED_PURPOSE =
  "Isolate the economic quality of signals admitted at higher risk caps: one shared signal stream, the cap only decides broker-minimum-lot admission.";
const PRODUCTION_FAITHFUL_PURPOSE =
  "Replay each cap chronologically as the live MT5 session would: rejected signals do not consume cooldown, so each cap can follow a different later signal path.";

export function formatXauRiskCapComparisonMarkdown(r: XauRiskCapComparisonReport): string {
  const n = (v: number | null | undefined, d = 2) => (v == null ? "—" : (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d));
  const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  const statsRow = (label: string, s: XauGroupStats) =>
    `| ${label} | ${s.signals} | ${s.resolved} | ${s.wins}/${s.losses} | ${pct(s.winRate)} | ${n(s.totalR)} | ${n(s.avgR)} | ${s.ambiguous} | ${s.openAtEnd} |`;
  const statsHeader = [
    "| Group | Signals/trades | Resolved | W/L | Win rate | Total R | Avg R | Ambiguous | Open at end |",
    "|---|---:|---:|---|---:|---:|---:|---:|---:|"
  ];
  const lines: string[] = [];
  const c = r.config;

  lines.push(`# XAUUSD broker-min-volume risk-cap comparison — ${c.strategyId}`);
  lines.push("");
  lines.push(`- Symbol ${c.symbol} ${c.interval}; analysis ${r.dataIntegrity.analysisStartIso} → ${r.dataIntegrity.analysisEndIso}`);
  lines.push(`- Equity ${c.equity}; caps ${c.riskCapsPercent.map((x) => `${x.toFixed(2)}%`).join(", ")} (current DEMO ${c.currentDemoRiskCapPercent.toFixed(2)}%)`);
  lines.push(
    `- Instrument (${c.instrumentSource}): minVolume ${c.instrument.minVolume}, volumeStep ${c.instrument.volumeStep}, tickSize ${c.instrument.tickSize}, tickValue ${c.instrument.tickValue}, contractSize ${c.instrument.contractSize}; engine max volume ${c.engineMaxVolume}`
  );
  lines.push(`- Strategy parameters: ${c.parametersSource}; M15 buffer ${c.m15BufferCapacity}; H4 context window ${c.h4ContextWindow}`);
  lines.push(`- Research only. The risk cap changes only whether a signal can execute at the broker minimum lot; stops, targets and R are identical across caps.`);
  lines.push("");

  lines.push(`## A. Controlled shared-signal comparison (${r.comparisonModes.controlled.id})`);
  lines.push(`Purpose: ${r.comparisonModes.controlled.purpose}`);
  lines.push("");
  const g = r.signalGeneration;
  lines.push(`### Signal generation`);
  lines.push(`- Evaluated M15 closes: ${g.evaluatedBars}; strategy signals: ${g.strategySignals} (BUY ${g.buy}, SELL ${g.sell})`);
  lines.push(`- Cooldown policy: ${g.cooldownPolicy}`);
  lines.push(
    `- HOLD reasons: ${Object.entries(g.holdReasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "—"}`
  );
  lines.push("");

  lines.push(`### Risk-cap variants`);
  lines.push(`| Metric | ${r.variants.map((v) => v.capKey).join(" | ")} |`);
  lines.push(`|---|${r.variants.map(() => "---:").join("|")}|`);
  const row = (label: string, f: (v: XauRiskCapVariantResult) => string) =>
    lines.push(`| ${label} | ${r.variants.map(f).join(" | ")} |`);
  row("Total strategy signals", (v) => String(v.totalStrategySignals));
  row("Admitted by volume sizing", (v) => String(v.signalsAdmitted));
  row("Rejected MIN_VOLUME_EXCEEDS_RISK", (v) => String(v.signalsRejectedMinVolumeExceedsRisk));
  row("Rejected (other)", (v) => Object.entries(v.signalsRejectedOther).map(([k, x]) => `${k} ${x}`).join(", ") || "0");
  row("Admission rate", (v) => pct(v.admissionRate));
  row("Entries", (v) => String(v.simulation.entries));
  row("Resolved trades", (v) => String(v.simulation.resolvedTrades));
  row("W/L", (v) => `${v.simulation.wins}/${v.simulation.losses}`);
  row("Win rate", (v) => pct(v.simulation.winRate));
  row("Total R", (v) => n(v.simulation.totalR));
  row("Avg R", (v) => n(v.simulation.avgR));
  row("Max drawdown R", (v) => n(v.simulation.maxDrawdownR));
  row("Longest losing streak", (v) => String(v.simulation.longestLosingStreak));
  row("Open at end", (v) => String(v.simulation.openAtEnd));
  row("Ambiguous", (v) => String(v.simulation.ambiguous));
  row("Skipped while position open", (v) => String(v.simulation.skippedWhilePositionOpen));
  row("Gate rejections in simulation", (v) => String(v.simulation.gateRejections));
  for (const dir of ["BUY", "SELL"] as const) {
    row(`${dir} trades / W-L / R`, (v) => {
      const s = v.simulation.byDirection[dir];
      return `${s.entries} / ${s.wins}-${s.losses} / ${n(s.totalR)}`;
    });
  }
  lines.push("");
  lines.push(`Entries and R come from one single-position simulation per cap; admission counts are per signal, independent of position state.`);
  lines.push("");

  lines.push(`### Admission bands (lowest cap that admits the signal; each signal scored standalone)`);
  lines.push(...statsHeader);
  for (const b of r.admissionBands) lines.push(statsRow(b.band, b.stats));
  lines.push("");

  lines.push(`### Incremental analysis`);
  lines.push(`| Step | Newly admitted: signals / W-L / R / avg | Simulated added: trades / W-L / R | Simulated displaced: trades / W-L / R | Net Δ R | Reconciles |`);
  lines.push(`|---|---|---|---|---:|---|`);
  for (const x of r.increments) {
    const a = x.newlyAdmittedSignals;
    lines.push(
      `| ${x.fromCapPercent.toFixed(2)}% → ${x.toCapPercent.toFixed(2)}% | ${a.signals} / ${a.wins}-${a.losses} / ${n(a.totalR)} / ${n(a.avgR)} | ${x.simulatedTradesAdded.entries} / ${x.simulatedTradesAdded.wins}-${x.simulatedTradesAdded.losses} / ${n(x.simulatedTradesAdded.totalR)} | ${x.simulatedTradesDisplaced.entries} / ${x.simulatedTradesDisplaced.wins}-${x.simulatedTradesDisplaced.losses} / ${n(x.simulatedTradesDisplaced.totalR)} | ${n(x.simulatedNetDeltaR)} | ${x.reconciles ? "yes" : "NO"} |`
    );
  }
  lines.push("");
  lines.push(`"Newly admitted" counts every signal that becomes executable at the higher cap, scored on its own. "Simulated added/displaced" is the change in the single-position trade set (a newly admitted trade can block a later, previously admitted one).`);
  lines.push("");

  const rc = r.reconciliation;
  lines.push(`### Reconciliation`);
  lines.push(`- Identical signal set across variants: ${rc.identicalSignalSetAcrossVariants ? "yes" : "NO"}`);
  lines.push(`- Admission monotonic in cap: ${rc.admissionMonotonic ? "yes" : `NO (${rc.monotonicViolations} violations)`}`);
  lines.push(`- Bands sum to admitted standalone totals: ${rc.bandsSumToAdmittedStandalone ? "yes" : "NO"}`);
  lines.push(`- Simulated increments reconcile (added − displaced = Δ total R): ${rc.simulatedIncrementsReconcile ? "yes" : "NO"}`);
  lines.push(`- Signals whose required-% band differs from the admission band (broker $0.01 risk tolerance): ${rc.requiredPercentBandMismatches}`);
  lines.push("");

  lines.push(`### Signals`);
  lines.push(`| Signal (M15 close) | Dir | Entry | Stop | Target | Stop dist | Risk @0.01 lot | Required % | Band | Standalone |`);
  lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---|---|`);
  for (const s of r.signals) {
    lines.push(
      `| ${s.signalTimeIso} | ${s.direction} | ${n(s.entryPrice)} | ${n(s.plan?.stopLoss)} | ${n(s.plan?.takeProfit)} | ${n(s.stopDistance)} | ${n(s.riskAtBrokerMinVolume)} | ${s.requiredRiskPercentForMinLot == null ? "—" : `${s.requiredRiskPercentForMinLot.toFixed(3)}%`} | ${s.admissionBand} | ${s.standalone.outcome}${s.standalone.realizedR == null ? "" : ` ${n(s.standalone.realizedR)}R`} |`
    );
  }
  lines.push("");

  const pf = r.productionFaithful;
  lines.push(`## B. Production-faithful chronological comparison (${r.comparisonModes.productionFaithful.id})`);
  lines.push(`Purpose: ${r.comparisonModes.productionFaithful.purpose}`);
  lines.push(`- Cooldown policy: ${pf.cooldownPolicy}`);
  lines.push(`- Replay-simulator cross-check (per-cap signal path + admission gate reproduces the chronological trades): ${pf.simulatorCrossCheckAllMatch ? "yes" : "NO"}`);
  lines.push("");
  lines.push(`| Metric | ${pf.variants.map((v) => v.capKey).join(" | ")} |`);
  lines.push(`|---|${pf.variants.map(() => "---:").join("|")}|`);
  const pfRow = (label: string, f: (v: XauProductionFaithfulCapResult) => string) =>
    lines.push(`| ${label} | ${pf.variants.map(f).join(" | ")} |`);
  pfRow("Strategy evaluations", (v) => String(v.strategyEvaluations));
  pfRow("BUY/SELL signals generated", (v) => `${v.signalsGenerated} (${v.buySignals}/${v.sellSignals})`);
  pfRow("Rejected MIN_VOLUME_EXCEEDS_RISK", (v) => String(v.rejectedMinVolumeExceedsRisk));
  pfRow("Rejected (other)", (v) => Object.entries(v.rejectedOther).map(([k, x]) => `${k} ${x}`).join(", ") || "0");
  pfRow("Admitted signals", (v) => String(v.admittedSignals));
  pfRow("Entries", (v) => String(v.entries));
  pfRow("Skipped due to cooldown", (v) => String(v.skippedCooldown));
  pfRow("Skipped due to open position", (v) => String(v.skippedOpenPosition));
  pfRow("Resolved trades", (v) => String(v.resolvedTrades));
  pfRow("W/L", (v) => `${v.wins}/${v.losses}`);
  pfRow("Win rate", (v) => pct(v.winRate));
  pfRow("Total R", (v) => n(v.totalR));
  pfRow("Avg R", (v) => n(v.avgR));
  pfRow("Max drawdown R", (v) => n(v.maxDrawdownR));
  pfRow("Longest losing streak", (v) => String(v.longestLosingStreak));
  pfRow("Open at end", (v) => String(v.openAtEnd));
  pfRow("Ambiguous", (v) => String(v.ambiguous));
  for (const dir of ["BUY", "SELL"] as const) {
    pfRow(`${dir} trades / W-L / R`, (v) => {
      const s = v.byDirection[dir];
      return `${s.entries} / ${s.wins}-${s.losses} / ${n(s.totalR)}`;
    });
  }
  lines.push("");
  lines.push(`"Skipped due to cooldown" counts M15 closes the strategy held with COOLDOWN_ACTIVE on this cap's own path.`);
  lines.push("");

  lines.push(`## Mode divergence (controlled vs production-faithful)`);
  lines.push(`| Cap | Controlled signals | Production-faithful signals | Unique to controlled | Unique to production-faithful | Entries (ctrl / pf) | Entries unique (ctrl / pf) | Controlled R | Production-faithful R | R difference (pf − ctrl) |`);
  lines.push(`|---|---:|---:|---:|---:|---|---|---:|---:|---:|`);
  for (const x of r.divergence) {
    lines.push(
      `| ${x.capKey} | ${x.controlledSignals} | ${x.productionFaithfulSignals} | ${x.signalsUniqueToControlled} | ${x.signalsUniqueToProductionFaithful} | ${x.controlledEntries} / ${x.productionFaithfulEntries} | ${x.entriesUniqueToControlled} / ${x.entriesUniqueToProductionFaithful} | ${n(x.controlledTotalR)} | ${n(x.productionFaithfulTotalR)} | ${n(x.totalRDifference)} |`
    );
  }
  lines.push("");
  for (const x of r.divergence) {
    if (x.uniqueToControlledSignalTimes.length + x.uniqueToProductionFaithfulSignalTimes.length === 0) continue;
    lines.push(
      `- ${x.capKey}: only controlled ${x.uniqueToControlledSignalTimes.slice(0, 10).join(", ") || "—"}; only production-faithful ${x.uniqueToProductionFaithfulSignalTimes.slice(0, 10).join(", ") || "—"}`
    );
  }
  lines.push("");

  const d = r.dataIntegrity;
  lines.push(`## Data integrity`);
  lines.push(`- Analysis window: ${d.analysisStartIso} → ${d.analysisEndIso}`);
  lines.push(
    `- M15: rows loaded ${d.m15.rowsLoaded}; clean complete ${d.m15.completeCleanCandles} (excluded by production restore filter ${d.m15.excludedByRestoreFilter}); in analysis window ${d.m15.analysisWindowCandles}; first ${d.m15.firstIso ?? "—"}; last ${d.m15.lastIso ?? "—"}`
  );
  lines.push(`- M15 sources: ${JSON.stringify(d.m15.sources)}; malformed/zero-price rows: ${JSON.stringify(d.m15.malformed)}`);
  lines.push(
    `- M15 gaps in analysis window: ${d.m15.gaps.count} (weekend ${d.m15.gaps.weekendGaps}, other ${d.m15.gaps.nonWeekendGaps}; missing bars ${d.m15.gaps.missingBars})`
  );
  for (const gp of d.m15.gaps.largest.filter((x) => !x.weekend).slice(0, 10)) {
    lines.push(`  - ${gp.afterIso} → ${gp.nextIso} (${gp.missingBars} missing)`);
  }
  lines.push(
    `- M15 close-to-close: max |move| ${d.m15.continuity.maxAbsReturnPct == null ? "—" : `${d.m15.continuity.maxAbsReturnPct.toFixed(3)}%`}; jumps ${Object.entries(d.m15.continuity.jumpCounts).map(([k, v]) => `${k}: ${v}`).join(", ")}`
  );
  for (const msg of d.m15.restoreFilterDiagnostics.slice(0, 10)) lines.push(`  - restore filter: ${msg}`);
  lines.push(
    `- H4: rows loaded ${d.h4.rowsLoaded}; clean complete ${d.h4.completeCleanCandles}; first ${d.h4.firstIso ?? "—"}; last ${d.h4.lastIso ?? "—"}; gaps ${d.h4.gaps}; sources ${JSON.stringify(d.h4.sources)}; malformed ${JSON.stringify(d.h4.malformed)}`
  );
  lines.push(
    `- H4 coverage: analysis M15 closes with < ${XAU_TREND_PULLBACK_H4_MINIMUM_BARS} completed H4 bars: ${d.h4.analysisBarsWithInsufficientH4}; first close with full M15+H4 warm-up: ${d.h4.firstBarWithFullWarmupIso ?? "—"}`
  );
  lines.push("");

  lines.push(`## Limitations`);
  for (const l of r.limitations) lines.push(`- ${l}`);
  lines.push("");
  lines.push(`### Production-faithful mode`);
  for (const l of r.productionFaithful.limitations) lines.push(`- ${l}`);
  return `${lines.join("\n")}\n`;
}
