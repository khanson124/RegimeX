/**
 * Offline economic outcome simulation for AUTO counterfactual replay (Pass A vs Pass C).
 *
 * Does not place orders or change live/demo/REAL behavior.
 * Stop/target geometry comes from strategy-specific proposeCfdStopTarget — never invented.
 */
import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type PositionDirection,
  type StrategyDecision
} from "@regimex/shared";
import {
  DEFAULT_FEATURE_CONFIG,
  extractFeatures
} from "../features/featureExtractor.js";
import { proposeCfdStopTarget } from "../strategies/cfdCapability.js";
import {
  EMA_FALLBACK_STRATEGY_ID,
  buildEmaFallbackFromHoldDiagnostics,
  type EmaFallbackFromHoldDiagnostics,
  type EmaSignalContext
} from "./autoSelectionEmaFallbackDiagnostics.js";

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
  /** Regime classified on the signal candle (candles[0..signal] only). */
  regime: MarketRegime | null;
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

export interface ReplayDiagnosticGroupStats {
  trades: number;
  /** TARGET + STOP only. */
  resolvedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  ambiguous: number;
  openAtEnd: number;
  unscorable: number;
  avgBarsHeld: number | null;
}

export type ReplayTradeDirection = "BUY" | "SELL";

/** Regime key used when a trade has no signal-candle regime attached. */
export const REPLAY_UNATTRIBUTED_REGIME = "UNATTRIBUTED" as const;

export interface ReplayDiagnosticGroupRow extends ReplayDiagnosticGroupStats {
  strategyId: string;
  direction: ReplayTradeDirection;
  regime: string;
}

export interface ReplayFallbackFromHoldDiagnostics {
  /** Resolved-trade floor for worstGroups / bestGroups. */
  minResolvedForRanking: number;
  rankingLimit: number;
  totals: ReplayDiagnosticGroupStats;
  byStrategy: Record<string, ReplayDiagnosticGroupStats>;
  byStrategyDirection: Record<string, Partial<Record<ReplayTradeDirection, ReplayDiagnosticGroupStats>>>;
  byStrategyDirectionRegime: Record<
    string,
    Partial<Record<ReplayTradeDirection, Record<string, ReplayDiagnosticGroupStats>>>
  >;
  /** Strategy+direction+regime groups sorted by totalR ascending. */
  worstGroups: ReplayDiagnosticGroupRow[];
  /** Strategy+direction+regime groups sorted by totalR descending. */
  bestGroups: ReplayDiagnosticGroupRow[];
}

export interface ReplayEconomicComparison {
  entryConvention: ReplayEntryConvention;
  entryConventionNote: string;
  positionModel: "SINGLE_POSITION_PER_PASS";
  positionModelNote: string;
  tickSize: number;
  passA: ReplayPassEconomicMetrics;
  passC: ReplayPassEconomicMetrics;
  /** Diagnostic-only breakdown of Pass C trades where fromProductionHold === true. */
  passCFallbackFromHold: ReplayFallbackFromHoldDiagnostics;
  /** Diagnostic-only EMA pullback geometry / excursion breakdown for Pass C fallback-from-HOLD. */
  emaFallbackFromHold: EmaFallbackFromHoldDiagnostics;
  trades: ReplaySimulatedTrade[];
}

export interface ReplayEconomicSignal {
  pass: ReplaySelectorPass;
  signalCandleIndex: number;
  evaluation: ReplayEconomicEvalSnapshot;
  fromProductionHold: boolean;
  /** Regime classified on the signal candle; never recomputed from later candles. */
  regime?: MarketRegime | null;
  regimeConfidence?: number | null;
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

class GroupAccumulator {
  trades = 0;
  wins = 0;
  losses = 0;
  totalR = 0;
  ambiguous = 0;
  openAtEnd = 0;
  unscorable = 0;
  private barsHeldSum = 0;
  private barsHeldCount = 0;

  add(t: ReplaySimulatedTrade): void {
    this.trades += 1;
    if (t.barsHeld != null) {
      this.barsHeldSum += t.barsHeld;
      this.barsHeldCount += 1;
    }
    switch (t.outcome) {
      case "TARGET":
        this.wins += 1;
        this.totalR += t.realizedR ?? 0;
        break;
      case "STOP":
        this.losses += 1;
        this.totalR += t.realizedR ?? 0;
        break;
      case "AMBIGUOUS":
        this.ambiguous += 1;
        break;
      case "OPEN_AT_END":
        this.openAtEnd += 1;
        break;
      case "UNSCORABLE":
        this.unscorable += 1;
        break;
    }
  }

  stats(): ReplayDiagnosticGroupStats {
    const resolved = this.wins + this.losses;
    return {
      trades: this.trades,
      resolvedTrades: resolved,
      wins: this.wins,
      losses: this.losses,
      winRate: resolved > 0 ? this.wins / resolved : null,
      totalR: this.totalR,
      avgR: resolved > 0 ? this.totalR / resolved : null,
      ambiguous: this.ambiguous,
      openAtEnd: this.openAtEnd,
      unscorable: this.unscorable,
      avgBarsHeld: this.barsHeldCount > 0 ? this.barsHeldSum / this.barsHeldCount : null
    };
  }
}

/**
 * Diagnostic breakdown of Pass C fallback-from-production-HOLD trades by
 * strategy / direction / signal-candle regime. Reporting only — no gating.
 */
export function buildFallbackFromHoldDiagnostics(
  trades: ReadonlyArray<ReplaySimulatedTrade>,
  options?: { minResolvedForRanking?: number; rankingLimit?: number }
): ReplayFallbackFromHoldDiagnostics {
  const minResolvedForRanking = options?.minResolvedForRanking ?? 2;
  const rankingLimit = options?.rankingLimit ?? 10;
  const scoped = trades.filter((t) => t.pass === "C" && t.fromProductionHold);

  const totals = new GroupAccumulator();
  const byStrategy = new Map<string, GroupAccumulator>();
  const byStrategyDirection = new Map<string, Map<ReplayTradeDirection, GroupAccumulator>>();
  const byGroup = new Map<
    string,
    Map<ReplayTradeDirection, Map<string, GroupAccumulator>>
  >();

  for (const t of scoped) {
    const direction = t.direction as ReplayTradeDirection;
    const regime = t.regime ?? REPLAY_UNATTRIBUTED_REGIME;
    totals.add(t);

    let s = byStrategy.get(t.strategyId);
    if (!s) byStrategy.set(t.strategyId, (s = new GroupAccumulator()));
    s.add(t);

    let dirs = byStrategyDirection.get(t.strategyId);
    if (!dirs) byStrategyDirection.set(t.strategyId, (dirs = new Map()));
    let d = dirs.get(direction);
    if (!d) dirs.set(direction, (d = new GroupAccumulator()));
    d.add(t);

    let gDirs = byGroup.get(t.strategyId);
    if (!gDirs) byGroup.set(t.strategyId, (gDirs = new Map()));
    let regimes = gDirs.get(direction);
    if (!regimes) gDirs.set(direction, (regimes = new Map()));
    let g = regimes.get(regime);
    if (!g) regimes.set(regime, (g = new GroupAccumulator()));
    g.add(t);
  }

  const byStrategyOut: ReplayFallbackFromHoldDiagnostics["byStrategy"] = {};
  for (const [id, acc] of byStrategy) byStrategyOut[id] = acc.stats();

  const byStrategyDirectionOut: ReplayFallbackFromHoldDiagnostics["byStrategyDirection"] = {};
  for (const [id, dirs] of byStrategyDirection) {
    const out: Partial<Record<ReplayTradeDirection, ReplayDiagnosticGroupStats>> = {};
    for (const [dir, acc] of dirs) out[dir] = acc.stats();
    byStrategyDirectionOut[id] = out;
  }

  const byGroupOut: ReplayFallbackFromHoldDiagnostics["byStrategyDirectionRegime"] = {};
  const rows: ReplayDiagnosticGroupRow[] = [];
  for (const [id, dirs] of byGroup) {
    const dirOut: Partial<Record<ReplayTradeDirection, Record<string, ReplayDiagnosticGroupStats>>> = {};
    for (const [dir, regimes] of dirs) {
      const regimeOut: Record<string, ReplayDiagnosticGroupStats> = {};
      for (const [regime, acc] of regimes) {
        const stats = acc.stats();
        regimeOut[regime] = stats;
        rows.push({ strategyId: id, direction: dir, regime, ...stats });
      }
      dirOut[dir] = regimeOut;
    }
    byGroupOut[id] = dirOut;
  }

  const rankable = rows.filter((r) => r.resolvedTrades >= minResolvedForRanking);
  const tieBreak = (a: ReplayDiagnosticGroupRow, b: ReplayDiagnosticGroupRow) =>
    `${a.strategyId}|${a.direction}|${a.regime}`.localeCompare(`${b.strategyId}|${b.direction}|${b.regime}`);
  const worstGroups = [...rankable]
    .sort((a, b) => a.totalR - b.totalR || tieBreak(a, b))
    .slice(0, rankingLimit);
  const bestGroups = [...rankable]
    .sort((a, b) => b.totalR - a.totalR || tieBreak(a, b))
    .slice(0, rankingLimit);

  return {
    minResolvedForRanking,
    rankingLimit,
    totals: totals.stats(),
    byStrategy: byStrategyOut,
    byStrategyDirection: byStrategyDirectionOut,
    byStrategyDirectionRegime: byGroupOut,
    worstGroups,
    bestGroups
  };
}

interface PendingSignal {
  pass: ReplaySelectorPass;
  signalCandleIndex: number;
  evaluation: ReplayEconomicEvalSnapshot;
  fromProductionHold: boolean;
  regime: MarketRegime | null;
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
  regime: MarketRegime | null;
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
          regime: pending.regime,
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
          regime: pending.regime,
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
          regime: pending.regime,
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
        regime: pending.regime,
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
      regime: open.regime,
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
        regime: open.regime,
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
      regime: open.regime,
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
    const signalsHere: ReplayEconomicSignal[] = byIndex.get(i) ?? [];
    for (const sig of signalsHere) {
      if (sig.evaluation.action !== "BUY" && sig.evaluation.action !== "SELL") continue;
      if (sig.pass === "A") {
        if (!openA && !pendingA) {
          pendingA = {
            pass: "A",
            signalCandleIndex: i,
            evaluation: sig.evaluation,
            fromProductionHold: sig.fromProductionHold,
            regime: sig.regime ?? null,
            parameters: input.parametersByStrategyId.get(sig.evaluation.strategyId) ?? {}
          };
        }
      } else if (!openC && !pendingC) {
        pendingC = {
          pass: "C",
          signalCandleIndex: i,
          evaluation: sig.evaluation,
          fromProductionHold: sig.fromProductionHold,
          regime: sig.regime ?? null,
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

  // Signal-time context (candles[0..signal] only) for EMA fallback-from-HOLD diagnostics.
  const emaSignalContexts = new Map<number, EmaSignalContext>();
  const lookback = input.featureLookback ?? 1500;
  for (const s of input.signals) {
    if (s.pass !== "C" || !s.fromProductionHold) continue;
    if (s.evaluation.strategyId !== EMA_FALLBACK_STRATEGY_ID) continue;
    if (!passCTrades.some((t) => t.signalCandleIndex === s.signalCandleIndex)) continue;
    const start = Math.max(0, s.signalCandleIndex + 1 - lookback);
    const window = input.candles.slice(start, s.signalCandleIndex + 1);
    const features = window.length > 0 ? extractFeatures(window, DEFAULT_FEATURE_CONFIG) : [];
    emaSignalContexts.set(s.signalCandleIndex, {
      features: features[features.length - 1] ?? null,
      decisionMetadata: s.evaluation.decisionMetadata,
      regimeConfidence: s.regimeConfidence ?? null
    });
  }

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
    passCFallbackFromHold: buildFallbackFromHoldDiagnostics(passCTrades),
    emaFallbackFromHold: buildEmaFallbackFromHoldDiagnostics({
      trades: passCTrades,
      candles: input.candles,
      contextBySignal: emaSignalContexts
    }),
    trades
  };
}

/** Type guard helper for decision action narrowing. */
export function isBuyOrSell(
  action: StrategyDecision["action"]
): action is "BUY" | "SELL" {
  return action === "BUY" || action === "SELL";
}
