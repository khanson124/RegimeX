/**
 * H4 trend bias + session-aware 4h HTF bars for xau-trend-pullback-v1.
 * Shared helpers for research and live — closed bars only, no lookahead.
 */
import { type Candle } from "@regimex/shared";
import {
  researchCandleOpenTime,
  researchIntervalMs,
  toBacktestCandle
} from "../research/researchCandleInterval.js";

export type H4TrendBias = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface H4TrendBiasSnapshot {
  bias: H4TrendBias;
  ema21: number | null;
  ema50: number | null;
  ema21Slope: number | null;
  close: number | null;
  reasons: string[];
}

/** Simple EMA of closes; returns null until warm. */
export function emaSeries(closes: ReadonlyArray<number>, period: number): Array<number | null> {
  const out: Array<number | null> = Array(closes.length).fill(null);
  if (period < 1 || closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Classify H4 bias from completed H4 candles only (caller must not pass forming bar).
 * Slope = EMA21[end] - EMA21[end - slopeLookback].
 */
export function classifyH4TrendBias(
  h4Candles: ReadonlyArray<Candle>,
  opts?: { slopeLookback?: number }
): H4TrendBiasSnapshot {
  const slopeLookback = opts?.slopeLookback ?? 3;
  const reasons: string[] = [];
  if (h4Candles.length < 55) {
    return {
      bias: "NEUTRAL",
      ema21: null,
      ema50: null,
      ema21Slope: null,
      close: null,
      reasons: ["INSUFFICIENT_H4_HISTORY"]
    };
  }
  const closes = h4Candles.map((c) => c.close);
  const ema21s = emaSeries(closes, 21);
  const ema50s = emaSeries(closes, 50);
  const end = h4Candles.length - 1;
  const ema21 = ema21s[end];
  const ema50 = ema50s[end];
  const close = closes[end]!;
  const slopeIdx = end - slopeLookback;
  const ema21Prev = slopeIdx >= 0 ? ema21s[slopeIdx] : null;
  const ema21Slope =
    ema21 != null && ema21Prev != null ? ema21 - ema21Prev : null;

  if (ema21 == null || ema50 == null || ema21Slope == null) {
    return {
      bias: "NEUTRAL",
      ema21: ema21 ?? null,
      ema50: ema50 ?? null,
      ema21Slope,
      close,
      reasons: ["EMA_WARMUP"]
    };
  }

  if (ema21 > ema50 && ema21Slope > 0 && close > ema50) {
    reasons.push("EMA21_ABOVE_EMA50", "EMA21_SLOPE_UP", "CLOSE_ABOVE_EMA50");
    return { bias: "BULLISH", ema21, ema50, ema21Slope, close, reasons };
  }
  if (ema21 < ema50 && ema21Slope < 0 && close < ema50) {
    reasons.push("EMA21_BELOW_EMA50", "EMA21_SLOPE_DOWN", "CLOSE_BELOW_EMA50");
    return { bias: "BEARISH", ema21, ema50, ema21Slope, close, reasons };
  }
  reasons.push("H4_CONDITIONS_NOT_ALIGNED");
  return { bias: "NEUTRAL", ema21, ema50, ema21Slope, close, reasons };
}

/** Source bar duration for session-aware HTF aggregation (1m research or native 15m live). */
export function sourceBarDurationMs(candle: Candle): number {
  const iv = String(candle.interval);
  if (iv === "15m") return 900_000;
  if (iv === "5m") return 300_000;
  return 60_000;
}

/**
 * Session-aware completed HTF bars (research + live).
 * Unlike contiguous MTF resample, allows missing source bars inside a closed wall-clock
 * bucket (gold session gaps). Requires minFillRatio of expected source bars and
 * bucket closeTime <= as-of closeTime.
 *
 * Documented alignment: only buckets whose closeTime has fully elapsed at the
 * as-of bar close are included — no lookahead into the forming HTF bar.
 * Source may be 1m (research) or native 15m (live engine).
 */
export function completedSessionAwareHtfBarsAsOf(
  sourceCandles: ReadonlyArray<Candle>,
  asOfIndex: number,
  targetInterval: "4h" | "15m",
  opts?: { minFillRatio?: number }
): Candle[] {
  if (asOfIndex < 0 || asOfIndex >= sourceCandles.length) return [];
  const minFillRatio = opts?.minFillRatio ?? (targetInterval === "4h" ? 0.25 : 0.8);
  const asOf = sourceCandles[asOfIndex]!;
  const asOfClose = asOf.closeTime;
  const targetMs = researchIntervalMs(targetInterval);
  const sourceMs = sourceBarDurationMs(asOf);
  const expected = Math.max(1, Math.round(targetMs / sourceMs));
  const minBars = Math.max(1, Math.floor(expected * minFillRatio));

  const buckets = new Map<number, Candle[]>();
  for (let i = 0; i <= asOfIndex; i++) {
    const c = sourceCandles[i]!;
    if (!c.isComplete) continue;
    const open = researchCandleOpenTime(c.openTime, targetInterval);
    const list = buckets.get(open) ?? [];
    list.push(c);
    buckets.set(open, list);
  }

  const out: Candle[] = [];
  const opens = [...buckets.keys()].sort((a, b) => a - b);
  for (const open of opens) {
    const closeTime = open + targetMs;
    if (closeTime > asOfClose) continue;
    const group = buckets.get(open)!;
    if (group.length < minBars) continue;
    group.sort((a, b) => a.openTime - b.openTime);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    let high = first.high;
    let low = first.low;
    let ticks = 0;
    for (const g of group) {
      high = Math.max(high, g.high);
      low = Math.min(low, g.low);
      ticks += g.tickCount;
    }
    out.push(
      toBacktestCandle({
        symbol: first.symbol,
        interval: targetInterval,
        openTime: open,
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
  return out;
}

/** ATR percentile of the last bar vs prior lookback window (no future bars). */
export function atrPercentileAtEnd(
  atrSeries: ReadonlyArray<number | null>,
  lookback: number
): number | null {
  const end = atrSeries.length - 1;
  const cur = atrSeries[end];
  if (cur == null || !Number.isFinite(cur) || lookback < 5) return null;
  const start = Math.max(0, end - lookback + 1);
  const window: number[] = [];
  for (let i = start; i <= end; i++) {
    const v = atrSeries[i];
    if (v != null && Number.isFinite(v)) window.push(v);
  }
  if (window.length < 5) return null;
  const below = window.filter((v) => v <= cur).length;
  return below / window.length;
}

export function isWithinUtcSessionHours(
  epochMs: number,
  sessionStartHourUtc: number,
  sessionEndHourUtc: number
): boolean {
  const hour = new Date(epochMs).getUTCHours() + new Date(epochMs).getUTCMinutes() / 60;
  if (sessionStartHourUtc === sessionEndHourUtc) return true;
  if (sessionStartHourUtc < sessionEndHourUtc) {
    return hour >= sessionStartHourUtc && hour < sessionEndHourUtc;
  }
  // wraps midnight
  return hour >= sessionStartHourUtc || hour < sessionEndHourUtc;
}
