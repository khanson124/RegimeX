/**
 * Confirmed fractal swing pivots with no lookahead.
 * A pivot at index i is only available at bar index >= i + lookback
 * (right-side confirmation using bars that already closed).
 */

import { type Candle } from "@regimex/shared";

export interface SwingPivot {
  index: number;
  price: number;
  kind: "high" | "low";
  /** Close time of the pivot candle. */
  time: number;
}

/**
 * Find swing highs/lows confirmed by `lookback` bars on each side.
 * Only pivots with index <= asOfIndex - lookback are returned.
 */
export function findConfirmedSwingPivots(
  candles: ReadonlyArray<Candle>,
  asOfIndex: number,
  lookback = 3
): SwingPivot[] {
  if (lookback < 1 || asOfIndex < lookback * 2) return [];
  const lastConfirmable = asOfIndex - lookback;
  const pivots: SwingPivot[] = [];

  for (let i = lookback; i <= lastConfirmable; i++) {
    const c = candles[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= lookback; k++) {
      const left = candles[i - k];
      const right = candles[i + k];
      if (!left || !right) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (!(c.high > left.high && c.high >= right.high)) isHigh = false;
      if (!(c.low < left.low && c.low <= right.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      pivots.push({ index: i, price: c.high, kind: "high", time: c.closeTime });
    }
    if (isLow) {
      pivots.push({ index: i, price: c.low, kind: "low", time: c.closeTime });
    }
  }
  return pivots;
}

export function latestSwingOfKind(
  pivots: readonly SwingPivot[],
  kind: "high" | "low"
): SwingPivot | null {
  for (let i = pivots.length - 1; i >= 0; i--) {
    const p = pivots[i];
    if (p?.kind === kind) return p;
  }
  return null;
}

/** Most recent swing high before the most recent swing low (or vice versa). */
export function priorSwingBefore(
  pivots: readonly SwingPivot[],
  beforeIndex: number,
  kind: "high" | "low"
): SwingPivot | null {
  for (let i = pivots.length - 1; i >= 0; i--) {
    const p = pivots[i];
    if (p && p.kind === kind && p.index < beforeIndex) return p;
  }
  return null;
}

/**
 * Impulse high since last swing low (BUY impulse maturity):
 * max high from swingLow.index+1 .. asOfIndex.
 */
export function maxHighSince(candles: ReadonlyArray<Candle>, fromExclusive: number, toInclusive: number): number | null {
  if (fromExclusive >= toInclusive) return null;
  let max = -Infinity;
  for (let i = fromExclusive + 1; i <= toInclusive; i++) {
    const h = candles[i]?.high;
    if (h != null && h > max) max = h;
  }
  return Number.isFinite(max) ? max : null;
}

export function minLowSince(candles: ReadonlyArray<Candle>, fromExclusive: number, toInclusive: number): number | null {
  if (fromExclusive >= toInclusive) return null;
  let min = Infinity;
  for (let i = fromExclusive + 1; i <= toInclusive; i++) {
    const l = candles[i]?.low;
    if (l != null && l < min) min = l;
  }
  return Number.isFinite(min) ? min : null;
}
