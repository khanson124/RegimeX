/**
 * Offline diagnostics for the AUTO counterfactual economic simulator and its candle input.
 * Reporting only — does not change fills, position handling, or any live behavior.
 */
import { type Candle, type PositionDirection } from "@regimex/shared";

export const LONG_HELD_THRESHOLDS_BARS = [100, 500, 1000, 5000] as const;
export const PRICE_JUMP_THRESHOLDS = [0.1, 0.25, 0.4, 0.5] as const;

/** How the exit bar related to the stop/target level at its open. */
export interface ReplayExitGap {
  exitBarOpen: number;
  exitBarHigh: number;
  exitBarLow: number;
  /** Exit bar opened at or beyond the stop (BUY: open <= stop; SELL: open >= stop). */
  gapThroughStop: boolean;
  /** Exit bar opened at or beyond the target (BUY: open >= target; SELL: open <= target). */
  gapThroughTarget: boolean;
  /** Whole exit bar lies beyond the stop (BUY: high < stop; SELL: low > stop). */
  barEntirelyBeyondStop: boolean;
  /** Whole exit bar lies beyond the target (BUY: low > target; SELL: high < target). */
  barEntirelyBeyondTarget: boolean;
  /** R the trade would have realized if filled at the exit bar open instead of the level. */
  rIfFilledAtOpen: number | null;
}

export function describeExitGap(input: {
  direction: PositionDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitBar: Pick<Candle, "open" | "high" | "low">;
}): ReplayExitGap {
  const { direction, entryPrice, stopLoss, takeProfit, exitBar } = input;
  const buy = direction === "BUY";
  const risk = Math.abs(entryPrice - stopLoss);
  const pnlAtOpen = buy ? exitBar.open - entryPrice : entryPrice - exitBar.open;
  return {
    exitBarOpen: exitBar.open,
    exitBarHigh: exitBar.high,
    exitBarLow: exitBar.low,
    gapThroughStop: buy ? exitBar.open <= stopLoss : exitBar.open >= stopLoss,
    gapThroughTarget: buy ? exitBar.open >= takeProfit : exitBar.open <= takeProfit,
    barEntirelyBeyondStop: buy ? exitBar.high < stopLoss : exitBar.low > stopLoss,
    barEntirelyBeyondTarget: buy ? exitBar.low > takeProfit : exitBar.high < takeProfit,
    rIfFilledAtOpen: risk > 0 ? pnlAtOpen / risk : null
  };
}

export interface ReplaySkippedWhileOpen {
  skippedSignalCandleIndex: number;
  skippedSignalTimeMs: number;
  skippedStrategyId: string;
  skippedDirection: PositionDirection;
  openStrategyId: string;
  openDirection: PositionDirection;
  openEntryCandleIndex: number;
  openEntryTimeMs: number;
  openEntryPrice: number;
  openStopPrice: number;
  openTargetPrice: number;
  /** Bars held so far including the current bar. */
  barsHeldSoFar: number;
}

export interface ReplayBlockingPositionSummary {
  openStrategyId: string;
  openDirection: PositionDirection;
  openEntryCandleIndex: number;
  openEntryTimeMs: number;
  openEntryPrice: number;
  openStopPrice: number;
  openTargetPrice: number;
  skippedSignals: number;
  firstSkippedSignalTimeMs: number;
  lastSkippedSignalTimeMs: number;
  maxBarsHeldWhenSkipping: number;
}

export interface ReplayLongHeldTrade {
  strategyId: string;
  direction: PositionDirection;
  outcome: string;
  entryTimeMs: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  exitTimeMs: number | null;
  exitPrice: number | null;
  barsHeld: number;
  stopDistance: number | null;
  targetDistance: number | null;
}

export interface ReplayPassSimulationDiagnostics {
  executableSignalsSeen: number;
  signalsAcceptedAsPending: number;
  signalsSkippedPendingAlreadyExists: number;
  signalsSkippedOpenPosition: number;
  entriesOpened: number;
  tradesResolved: number;
  tradesOpenAtEnd: number;
  unscorableEntries: number;
  maxBarsHeld: number | null;
  longestTrade: ReplayLongHeldTrade | null;
  longHeldCounts: Record<`>${(typeof LONG_HELD_THRESHOLDS_BARS)[number]}`, number>;
  /** Trades held > 100 bars (sorted by barsHeld desc). */
  longHeldTrades: ReplayLongHeldTrade[];
  /** Positions that caused skips, with how many later signals each one blocked. */
  blockingPositions: ReplayBlockingPositionSummary[];
  /** Individual skip events (capped; see skippedWhileOpenTruncated). */
  skippedWhileOpen: ReplaySkippedWhileOpen[];
  skippedWhileOpenTruncated: boolean;
  exitGaps: {
    stopExits: number;
    targetExits: number;
    stopExitsGappedThrough: number;
    targetExitsGappedThrough: number;
    stopExitsBarEntirelyBeyond: number;
    targetExitsBarEntirelyBeyond: number;
    /** Worst R that stop exits would have realized if filled at the gapped open. */
    worstStopRIfFilledAtOpen: number | null;
  };
}

export const SKIPPED_WHILE_OPEN_CAP = 10_000;

export function emptyPassSimulationDiagnostics(): ReplayPassSimulationDiagnostics {
  return {
    executableSignalsSeen: 0,
    signalsAcceptedAsPending: 0,
    signalsSkippedPendingAlreadyExists: 0,
    signalsSkippedOpenPosition: 0,
    entriesOpened: 0,
    tradesResolved: 0,
    tradesOpenAtEnd: 0,
    unscorableEntries: 0,
    maxBarsHeld: null,
    longestTrade: null,
    longHeldCounts: { ">100": 0, ">500": 0, ">1000": 0, ">5000": 0 },
    longHeldTrades: [],
    blockingPositions: [],
    skippedWhileOpen: [],
    skippedWhileOpenTruncated: false,
    exitGaps: {
      stopExits: 0,
      targetExits: 0,
      stopExitsGappedThrough: 0,
      targetExitsGappedThrough: 0,
      stopExitsBarEntirelyBeyond: 0,
      targetExitsBarEntirelyBeyond: 0,
      worstStopRIfFilledAtOpen: null
    }
  };
}

/** Fill hold-duration and exit-gap fields from the finished trade list of one pass. */
export function finalizePassSimulationDiagnostics(
  d: ReplayPassSimulationDiagnostics,
  trades: ReadonlyArray<{
    strategyId: string;
    direction: PositionDirection;
    outcome: string;
    entryTimeMs: number | null;
    entryPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
    exitTimeMs: number | null;
    exitPrice: number | null;
    barsHeld: number | null;
    exitGap?: ReplayExitGap | null;
  }>
): ReplayPassSimulationDiagnostics {
  const held: ReplayLongHeldTrade[] = [];
  for (const t of trades) {
    if (t.barsHeld == null || t.entryPrice == null) continue;
    held.push({
      strategyId: t.strategyId,
      direction: t.direction,
      outcome: t.outcome,
      entryTimeMs: t.entryTimeMs,
      entryPrice: t.entryPrice,
      stopPrice: t.stopPrice,
      targetPrice: t.targetPrice,
      exitTimeMs: t.exitTimeMs,
      exitPrice: t.exitPrice,
      barsHeld: t.barsHeld,
      stopDistance: t.stopPrice != null ? Math.abs(t.entryPrice - t.stopPrice) : null,
      targetDistance: t.targetPrice != null ? Math.abs(t.targetPrice - t.entryPrice) : null
    });

    const gap = t.exitGap;
    if (t.outcome === "STOP") {
      d.exitGaps.stopExits += 1;
      if (gap?.gapThroughStop) {
        d.exitGaps.stopExitsGappedThrough += 1;
        if (gap.rIfFilledAtOpen != null) {
          d.exitGaps.worstStopRIfFilledAtOpen =
            d.exitGaps.worstStopRIfFilledAtOpen == null
              ? gap.rIfFilledAtOpen
              : Math.min(d.exitGaps.worstStopRIfFilledAtOpen, gap.rIfFilledAtOpen);
        }
      }
      if (gap?.barEntirelyBeyondStop) d.exitGaps.stopExitsBarEntirelyBeyond += 1;
    } else if (t.outcome === "TARGET") {
      d.exitGaps.targetExits += 1;
      if (gap?.gapThroughTarget) d.exitGaps.targetExitsGappedThrough += 1;
      if (gap?.barEntirelyBeyondTarget) d.exitGaps.targetExitsBarEntirelyBeyond += 1;
    }
  }
  held.sort((a, b) => b.barsHeld - a.barsHeld);
  d.maxBarsHeld = held[0]?.barsHeld ?? null;
  d.longestTrade = held[0] ?? null;
  for (const th of LONG_HELD_THRESHOLDS_BARS) {
    d.longHeldCounts[`>${th}`] = held.filter((h) => h.barsHeld > th).length;
  }
  d.longHeldTrades = held.filter((h) => h.barsHeld > LONG_HELD_THRESHOLDS_BARS[0]);
  return d;
}

export interface ReplayPriceJump {
  index: number;
  beforeOpenTimeMs: number;
  afterOpenTimeMs: number;
  beforeClose: number;
  afterClose: number;
  beforeSource: string | null;
  afterSource: string | null;
  /** Signed close-to-close return (after/before − 1). */
  returnPct: number;
  crossSource: boolean;
}

export interface ReplayCandleContinuityDiagnostics {
  candles: number;
  sources: Record<string, number>;
  jumpCounts: Record<`>${number}%`, number>;
  crossSourceJumps: number;
  /** Jumps > 10% in time order (capped at jumpsCap). */
  jumps: ReplayPriceJump[];
  jumpsTruncated: boolean;
  maxAbsReturnPct: number | null;
}

/** Close-to-close continuity scan over the exact candle series the replay consumes. */
export function analyzeCandleContinuity(
  candles: ReadonlyArray<Candle>,
  jumpsCap = 500
): ReplayCandleContinuityDiagnostics {
  const sources: Record<string, number> = {};
  const jumpCounts: Record<string, number> = {};
  for (const th of PRICE_JUMP_THRESHOLDS) jumpCounts[`>${Math.round(th * 100)}%`] = 0;
  const jumps: ReplayPriceJump[] = [];
  let crossSourceJumps = 0;
  let maxAbs: number | null = null;
  let truncated = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const src = c.source ?? "UNKNOWN";
    sources[src] = (sources[src] ?? 0) + 1;
    if (i === 0) continue;
    const p = candles[i - 1]!;
    if (!(p.close > 0)) continue;
    const ret = c.close / p.close - 1;
    const abs = Math.abs(ret);
    maxAbs = maxAbs == null ? abs : Math.max(maxAbs, abs);
    for (const th of PRICE_JUMP_THRESHOLDS) {
      if (abs > th) jumpCounts[`>${Math.round(th * 100)}%`]! += 1;
    }
    if (abs > PRICE_JUMP_THRESHOLDS[0]) {
      const crossSource = (p.source ?? null) !== (c.source ?? null);
      if (crossSource) crossSourceJumps += 1;
      if (jumps.length < jumpsCap) {
        jumps.push({
          index: i,
          beforeOpenTimeMs: p.openTime,
          afterOpenTimeMs: c.openTime,
          beforeClose: p.close,
          afterClose: c.close,
          beforeSource: p.source ?? null,
          afterSource: c.source ?? null,
          returnPct: ret * 100,
          crossSource
        });
      } else {
        truncated = true;
      }
    }
  }

  return {
    candles: candles.length,
    sources,
    jumpCounts: jumpCounts as ReplayCandleContinuityDiagnostics["jumpCounts"],
    crossSourceJumps,
    jumps,
    jumpsTruncated: truncated,
    maxAbsReturnPct: maxAbs == null ? null : maxAbs * 100
  };
}
