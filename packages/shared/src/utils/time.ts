import { CANDLE_INTERVAL_SECONDS, type CandleInterval } from "../types/candle.js";

/** Floor an epoch-ms timestamp to the open time of its candle bucket. */
export function candleOpenTime(epochMs: number, interval: CandleInterval): number {
  const ms = CANDLE_INTERVAL_SECONDS[interval] * 1000;
  return Math.floor(epochMs / ms) * ms;
}

/** Close time = open time + interval (exclusive upper bound). */
export function candleCloseTime(openTime: number, interval: CandleInterval): number {
  return openTime + CANDLE_INTERVAL_SECONDS[interval] * 1000;
}

export function intervalMs(interval: CandleInterval): number {
  return CANDLE_INTERVAL_SECONDS[interval] * 1000;
}

/** Start of the UTC day containing the given time. */
export function utcDayStart(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
