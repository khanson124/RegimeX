/**
 * As-of-safe multi-timeframe resampling from a 1m series.
 * Only completed contiguous HTF bars whose closeTime <= as-of candle closeTime.
 * No partial HTF bars, no future 1m bars.
 */
import { type Candle } from "@regimex/shared";
import {
  researchCandleOpenTime,
  researchIntervalMs,
  toBacktestCandle,
  type ResearchCandleInterval
} from "../research/researchCandleInterval.js";

function buildContiguousHtf(
  candles1m: ReadonlyArray<Candle>,
  asOfIndex: number,
  targetInterval: ResearchCandleInterval
): Candle[] {
  if (asOfIndex < 0 || asOfIndex >= candles1m.length) return [];
  const asOfClose = candles1m[asOfIndex]!.closeTime;
  const sourceMs = 60_000;
  const targetMs = researchIntervalMs(targetInterval);
  const expected = Math.round(targetMs / sourceMs);
  const out: Candle[] = [];

  let i = 0;
  const end = asOfIndex;
  while (i <= end) {
    const c = candles1m[i]!;
    const bucketOpen = researchCandleOpenTime(c.openTime, targetInterval);
    if (c.openTime !== bucketOpen) {
      // Skip until we align to a bucket open (session gap / incomplete start)
      i++;
      continue;
    }
    if (i + expected - 1 > end) break;

    let ok = true;
    let high = c.high;
    let low = c.low;
    let ticks = c.tickCount;
    for (let k = 0; k < expected; k++) {
      const bar = candles1m[i + k]!;
      const expectedOpen = bucketOpen + k * sourceMs;
      if (bar.openTime !== expectedOpen) {
        ok = false;
        break;
      }
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      ticks += k === 0 ? 0 : bar.tickCount;
    }
    if (!ok) {
      i++;
      continue;
    }
    const closeTime = bucketOpen + targetMs;
    if (closeTime <= asOfClose) {
      const first = candles1m[i]!;
      const last = candles1m[i + expected - 1]!;
      out.push(
        toBacktestCandle({
          symbol: first.symbol,
          interval: targetInterval,
          openTime: bucketOpen,
          closeTime,
          open: first.open,
          high,
          low,
          close: last.close,
          tickCount: ticks,
          isComplete: true,
          source: first.source
        })
      );
    }
    i += expected;
  }
  return out;
}

export function completedHtfBarsAsOf(
  candles1m: ReadonlyArray<Candle>,
  asOfIndex: number,
  targetInterval: ResearchCandleInterval
): Candle[] {
  return buildContiguousHtf(candles1m, asOfIndex, targetInterval);
}

/** True when the as-of 1m bar is the closing minute of an HTF wall-clock bucket. */
export function isHtfBarClose(
  candle1m: Candle,
  targetInterval: Exclude<ResearchCandleInterval, "1m">
): boolean {
  const open = researchCandleOpenTime(candle1m.openTime, targetInterval);
  const close = open + researchIntervalMs(targetInterval);
  return candle1m.closeTime === close;
}

/**
 * True when the as-of 1m bar completes a contiguous HTF bucket
 * (exact expected source minutes ending at this bar).
 */
export function closesCompletedHtfBucket(
  candles1m: ReadonlyArray<Candle>,
  asOfIndex: number,
  targetInterval: Exclude<ResearchCandleInterval, "1m">
): boolean {
  if (asOfIndex < 0 || asOfIndex >= candles1m.length) return false;
  const c = candles1m[asOfIndex]!;
  if (!isHtfBarClose(c, targetInterval)) return false;
  const sourceMs = 60_000;
  const expected = Math.round(researchIntervalMs(targetInterval) / sourceMs);
  if (asOfIndex + 1 < expected) return false;
  const bucketOpen = researchCandleOpenTime(c.openTime, targetInterval);
  for (let k = 0; k < expected; k++) {
    const bar = candles1m[asOfIndex - expected + 1 + k];
    if (!bar || bar.openTime !== bucketOpen + k * sourceMs) return false;
  }
  return true;
}
