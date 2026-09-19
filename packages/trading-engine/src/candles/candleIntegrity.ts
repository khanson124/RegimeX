import { type Candle } from "@regimex/shared";

/** Maximum relative close-to-close jump allowed between consecutive session candles. */
export const DEFAULT_MAX_CANDLE_CLOSE_JUMP_RATIO = 0.5;

export type CandleOhlcValidationCode =
  | "OK"
  | "NON_FINITE"
  | "NON_POSITIVE"
  | "HIGH_LOW_INVERTED"
  | "OPEN_OUTSIDE_RANGE"
  | "CLOSE_OUTSIDE_RANGE";

export interface CandleOhlcValidation {
  valid: boolean;
  code: CandleOhlcValidationCode;
}

export type CandleContinuityValidationCode = "OK" | "NON_FINITE_CLOSE" | "CLOSE_JUMP";

export interface CandleContinuityValidation {
  valid: boolean;
  code: CandleContinuityValidationCode;
  ratio: number | null;
}

export interface CandlePricePrecision {
  /** Decimal places (e.g. R_10 = 3, XAUUSD = 2). */
  digits?: number | null;
  /** Minimum price increment; defaults to 10^-digits when omitted. */
  tickSize?: number | null;
}

export function resolveTickSize(precision?: CandlePricePrecision | null): number | null {
  if (precision?.tickSize != null && Number.isFinite(precision.tickSize) && precision.tickSize > 0) {
    return precision.tickSize;
  }
  if (precision?.digits != null && Number.isFinite(precision.digits) && precision.digits >= 0) {
    return 10 ** -Math.floor(precision.digits);
  }
  return null;
}

export function roundToPricePrecision(value: number, digits: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(digits) || digits < 0) return value;
  const factor = 10 ** Math.floor(digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Round OHLC to symbol precision and expand high/low by at most one tick when
 * floating-point / Decimal conversion left the body slightly outside the range.
 * Does not invent prices beyond a 1-tick repair — larger violations stay invalid.
 */
export function normalizeCandleOhlc(
  candle: Pick<Candle, "open" | "high" | "low" | "close">,
  precision?: CandlePricePrecision | null
): {
  open: number;
  high: number;
  low: number;
  close: number;
  repaired: boolean;
} {
  const digits =
    precision?.digits != null && Number.isFinite(precision.digits) && precision.digits >= 0
      ? Math.floor(precision.digits)
      : null;
  const tick = resolveTickSize(precision);

  let open = digits != null ? roundToPricePrecision(candle.open, digits) : candle.open;
  let high = digits != null ? roundToPricePrecision(candle.high, digits) : candle.high;
  let low = digits != null ? roundToPricePrecision(candle.low, digits) : candle.low;
  let close = digits != null ? roundToPricePrecision(candle.close, digits) : candle.close;
  let repaired =
    open !== candle.open || high !== candle.high || low !== candle.low || close !== candle.close;

  if (tick != null && tick > 0) {
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const eps = tick * 1e-6;
    if (high < bodyHigh && bodyHigh - high <= tick + eps) {
      high = bodyHigh;
      repaired = true;
    }
    if (low > bodyLow && low - bodyLow <= tick + eps) {
      low = bodyLow;
      repaired = true;
    }
    if (high < low && low - high <= tick + eps) {
      high = Math.max(high, low, bodyHigh);
      low = Math.min(high, low, bodyLow);
      repaired = true;
    }
  }

  return { open, high, low, close, repaired };
}

export function validateCandleOhlc(
  candle: Pick<Candle, "open" | "high" | "low" | "close">
): CandleOhlcValidation {
  const { open, high, low, close } = candle;
  if (![open, high, low, close].every((v) => Number.isFinite(v))) {
    return { valid: false, code: "NON_FINITE" };
  }
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    return { valid: false, code: "NON_POSITIVE" };
  }
  if (high < low) {
    return { valid: false, code: "HIGH_LOW_INVERTED" };
  }
  const bodyLow = Math.min(open, close);
  const bodyHigh = Math.max(open, close);
  if (low > bodyLow) {
    return { valid: false, code: "OPEN_OUTSIDE_RANGE" };
  }
  if (high < bodyHigh) {
    return { valid: false, code: "CLOSE_OUTSIDE_RANGE" };
  }
  return { valid: true, code: "OK" };
}

export function validateCloseDiscontinuity(
  previousClose: number,
  nextClose: number,
  maxCloseJumpRatio: number = DEFAULT_MAX_CANDLE_CLOSE_JUMP_RATIO
): CandleContinuityValidation {
  if (!Number.isFinite(previousClose) || !Number.isFinite(nextClose) || previousClose <= 0 || nextClose <= 0) {
    return { valid: false, code: "NON_FINITE_CLOSE", ratio: null };
  }
  const ratio = Math.abs(nextClose - previousClose) / previousClose;
  if (ratio > maxCloseJumpRatio) {
    return { valid: false, code: "CLOSE_JUMP", ratio };
  }
  return { valid: true, code: "OK", ratio };
}

export function validateCandleSeriesContinuity(
  candles: ReadonlyArray<Pick<Candle, "close">>,
  maxCloseJumpRatio: number = DEFAULT_MAX_CANDLE_CLOSE_JUMP_RATIO
): { valid: boolean; index: number | null; code: CandleContinuityValidationCode | null; ratio: number | null } {
  for (let i = 1; i < candles.length; i++) {
    const check = validateCloseDiscontinuity(candles[i - 1]!.close, candles[i]!.close, maxCloseJumpRatio);
    if (!check.valid) {
      return { valid: false, index: i, code: check.code, ratio: check.ratio };
    }
  }
  return { valid: true, index: null, code: null, ratio: null };
}
