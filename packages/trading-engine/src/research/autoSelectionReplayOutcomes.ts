/**
 * Offline economic outcome simulation for AUTO counterfactual replay (Pass A vs Pass C).
 *
 * Does not place orders or change live/demo/REAL behavior.
 * Stop/target geometry comes from strategy-specific proposeCfdStopTarget — never invented.
 */
import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StrategyDecision
} from "@regimex/shared";
import {
  DEFAULT_FEATURE_CONFIG,
  extractFeatures
} from "../features/featureExtractor.js";
import { proposeCfdStopTarget } from "../strategies/cfdCapability.js";

/** Minimal eval fields needed to open a replay trade (avoids circular imports). */
export interface ReplayEconomicEvalSnapshot {
  strategyId: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  signalTimestampMs: number;
  decisionMetadata: Record<string, unknown>;
}

/** Conservative offline fill: enter at the next closed candle's open after the signal candle. */
export const REPLAY_ENTRY_CONVENTION =
  "NEXT_CANDLE_OPEN" as const;

export type ReplayEntryConvention = typeof REPLAY_ENTRY_CONVENTION;

export type ReplayTradeOutcome =
  | "TARGET"
  | "STOP"
  | "AMBIGUOUS"
  | "OPEN_AT_END"
  | "UNSCORABLE";

export type ReplaySelectorPass = "A" | "C";

export interface ReplayTradePlanSnapshot {
  action: "BUY" | "SELL";
  strategyId: string;
  signalTimestampMs: number;
  /** Proposed / used entry (next-candle open when convention is NEXT_CANDLE_OPEN). */
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  stopDistance: number | null;
  targetDistance: number | null;
  riskRewardRatio: number | null;
  stopMethod: string | null;
  targetMethod: string | null;
  confidence: number;
  scorable: boolean;
  unscorableReason: string | null;
  proposalReasons: string[];
}

export interface ReplaySimulatedTrade {
  pass: ReplaySelectorPass;
  strategyId: string;
  direction: PositionDirection;
  signalCandleIndex: number;
  signalTimeMs: number;
  entryCandleIndex: number | null;
  entryTimeMs: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  exitCandleIndex: number | null;
  exitTimeMs: number | null;
  exitPrice: number | null;
  outcome: ReplayTradeOutcome;
  /** Realized R for TARGET/STOP only; null for AMBIGUOUS/OPEN_AT_END/UNSCORABLE. */
  realizedR: number | null;
  barsHeld: number | null;
  tradePlan: ReplayTradePlanSnapshot;
  /** Pass C only: true when production eval was HOLD/absent on the signal bar. */
  fromProductionHold: boolean;
  confidence: number;
}

export interface ReplayStrategyEconomicBreakdown {
  trades: number;
  wins: number;
  losses: number;
  totalR: number;
  avgR: number | null;
}

export interface ReplayPassEconomicMetrics {
  totalSignals: number;
  scorableTrades: number;
  unscorable: number;
  targetHits: number;
  stopHits: number;
  ambiguous: number;
  openAtEnd: number;
  /** Wins / (wins+losses); TARGET=win, STOP=loss; excludes AMBIGUOUS/OPEN/UNSCORABLE. */
  winRate: number | null;
  totalRealizedR: number;
  avgRPerResolvedTrade: number | null;
  medianR: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  avgBarsHeld: number | null;
  byStrategy: Record<string, ReplayStrategyEconomicBreakdown>;
  /** Pass C: signals/trades that opened while production was HOLD. */
  fromProductionHoldSignals: number;
  fromProductionHoldResolvedR: number;
  fromProductionHoldResolvedTrades: number;
}

export interface ReplayEconomicComparison {
  entryConvention: ReplayEntryConvention;
  entryConventionNote: string;
  positionModel: "SINGLE_POSITION_PER_PASS";
  positionModelNote: string;
  tickSize: number;
  passA: ReplayPassEconomicMetrics;
  passC: ReplayPassEconomicMetrics;
  trades: ReplaySimulatedTrade[];
}

export interface ReplayEconomicSignal {
  pass: ReplaySelectorPass;
  signalCandleIndex: number;
  evaluation: ReplayEconomicEvalSnapshot;
  fromProductionHold: boolean;
}

/**
 * Walk forward OHLC after entry. Same-bar stop+target → AMBIGUOUS (no R).
 * Does not invent intrabar order.
 */
export function simulateStopTargetWalk(input: {
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Bars starting at the entry candle (inclusive). */
  forwardBars: ReadonlyArray<Candle>;
}): {
  outcome: Exclude<ReplayTradeOutcome, "UNSCORABLE">;
  exitCandleOffset: number | null;
  exitPrice: number | null;
  barsHeld: number | null;
  realizedR: number | null;
} {
  const risk = Math.abs(input.entryPrice - input.stopLoss);
  if (!(risk > 0) || !Number.isFinite(risk)) {
    return {
      outcome: "OPEN_AT_END",
      exitCandleOffset: null,
      exitPrice: null,
      barsHeld: null,
      realizedR: null
    };
  }

  for (let i = 0; i < input.forwardBars.length; i++) {
    const bar = input.forwardBars[i]!;
    const stopHit =
      input.direction === "BUY" ? bar.low <= input.stopLoss : bar.high >= input.stopLoss;
    const targetHit =
      input.direction === "BUY" ? bar.high >= input.takeProfit : bar.low <= input.takeProfit;

    if (stopHit && targetHit) {
      return {
        outcome: "AMBIGUOUS",
        exitCandleOffset: i,
        exitPrice: null,
        barsHeld: i + 1,
        realizedR: null
      };
    }
    if (stopHit) {
      const exitPrice = input.stopLoss;
      const pnl =
        input.direction === "BUY"
          ? exitPrice - input.entryPrice
          : input.entryPrice - exitPrice;
      return {
        outcome: "STOP",
        exitCandleOffset: i,
        exitPrice,
        barsHeld: i + 1,
        realizedR: pnl / risk
      };
    }
    if (targetHit) {
      const exitPrice = input.takeProfit;
      const pnl =
        input.direction === "BUY"
          ? exitPrice - input.entryPrice
          : input.entryPrice - exitPrice;
      return {
        outcome: "TARGET",
        exitCandleOffset: i,
        exitPrice,
        barsHeld: i + 1,
        realizedR: pnl / risk
      };
    }
  }

  const last = input.forwardBars[input.forwardBars.length - 1];
  return {
    outcome: "OPEN_AT_END",
    exitCandleOffset: last ? input.forwardBars.length - 1 : null,
    exitPrice: last?.close ?? null,
    barsHeld: input.forwardBars.length > 0 ? input.forwardBars.length : null,
    realizedR: null
  };
}

export function buildReplayTradePlan(input: {
  strategyId: string;
  action: "BUY" | "SELL";
  confidence: number;
  signalTimestampMs: number;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  metadata: Record<string, unknown>;
  tickSize: number;
  parameters?: Record<string, number | boolean | string>;
}): ReplayTradePlanSnapshot {
  const targetRMultiple =
    typeof input.parameters?.targetRMultiple === "number"
      ? input.parameters.targetRMultiple
      : undefined;
  const stopAtrMultiple =
    typeof input.parameters?.stopAtrMultiple === "number"
      ? input.parameters.stopAtrMultiple
      : undefined;
  const minRiskRewardRatio =
    typeof input.parameters?.minRiskRewardRatio === "number"
      ? input.parameters.minRiskRewardRatio
      : undefined;

  const proposal = proposeCfdStopTarget({
    strategyId: input.strategyId,
    direction: input.action,
    entryPrice: input.entryPrice,
    features: input.features,
    candles: input.candles,
    metadata: input.metadata,
    tickSize: input.tickSize,
    targetRMultiple,
    stopAtrMultiple,
    minRiskRewardRatio
  });

  if (!proposal) {
    return {
      action: input.action,
      strategyId: input.strategyId,
      signalTimestampMs: input.signalTimestampMs,
      entryPrice: input.entryPrice,
      stopLoss: null,
      takeProfit: null,
      stopDistance: null,
      targetDistance: null,
      riskRewardRatio: null,
      stopMethod: null,
      targetMethod: null,
      confidence: input.confidence,
      scorable: false,
      unscorableReason: "CFD_STOP_TARGET_UNAVAILABLE",
      proposalReasons: []
    };
  }
  if (proposal.takeProfit == null || !Number.isFinite(proposal.takeProfit)) {
    return {
      action: input.action,
      strategyId: input.strategyId,
      signalTimestampMs: input.signalTimestampMs,
      entryPrice: input.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: null,
      stopDistance: proposal.stopDistance,
      targetDistance: null,
      riskRewardRatio: proposal.riskRewardRatio,
      stopMethod: proposal.stopMethod,
      targetMethod: proposal.targetMethod,
      confidence: input.confidence,
      scorable: false,
      unscorableReason: "CFD_TAKE_PROFIT_MISSING",
      proposalReasons: [...proposal.reasons]
    };
  }
  if (!Number.isFinite(proposal.stopLoss)) {
    return {
      action: input.action,
      strategyId: input.strategyId,
      signalTimestampMs: input.signalTimestampMs,
      entryPrice: input.entryPrice,
      stopLoss: null,
      takeProfit: proposal.takeProfit,
      stopDistance: null,
      targetDistance: proposal.targetDistance,
      riskRewardRatio: proposal.riskRewardRatio,
      stopMethod: proposal.stopMethod,
      targetMethod: proposal.targetMethod,
      confidence: input.confidence,
      scorable: false,
      unscorableReason: "CFD_STOP_LOSS_INVALID",
      proposalReasons: [...proposal.reasons]
    };
  }

  return {
    action: input.action,
    strategyId: input.strategyId,
    signalTimestampMs: input.signalTimestampMs,
    entryPrice: input.entryPrice,
    stopLoss: proposal.stopLoss,
    takeProfit: proposal.takeProfit,
    stopDistance: proposal.stopDistance,
    targetDistance: proposal.targetDistance,
    riskRewardRatio: proposal.riskRewardRatio,
    stopMethod: proposal.stopMethod,
    targetMethod: proposal.targetMethod,
    confidence: input.confidence,
    scorable: true,
    unscorableReason: null,
    proposalReasons: [...proposal.reasons]
  };
}

function emptyPassMetrics(): ReplayPassEconomicMetrics {
  return {
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
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/** Aggregate Pass A/C trade list into report metrics (pure). */
export function aggregatePassEconomicMetrics(
  trades: ReadonlyArray<ReplaySimulatedTrade>
): ReplayPassEconomicMetrics {
  const m = emptyPassMetrics();
  m.totalSignals = trades.length;

  const resolvedR: number[] = [];
  const barsHeld: number[] = [];
  let cumR = 0;
  let peakR = 0;
  let maxDd = 0;
  let losingStreak = 0;
  let longestLose = 0;

  for (const t of trades) {
    if (t.fromProductionHold) m.fromProductionHoldSignals += 1;

    const strat = (m.byStrategy[t.strategyId] ??= {
      trades: 0,
      wins: 0,
      losses: 0,
      totalR: 0,
      avgR: null
    });
    strat.trades += 1;

    switch (t.outcome) {
      case "UNSCORABLE":
        m.unscorable += 1;
        break;
      case "AMBIGUOUS":
        m.ambiguous += 1;
        m.scorableTrades += 1;
        break;
      case "OPEN_AT_END":
        m.openAtEnd += 1;
        m.scorableTrades += 1;
        break;
      case "TARGET":
        m.targetHits += 1;
        m.scorableTrades += 1;
        break;
      case "STOP":
        m.stopHits += 1;
        m.scorableTrades += 1;
        break;
    }

    if (t.barsHeld != null) barsHeld.push(t.barsHeld);

    if (t.outcome === "TARGET" || t.outcome === "STOP") {
      const r = t.realizedR ?? 0;
      resolvedR.push(r);
      m.totalRealizedR += r;
      strat.totalR += r;
      if (t.outcome === "TARGET") strat.wins += 1;
      else strat.losses += 1;

      if (t.fromProductionHold) {
        m.fromProductionHoldResolvedR += r;
        m.fromProductionHoldResolvedTrades += 1;
      }

      cumR += r;
      peakR = Math.max(peakR, cumR);
      maxDd = Math.max(maxDd, peakR - cumR);

      if (t.outcome === "STOP" || r < 0) {
        losingStreak += 1;
        longestLose = Math.max(longestLose, losingStreak);
      } else {
        losingStreak = 0;
      }
    }
  }

  for (const s of Object.values(m.byStrategy)) {
    const n = s.wins + s.losses;
    s.avgR = n > 0 ? s.totalR / n : null;
  }

  const resolved = m.targetHits + m.stopHits;
  m.winRate = resolved > 0 ? m.targetHits / resolved : null;
  m.avgRPerResolvedTrade = resolved > 0 ? m.totalRealizedR / resolved : null;
  m.medianR = median(resolvedR);
  m.maxDrawdownR = maxDd;
  m.longestLosingStreak = longestLose;
  m.avgBarsHeld =
    barsHeld.length > 0 ? barsHeld.reduce((a, b) => a + b, 0) / barsHeld.length : null;

  return m;
}

interface PendingSignal {
  pass: ReplaySelectorPass;
  signalCandleIndex: number;
  evaluation: ReplayEconomicEvalSnapshot;
  fromProductionHold: boolean;
  parameters: Record<string, number | boolean | string>;
}

interface OpenPosition {
  pass: ReplaySelectorPass;
  strategyId: string;
  direction: PositionDirection;
  signalCandleIndex: number;
  signalTimeMs: number;
  entryCandleIndex: number;
  entryTimeMs: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  tradePlan: ReplayTradePlanSnapshot;
  fromProductionHold: boolean;
  confidence: number;
}

/**
 * Simulate Pass A and Pass C independently with single-position-per-pass.
 * Entry = next candle open after signal (REPLAY_ENTRY_CONVENTION).
 */
export function simulatePassEconomicOutcomes(input: {
  candles: ReadonlyArray<Candle>;
  signals: ReadonlyArray<ReplayEconomicSignal>;
  parametersByStrategyId: Map<string, Record<string, number | boolean | string>>;
  tickSize: number;
  /** Optional override for feature extraction window start (default: from 0). */
  featureLookback?: number;
}): ReplayEconomicComparison {
  const trades: ReplaySimulatedTrade[] = [];
  const byIndex = new Map<number, ReplayEconomicSignal[]>();
  for (const s of input.signals) {
    const list = byIndex.get(s.signalCandleIndex) ?? [];
    list.push(s);
    byIndex.set(s.signalCandleIndex, list);
  }

  let pendingA: PendingSignal | null = null;
  let pendingC: PendingSignal | null = null;
  let openA: OpenPosition | null = null;
  let openC: OpenPosition | null = null;

  const tryEnter = (
    pending: PendingSignal,
    entryIndex: number
  ): { open: OpenPosition | null; trade: ReplaySimulatedTrade | null } => {
    const entryCandle = input.candles[entryIndex];
    if (!entryCandle) {
      const plan: ReplayTradePlanSnapshot = {
        action: pending.evaluation.action as "BUY" | "SELL",
        strategyId: pending.evaluation.strategyId,
        signalTimestampMs: pending.evaluation.signalTimestampMs,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        stopDistance: null,
        targetDistance: null,
        riskRewardRatio: null,
        stopMethod: null,
        targetMethod: null,
        confidence: pending.evaluation.confidence,
        scorable: false,
        unscorableReason: "NO_NEXT_CANDLE_FOR_ENTRY",
        proposalReasons: []
      };
      return {
        open: null,
        trade: {
          pass: pending.pass,
          strategyId: pending.evaluation.strategyId,
          direction: pending.evaluation.action as PositionDirection,
          signalCandleIndex: pending.signalCandleIndex,
          signalTimeMs: pending.evaluation.signalTimestampMs,
          entryCandleIndex: null,
          entryTimeMs: null,
          entryPrice: null,
          stopPrice: null,
          targetPrice: null,
          exitCandleIndex: null,
          exitTimeMs: null,
          exitPrice: null,
          outcome: "UNSCORABLE",
          realizedR: null,
          barsHeld: null,
          tradePlan: plan,
          fromProductionHold: pending.fromProductionHold,
          confidence: pending.evaluation.confidence
        }
      };
    }

    const signalIdx = pending.signalCandleIndex;
    const lookback = input.featureLookback ?? 1500;
    const windowStart = Math.max(0, signalIdx + 1 - lookback);
    const ctxCandles = input.candles.slice(windowStart, signalIdx + 1);
    const features = extractFeatures(ctxCandles, DEFAULT_FEATURE_CONFIG);
    const latest = features[features.length - 1];
    if (!latest) {
      const plan: ReplayTradePlanSnapshot = {
        action: pending.evaluation.action as "BUY" | "SELL",
        strategyId: pending.evaluation.strategyId,
        signalTimestampMs: pending.evaluation.signalTimestampMs,
        entryPrice: entryCandle.open,
        stopLoss: null,
        takeProfit: null,
        stopDistance: null,
        targetDistance: null,
        riskRewardRatio: null,
        stopMethod: null,
        targetMethod: null,
        confidence: pending.evaluation.confidence,
        scorable: false,
        unscorableReason: "FEATURES_UNAVAILABLE_AT_SIGNAL",
        proposalReasons: []
      };
      return {
        open: null,
        trade: {
          pass: pending.pass,
          strategyId: pending.evaluation.strategyId,
          direction: pending.evaluation.action as PositionDirection,
          signalCandleIndex: pending.signalCandleIndex,
          signalTimeMs: pending.evaluation.signalTimestampMs,
          entryCandleIndex: entryIndex,
          entryTimeMs: entryCandle.openTime,
          entryPrice: entryCandle.open,
          stopPrice: null,
          targetPrice: null,
          exitCandleIndex: null,
          exitTimeMs: null,
          exitPrice: null,
          outcome: "UNSCORABLE",
          realizedR: null,
          barsHeld: null,
          tradePlan: plan,
          fromProductionHold: pending.fromProductionHold,
          confidence: pending.evaluation.confidence
        }
      };
    }

    const params =
      input.parametersByStrategyId.get(pending.evaluation.strategyId) ?? pending.parameters;
    const plan = buildReplayTradePlan({
      strategyId: pending.evaluation.strategyId,
      action: pending.evaluation.action as "BUY" | "SELL",
      confidence: pending.evaluation.confidence,
      signalTimestampMs: pending.evaluation.signalTimestampMs,
      entryPrice: entryCandle.open,
      features: latest,
      candles: ctxCandles,
      metadata: pending.evaluation.decisionMetadata,
      tickSize: input.tickSize,
      parameters: params
    });

    if (!plan.scorable || plan.stopLoss == null || plan.takeProfit == null) {
      return {
        open: null,
        trade: {
          pass: pending.pass,
          strategyId: pending.evaluation.strategyId,
          direction: pending.evaluation.action as PositionDirection,
          signalCandleIndex: pending.signalCandleIndex,
          signalTimeMs: pending.evaluation.signalTimestampMs,
          entryCandleIndex: entryIndex,
          entryTimeMs: entryCandle.openTime,
          entryPrice: entryCandle.open,
          stopPrice: plan.stopLoss,
          targetPrice: plan.takeProfit,
          exitCandleIndex: null,
          exitTimeMs: null,
          exitPrice: null,
          outcome: "UNSCORABLE",
          realizedR: null,
          barsHeld: null,
          tradePlan: plan,
          fromProductionHold: pending.fromProductionHold,
          confidence: pending.evaluation.confidence
        }
      };
    }

    return {
      open: {
        pass: pending.pass,
        strategyId: pending.evaluation.strategyId,
        direction: pending.evaluation.action as PositionDirection,
        signalCandleIndex: pending.signalCandleIndex,
        signalTimeMs: pending.evaluation.signalTimestampMs,
        entryCandleIndex: entryIndex,
        entryTimeMs: entryCandle.openTime,
        entryPrice: entryCandle.open,
        stopPrice: plan.stopLoss,
        targetPrice: plan.takeProfit,
        tradePlan: plan,
        fromProductionHold: pending.fromProductionHold,
        confidence: pending.evaluation.confidence
      },
      trade: null
    };
  };

  const resolveOpen = (open: OpenPosition, atIndex: number): ReplaySimulatedTrade | null => {
    if (atIndex < open.entryCandleIndex) return null;
    const forward = input.candles.slice(open.entryCandleIndex, atIndex + 1);
    const walk = simulateStopTargetWalk({
      direction: open.direction,
      entryPrice: open.entryPrice,
      stopLoss: open.stopPrice,
      takeProfit: open.targetPrice,
      forwardBars: forward
    });

    if (walk.outcome === "OPEN_AT_END") return null;

    const exitOffset = walk.exitCandleOffset!;
    const exitCandle = forward[exitOffset]!;
    return {
      pass: open.pass,
      strategyId: open.strategyId,
      direction: open.direction,
      signalCandleIndex: open.signalCandleIndex,
      signalTimeMs: open.signalTimeMs,
      entryCandleIndex: open.entryCandleIndex,
      entryTimeMs: open.entryTimeMs,
      entryPrice: open.entryPrice,
      stopPrice: open.stopPrice,
      targetPrice: open.targetPrice,
      exitCandleIndex: open.entryCandleIndex + exitOffset,
      exitTimeMs: exitCandle.closeTime,
      exitPrice: walk.exitPrice,
      outcome: walk.outcome,
      realizedR: walk.realizedR,
      barsHeld: walk.barsHeld,
      tradePlan: open.tradePlan,
      fromProductionHold: open.fromProductionHold,
      confidence: open.confidence
    };
  };

  const closeOpenAtEnd = (open: OpenPosition): ReplaySimulatedTrade => {
    const lastIdx = input.candles.length - 1;
    const forward = input.candles.slice(open.entryCandleIndex, lastIdx + 1);
    const walk = simulateStopTargetWalk({
      direction: open.direction,
      entryPrice: open.entryPrice,
      stopLoss: open.stopPrice,
      takeProfit: open.targetPrice,
      forwardBars: forward
    });
    if (walk.outcome !== "OPEN_AT_END") {
      const exitOffset = walk.exitCandleOffset!;
      const exitCandle = forward[exitOffset]!;
      return {
        pass: open.pass,
        strategyId: open.strategyId,
        direction: open.direction,
        signalCandleIndex: open.signalCandleIndex,
        signalTimeMs: open.signalTimeMs,
        entryCandleIndex: open.entryCandleIndex,
        entryTimeMs: open.entryTimeMs,
        entryPrice: open.entryPrice,
        stopPrice: open.stopPrice,
        targetPrice: open.targetPrice,
        exitCandleIndex: open.entryCandleIndex + exitOffset,
        exitTimeMs: exitCandle.closeTime,
        exitPrice: walk.exitPrice,
        outcome: walk.outcome,
        realizedR: walk.realizedR,
        barsHeld: walk.barsHeld,
        tradePlan: open.tradePlan,
        fromProductionHold: open.fromProductionHold,
        confidence: open.confidence
      };
    }
    const last = input.candles[lastIdx]!;
    return {
      pass: open.pass,
      strategyId: open.strategyId,
      direction: open.direction,
      signalCandleIndex: open.signalCandleIndex,
      signalTimeMs: open.signalTimeMs,
      entryCandleIndex: open.entryCandleIndex,
      entryTimeMs: open.entryTimeMs,
      entryPrice: open.entryPrice,
      stopPrice: open.stopPrice,
      targetPrice: open.targetPrice,
      exitCandleIndex: lastIdx,
      exitTimeMs: last.closeTime,
      exitPrice: last.close,
      outcome: "OPEN_AT_END",
      realizedR: null,
      barsHeld: walk.barsHeld,
      tradePlan: open.tradePlan,
      fromProductionHold: open.fromProductionHold,
      confidence: open.confidence
    };
  };

  for (let i = 0; i < input.candles.length; i++) {
    // Enter pending signals whose entry candle is this bar.
    if (pendingA && i === pendingA.signalCandleIndex + 1 && !openA) {
      const result = tryEnter(pendingA, i);
      pendingA = null;
      if (result.trade) trades.push(result.trade);
      if (result.open) openA = result.open;
    }
    if (pendingC && i === pendingC.signalCandleIndex + 1 && !openC) {
      const result = tryEnter(pendingC, i);
      pendingC = null;
      if (result.trade) trades.push(result.trade);
      if (result.open) openC = result.open;
    }

    // Resolve opens against this bar (including entry bar).
    if (openA && i >= openA.entryCandleIndex) {
      const closed = resolveOpen(openA, i);
      if (closed) {
        trades.push(closed);
        openA = null;
      }
    }
    if (openC && i >= openC.entryCandleIndex) {
      const closed = resolveOpen(openC, i);
      if (closed) {
        trades.push(closed);
        openC = null;
      }
    }

    // Queue new signals (single position: only if flat and no pending).
    const signalsHere = byIndex.get(i) ?? [];
    for (const sig of signalsHere) {
      if (sig.evaluation.action !== "BUY" && sig.evaluation.action !== "SELL") continue;
      if (sig.pass === "A") {
        if (!openA && !pendingA) {
          pendingA = {
            pass: "A",
            signalCandleIndex: i,
            evaluation: sig.evaluation,
            fromProductionHold: sig.fromProductionHold,
            parameters: input.parametersByStrategyId.get(sig.evaluation.strategyId) ?? {}
          };
        }
      } else if (!openC && !pendingC) {
        pendingC = {
          pass: "C",
          signalCandleIndex: i,
          evaluation: sig.evaluation,
          fromProductionHold: sig.fromProductionHold,
          parameters: input.parametersByStrategyId.get(sig.evaluation.strategyId) ?? {}
        };
      }
    }
  }

  // Flush pending without entry candle.
  if (pendingA) {
    const result = tryEnter(pendingA, pendingA.signalCandleIndex + 1);
    if (result.trade) trades.push(result.trade);
    if (result.open) openA = result.open;
    pendingA = null;
  }
  if (pendingC) {
    const result = tryEnter(pendingC, pendingC.signalCandleIndex + 1);
    if (result.trade) trades.push(result.trade);
    if (result.open) openC = result.open;
    pendingC = null;
  }

  if (openA) trades.push(closeOpenAtEnd(openA));
  if (openC) trades.push(closeOpenAtEnd(openC));

  // Stable order: by signal time then pass.
  trades.sort((a, b) => {
    if (a.signalCandleIndex !== b.signalCandleIndex) {
      return a.signalCandleIndex - b.signalCandleIndex;
    }
    return a.pass.localeCompare(b.pass);
  });

  const passATrades = trades.filter((t) => t.pass === "A");
  const passCTrades = trades.filter((t) => t.pass === "C");

  return {
    entryConvention: REPLAY_ENTRY_CONVENTION,
    entryConventionNote:
      "Enter at the next closed candle's open after the signal candle. Signal decisions use candles[0..signal] only; the entry open is used solely for fill + stop/target proposal after the signal exists. Live fills at contemporaneous quote — this offline convention is conservative and not a live-fill guarantee.",
    positionModel: "SINGLE_POSITION_PER_PASS",
    positionModelNote:
      "Pass A and Pass C each allow at most one open position (independent maps). While a pass has a pending entry or open trade, further signals for that pass are skipped. Pass A state never affects Pass C.",
    tickSize: input.tickSize,
    passA: aggregatePassEconomicMetrics(passATrades),
    passC: aggregatePassEconomicMetrics(passCTrades),
    trades
  };
}

/** Type guard helper for decision action narrowing. */
export function isBuyOrSell(
  action: StrategyDecision["action"]
): action is "BUY" | "SELL" {
  return action === "BUY" || action === "SELL";
}
