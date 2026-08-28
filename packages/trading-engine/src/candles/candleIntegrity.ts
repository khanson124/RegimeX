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
