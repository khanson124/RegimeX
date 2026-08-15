import { type NullableSeries, type OhlcCandle } from "./types.js";
import { ema } from "./series.js";

function nulls(n: number): NullableSeries {
  return new Array<number | null>(n).fill(null);
}

/** True range series. Index 0 uses high-low only. */
export function trueRange(candles: ReadonlyArray<OhlcCandle>): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Wilder-smoothed ATR. */
export function atr(candles: ReadonlyArray<OhlcCandle>, period = 14): NullableSeries {
  const tr = trueRange(candles);
  const out = nulls(candles.length);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < tr.length; i++) {
    if (prev === null) {
      seed += tr[i]!;
      if (i === period - 1) {
        prev = seed / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr[i]!) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** ATR as a percentage of close (fraction, 0.01 = 1%). */
export function atrPercent(candles: ReadonlyArray<OhlcCandle>, period = 14): NullableSeries {
  const a = atr(candles, period);
  return candles.map((c, i) => {
    const v = a[i];
    return v !== null && v !== undefined && c.close !== 0 ? v / c.close : null;
  });
}

/** Wilder's ADX (average directional index), 0-100. */
export function adx(candles: ReadonlyArray<OhlcCandle>, period = 14): NullableSeries {
  const n = candles.length;
  const out = nulls(n);
  if (n < period * 2) {
    // Not enough data for a single smoothed ADX value anywhere; still run
    // the loop so partial DX smoothing stays consistent for longer inputs.
  }
  const tr = trueRange(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  const dx: NullableSeries = nulls(n);
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      smTr += tr[i]!;
      smPlus += plusDM[i]!;
      smMinus += minusDM[i]!;
      if (i < period) continue;
    } else {
      smTr = smTr - smTr / period + tr[i]!;
      smPlus = smPlus - smPlus / period + plusDM[i]!;
      smMinus = smMinus - smMinus / period + minusDM[i]!;
    }
    if (smTr === 0) continue;
    const pdi = (100 * smPlus) / smTr;
    const mdi = (100 * smMinus) / smTr;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }

  // ADX = Wilder-smoothed DX
  let adxPrev: number | null = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < n; i++) {
    const d = dx[i];
    if (d === null || d === undefined) continue;
    if (adxPrev === null) {
      seedSum += d;
      seedCount++;
      if (seedCount === period) {
        adxPrev = seedSum / period;
        out[i] = adxPrev;
      }
    } else {
      adxPrev = (adxPrev * (period - 1) + d) / period;
      out[i] = adxPrev;
    }
  }
  return out;
}

/** Absolute body size |close - open|. */
export function candleBodySize(candles: ReadonlyArray<OhlcCandle>): number[] {
  return candles.map((c) => Math.abs(c.close - c.open));
}

/** Upper wick: high minus the top of the body. */
export function upperWickSize(candles: ReadonlyArray<OhlcCandle>): number[] {
  return candles.map((c) => c.high - Math.max(c.open, c.close));
}

/** Lower wick: bottom of the body minus low. */
export function lowerWickSize(candles: ReadonlyArray<OhlcCandle>): number[] {
  return candles.map((c) => Math.min(c.open, c.close) - c.low);
}

/** Full candle range high-low. */
export function candleRange(candles: ReadonlyArray<OhlcCandle>): number[] {
  return candles.map((c) => c.high - c.low);
}

/**
 * Distance of close from an EMA of closes, as a fraction of the EMA
 * (positive = above).
 */
export function distanceFromEma(
  candles: ReadonlyArray<OhlcCandle>,
  period: number
): NullableSeries {
  const closes = candles.map((c) => c.close);
  const e = ema(closes, period);
  return candles.map((c, i) => {
    const v = e[i];
    return v !== null && v !== undefined && v !== 0 ? (c.close - v) / v : null;
  });
}
