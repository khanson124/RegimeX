import { candleOpenTime, intervalMs, type Candle, type CandleInterval } from "@regimex/shared";

export type CandleValidationFailure =
  | "NON_FINITE"
  | "NON_POSITIVE_PRICE"
  | "HIGH_LOW_INCONSISTENT"
  | "OPEN_OUTSIDE_RANGE"
  | "CLOSE_OUTSIDE_RANGE"
  | "TIMESTAMP_MISALIGNED"
  | "WRONG_SYMBOL"
  | "WRONG_INTERVAL"
  | "INCOMPLETE_FLAG";

export interface CandleValidationResult {
  ok: boolean;
  failures: CandleValidationFailure[];
}

/**
 * Strict research validation. Does not auto-correct OHLC.
 */
export function validateHistoricalCandle(
  candle: Candle,
  expected: { symbol: string; interval: CandleInterval }
): CandleValidationResult {
  const failures: CandleValidationFailure[] = [];
  const { open, high, low, close, openTime } = candle;

  if (![open, high, low, close, openTime].every((x) => Number.isFinite(x))) {
    failures.push("NON_FINITE");
  }
  if (!(open > 0 && high > 0 && low > 0 && close > 0)) {
    failures.push("NON_POSITIVE_PRICE");
  }
  if (high < low) failures.push("HIGH_LOW_INCONSISTENT");
  if (open > high || open < low) failures.push("OPEN_OUTSIDE_RANGE");
  if (close > high || close < low) failures.push("CLOSE_OUTSIDE_RANGE");

  if (candle.symbol !== expected.symbol) failures.push("WRONG_SYMBOL");
  if (candle.interval !== expected.interval) failures.push("WRONG_INTERVAL");
  if (!candle.isComplete) failures.push("INCOMPLETE_FLAG");

  const aligned = candleOpenTime(openTime, expected.interval);
  if (aligned !== openTime) failures.push("TIMESTAMP_MISALIGNED");

  // closeTime should match interval length when provided
  const expectedClose = openTime + intervalMs(expected.interval);
  if (Number.isFinite(candle.closeTime) && candle.closeTime !== expectedClose) {
    // treat as soft alignment failure for research history
    failures.push("TIMESTAMP_MISALIGNED");
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

export function ohlcConflict(
  existing: { open: number; high: number; low: number; close: number },
  incoming: { open: number; high: number; low: number; close: number },
  epsilon = 1e-8
): boolean {
  return (
    Math.abs(existing.open - incoming.open) > epsilon ||
    Math.abs(existing.high - incoming.high) > epsilon ||
    Math.abs(existing.low - incoming.low) > epsilon ||
    Math.abs(existing.close - incoming.close) > epsilon
  );
}
