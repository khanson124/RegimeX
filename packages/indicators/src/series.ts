import { type NullableSeries, type Series } from "./types.js";

function nulls(n: number): NullableSeries {
  return new Array<number | null>(n).fill(null);
}

/** Simple moving average. */
export function sma(values: Series, period: number): NullableSeries {
  if (period < 1) throw new Error("SMA period must be >= 1");
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with SMA of the first `period` values. */
export function ema(values: Series, period: number): NullableSeries {
  if (period < 1) throw new Error("EMA period must be >= 1");
  const out = nulls(values.length);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (prev === null) {
      seedSum += v;
      if (i === period - 1) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: Series, period = 14): NullableSeries {
  if (period < 1) throw new Error("RSI period must be >= 1");
  const out = nulls(values.length);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/** Rolling (population) standard deviation. */
export function rollingStdDev(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j]! - mean) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

export interface BollingerPoint {
  upper: number;
  middle: number;
  lower: number;
  /** (upper - lower) / middle — a relative width. */
  width: number;
}

export function bollingerBands(
  values: Series,
  period = 20,
  stdDevMultiplier = 2
): Array<BollingerPoint | null> {
  const middle = sma(values, period);
  const sd = rollingStdDev(values, period);
  return values.map((_, i) => {
    const m = middle[i];
    const s = sd[i];
    if (m === null || m === undefined || s === null || s === undefined || m === 0) return null;
    const upper = m + stdDevMultiplier * s;
    const lower = m - stdDevMultiplier * s;
    return { upper, middle: m, lower, width: (upper - lower) / m };
  });
}

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  values: Series,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): Array<MacdPoint | null> {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine: NullableSeries = values.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
  });

  // Signal EMA computed over the non-null macd values only.
  const firstIdx = macdLine.findIndex((v) => v !== null);
  const out: Array<MacdPoint | null> = new Array(values.length).fill(null);
  if (firstIdx === -1) return out;
  const compact = macdLine.slice(firstIdx) as number[];
  const signal = ema(compact, signalPeriod);
  for (let i = 0; i < compact.length; i++) {
    const s = signal[i];
    if (s === null || s === undefined) continue;
    const m = compact[i]!;
    out[firstIdx + i] = { macd: m, signal: s, histogram: m - s };
  }
  return out;
}

/** Rate of change over `period` bars, as a fraction (0.01 = +1%). */
export function rateOfChange(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period]!;
    if (past !== 0) out[i] = (values[i]! - past) / past;
  }
  return out;
}

/** Highest value of the previous `period` bars (excluding the current bar). */
export function highestHigh(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - period; j < i; j++) max = Math.max(max, values[j]!);
    out[i] = max;
  }
  return out;
}

/** Lowest value of the previous `period` bars (excluding the current bar). */
export function lowestLow(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - period; j < i; j++) min = Math.min(min, values[j]!);
    out[i] = min;
  }
  return out;
}

export interface DonchianPoint {
  upper: number;
  lower: number;
  middle: number;
}

/**
 * Donchian channel over the previous `period` bars (excluding current bar),
 * so a close above `upper` is a genuine breakout of prior range.
 */
export function donchianChannel(
  highs: Series,
  lows: Series,
  period: number
): Array<DonchianPoint | null> {
  const hh = highestHigh(highs, period);
  const ll = lowestLow(lows, period);
  return highs.map((_, i) => {
    const u = hh[i];
    const l = ll[i];
    if (u === null || u === undefined || l === null || l === undefined) return null;
    return { upper: u, lower: l, middle: (u + l) / 2 };
  });
}

/**
 * Linear-regression slope of the last `period` values, normalized by the
 * mean value so it is comparable across price levels (slope per bar as a
 * fraction of price).
 */
export function trendSlope(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let j = 0; j < period; j++) {
      const y = values[i - period + 1 + j]!;
      sumX += j;
      sumY += y;
      sumXY += j * y;
      sumXX += j * j;
    }
    const n = period;
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) continue;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const mean = sumY / n;
    out[i] = mean !== 0 ? slope / mean : null;
  }
  return out;
}

/** Return over the last `period` bars as a fraction. Alias of rateOfChange. */
export function recentReturn(values: Series, period: number): NullableSeries {
  return rateOfChange(values, period);
}

/**
 * Count of consecutive bars (ending at i) where each value made a higher high
 * than the previous bar. 0 when the latest bar did not.
 */
export function consecutiveHigherHighs(values: Series): number[] {
  const out = new Array<number>(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i]! > values[i - 1]! ? out[i - 1]! + 1 : 0;
  }
  return out;
}

export function consecutiveLowerLows(values: Series): number[] {
  const out = new Array<number>(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i]! < values[i - 1]! ? out[i - 1]! + 1 : 0;
  }
  return out;
}

/**
 * Percentile rank (0-100) of the latest value within its trailing window of
 * `period` values (inclusive).
 */
export function percentileRank(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const current = values[i]!;
    let below = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j]! < current) below++;
    }
    out[i] = (below / (period - 1 || 1)) * 100;
  }
  return out;
}

/** Rolling median over `period` values. */
export function rollingMedian(values: Series, period: number): NullableSeries {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1).slice().sort((a, b) => a - b);
    const mid = Math.floor(window.length / 2);
    out[i] =
      window.length % 2 === 0 ? (window[mid - 1]! + window[mid]!) / 2 : window[mid]!;
  }
  return out;
}
