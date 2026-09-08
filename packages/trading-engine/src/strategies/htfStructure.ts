/**
 * Confirmed higher-timeframe market structure (research).
 * Uses only confirmed fractal swings — no future pivots.
 */
import { type Candle } from "@regimex/shared";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind,
  priorSwingBefore,
  type SwingPivot
} from "./structureSwings.js";

export type HtfStructureState = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface HtfStructureSnapshot {
  state: HtfStructureState;
  strength: number;
  lastSwingHigh: SwingPivot | null;
  lastSwingLow: SwingPivot | null;
  prevSwingHigh: SwingPivot | null;
  prevSwingLow: SwingPivot | null;
  midPoint: number | null;
  emaSlopeUp: boolean | null;
  emaFast: number | null;
  emaSlow: number | null;
}

function simpleEma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
  }
  return ema;
}

function emaAt(closes: number[], period: number, endExclusive: number): number | null {
  if (endExclusive < period) return null;
  return simpleEma(closes.slice(0, endExclusive), period);
}

/**
 * Classify structure from the last two confirmed highs and lows.
 * Strength 0–1 from consecutive HH/HL or LH/LL alignment + optional EMA slope.
 */
export function classifyHtfStructure(
  htfCandles: ReadonlyArray<Candle>,
  opts?: { swingLookback?: number; emaFast?: number; emaSlow?: number }
): HtfStructureSnapshot {
  const swingLookback = opts?.swingLookback ?? 2;
  const emaFastPeriod = opts?.emaFast ?? 8;
  const emaSlowPeriod = opts?.emaSlow ?? 21;
  const asOf = htfCandles.length - 1;
  if (asOf < swingLookback * 2 + 2) {
    return {
      state: "NEUTRAL",
      strength: 0,
      lastSwingHigh: null,
      lastSwingLow: null,
      prevSwingHigh: null,
      prevSwingLow: null,
      midPoint: null,
      emaSlopeUp: null,
      emaFast: null,
      emaSlow: null
    };
  }

  const pivots = findConfirmedSwingPivots(htfCandles, asOf, swingLookback);
  const lastHigh = latestSwingOfKind(pivots, "high");
  const lastLow = latestSwingOfKind(pivots, "low");
  const prevHigh = lastHigh ? priorSwingBefore(pivots, lastHigh.index, "high") : null;
  const prevLow = lastLow ? priorSwingBefore(pivots, lastLow.index, "low") : null;

  let state: HtfStructureState = "NEUTRAL";
  let strength = 0;

  const hh = lastHigh && prevHigh && lastHigh.price > prevHigh.price;
  const hl = lastLow && prevLow && lastLow.price > prevLow.price;
  const lh = lastHigh && prevHigh && lastHigh.price < prevHigh.price;
  const ll = lastLow && prevLow && lastLow.price < prevLow.price;

  if (hh && hl) {
    state = "BULLISH";
    strength = 0.55;
  } else if (lh && ll) {
    state = "BEARISH";
    strength = 0.55;
  } else if (hh || hl) {
    state = "BULLISH";
    strength = 0.3;
  } else if (lh || ll) {
    state = "BEARISH";
    strength = 0.3;
  }

  const closes = htfCandles.map((c) => c.close);
  const emaFast = emaAt(closes, emaFastPeriod, closes.length);
  const emaSlow = emaAt(closes, emaSlowPeriod, closes.length);
  const emaFastPrev = emaAt(closes, emaFastPeriod, closes.length - 1);
  const emaSlopeUp =
    emaFast != null && emaFastPrev != null ? emaFast > emaFastPrev : null;

  if (state === "BULLISH" && emaFast != null && emaSlow != null && emaFast > emaSlow) {
    strength = Math.min(1, strength + 0.2);
  }
  if (state === "BEARISH" && emaFast != null && emaSlow != null && emaFast < emaSlow) {
    strength = Math.min(1, strength + 0.2);
  }
  if (state === "BULLISH" && emaSlopeUp === true) strength = Math.min(1, strength + 0.1);
  if (state === "BEARISH" && emaSlopeUp === false) strength = Math.min(1, strength + 0.1);

  const midPoint =
    lastHigh && lastLow ? (lastHigh.price + lastLow.price) / 2 : null;

  // Soft check: close relative to midpoint reinforces / weakens
  const lastClose = htfCandles[asOf]!.close;
  if (midPoint != null) {
    if (state === "BULLISH" && lastClose >= midPoint) strength = Math.min(1, strength + 0.1);
    if (state === "BEARISH" && lastClose <= midPoint) strength = Math.min(1, strength + 0.1);
    if (state === "BULLISH" && lastClose < midPoint) strength = Math.max(0, strength - 0.15);
    if (state === "BEARISH" && lastClose > midPoint) strength = Math.max(0, strength - 0.15);
  }

  return {
    state,
    strength: Number(strength.toFixed(4)),
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
    prevSwingHigh: prevHigh,
    prevSwingLow: prevLow,
    midPoint,
    emaSlopeUp,
    emaFast,
    emaSlow
  };
}
