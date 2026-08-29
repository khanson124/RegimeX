/**
 * MT5 broker stop/freeze-level validation for market orders with SL/TP.
 *
 * MT5 validates Buy stops relative to Bid and Sell stops relative to Ask.
 * minimumStopDistance = stopsLevel * point.
 *
 * When stopsLevel === 0, the broker allows any distance on the correct side of
 * the market (still require strict directional validity after tick normalization).
 * When stopsLevel/point/tickSize are missing (null/undefined/non-finite), fail closed.
 */

export const MT5_INVALID_STOP_DISTANCE_PRECHECK = "MT5_INVALID_STOP_DISTANCE_PRECHECK";
export const MT5_STOP_METADATA_UNAVAILABLE = "MT5_STOP_METADATA_UNAVAILABLE";
export const MT5_PRICE_IN_FREEZE_LEVEL = "MT5_PRICE_IN_FREEZE_LEVEL";

export interface Mt5StopLevelValidationInput {
  direction: "BUY" | "SELL";
  stopLoss: number;
  takeProfit: number;
  bid: number;
  ask: number;
  point: number | null | undefined;
  tickSize: number | null | undefined;
  digits: number | null | undefined;
  /** SYMBOL_TRADE_STOPS_LEVEL in points; null/undefined = unavailable. */
  stopsLevel: number | null | undefined;
  /** SYMBOL_TRADE_FREEZE_LEVEL in points (diagnostics / modify path). */
  freezeLevel?: number | null | undefined;
}

export interface Mt5StopLevelValidationResult {
  ok: boolean;
  reasonCode: string | null;
  reasons: string[];
  point: number | null;
  tickSize: number | null;
  digits: number | null;
  stopsLevel: number | null;
  freezeLevel: number | null;
  minimumStopDistance: number | null;
  bid: number;
  ask: number;
  referencePrice: number | null;
  requestedStopLoss: number;
  requestedTakeProfit: number;
  normalizedStopLoss: number | null;
  normalizedTakeProfit: number | null;
  stopDistanceFromMarket: number | null;
  targetDistanceFromMarket: number | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Round price to tickSize in the protective direction (never toward the market). */
export function normalizeStopPriceToTick(input: {
  price: number;
  tickSize: number;
  digits: number;
  direction: "BUY" | "SELL";
  kind: "stopLoss" | "takeProfit";
}): number {
  const { price, tickSize, digits, direction, kind } = input;
  if (!(tickSize > 0)) return Number(price.toFixed(Math.max(0, digits)));
  const units = price / tickSize;
  let rounded: number;
  if (direction === "BUY") {
    // BUY SL below market → floor; BUY TP above market → ceil
    rounded = kind === "stopLoss" ? Math.floor(units + 1e-12) * tickSize : Math.ceil(units - 1e-12) * tickSize;
  } else {
    // SELL SL above market → ceil; SELL TP below market → floor
    rounded = kind === "stopLoss" ? Math.ceil(units - 1e-12) * tickSize : Math.floor(units + 1e-12) * tickSize;
  }
  return Number(rounded.toFixed(Math.max(0, digits)));
}

export function resolveMinimumStopDistance(stopsLevel: number, point: number): number {
  if (!(point > 0) || !(stopsLevel >= 0)) return Number.NaN;
  return stopsLevel * point;
}

/**
 * Validate and tick-normalize SL/TP against the live Bid/Ask and broker stopsLevel.
 * Does not widen stops beyond tick-protective rounding — if still too close, fail closed.
 */
export function validateAndNormalizeMt5Stops(
  input: Mt5StopLevelValidationInput
): Mt5StopLevelValidationResult {
  const base: Mt5StopLevelValidationResult = {
    ok: false,
    reasonCode: null,
    reasons: [],
    point: isFiniteNumber(input.point) ? input.point : null,
    tickSize: isFiniteNumber(input.tickSize) ? input.tickSize : null,
    digits: isFiniteNumber(input.digits) ? input.digits : null,
    stopsLevel: isFiniteNumber(input.stopsLevel) ? input.stopsLevel : null,
    freezeLevel: isFiniteNumber(input.freezeLevel) ? input.freezeLevel : null,
    minimumStopDistance: null,
    bid: input.bid,
    ask: input.ask,
    referencePrice: null,
    requestedStopLoss: input.stopLoss,
    requestedTakeProfit: input.takeProfit,
    normalizedStopLoss: null,
    normalizedTakeProfit: null,
    stopDistanceFromMarket: null,
    targetDistanceFromMarket: null
  };

  if (
    !isFiniteNumber(input.bid) ||
    !isFiniteNumber(input.ask) ||
    input.bid <= 0 ||
    input.ask <= 0 ||
    input.ask < input.bid
  ) {
    return {
      ...base,
      reasonCode: MT5_STOP_METADATA_UNAVAILABLE,
      reasons: ["Live Bid/Ask unavailable or invalid for stop-distance precheck"]
    };
  }

  if (
    base.point == null ||
    !(base.point > 0) ||
    base.tickSize == null ||
    !(base.tickSize > 0) ||
    base.digits == null ||
    base.digits < 0 ||
    base.stopsLevel == null ||
    !(base.stopsLevel >= 0)
  ) {
    return {
      ...base,
      reasonCode: MT5_STOP_METADATA_UNAVAILABLE,
      reasons: [
        "MT5 stop metadata unavailable (need finite point, tickSize, digits, and stopsLevel ≥ 0)"
      ]
    };
  }

  if (!isFiniteNumber(input.stopLoss) || !isFiniteNumber(input.takeProfit)) {
    return {
      ...base,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Stop-loss and take-profit must be finite numbers"]
    };
  }

  const minimumStopDistance = resolveMinimumStopDistance(base.stopsLevel, base.point);
  base.minimumStopDistance = minimumStopDistance;

  const referencePrice = input.direction === "BUY" ? input.bid : input.ask;
  base.referencePrice = referencePrice;

  const normalizedStopLoss = normalizeStopPriceToTick({
    price: input.stopLoss,
    tickSize: base.tickSize,
    digits: base.digits,
    direction: input.direction,
    kind: "stopLoss"
  });
  const normalizedTakeProfit = normalizeStopPriceToTick({
    price: input.takeProfit,
    tickSize: base.tickSize,
    digits: base.digits,
    direction: input.direction,
    kind: "takeProfit"
  });
  base.normalizedStopLoss = normalizedStopLoss;
  base.normalizedTakeProfit = normalizedTakeProfit;

  const eps = Math.max(base.point * 0.1, base.tickSize * 0.1, 1e-12);
  let stopDistanceFromMarket: number;
  let targetDistanceFromMarket: number;

  if (input.direction === "BUY") {
    stopDistanceFromMarket = referencePrice - normalizedStopLoss;
    targetDistanceFromMarket = normalizedTakeProfit - referencePrice;
    if (!(stopDistanceFromMarket > eps)) {
      base.reasonCode = MT5_INVALID_STOP_DISTANCE_PRECHECK;
      base.reasons.push(
        `BUY SL ${normalizedStopLoss} must be below Bid ${referencePrice} (distance=${stopDistanceFromMarket})`
      );
    }
    if (!(targetDistanceFromMarket > eps)) {
      base.reasonCode = MT5_INVALID_STOP_DISTANCE_PRECHECK;
      base.reasons.push(
        `BUY TP ${normalizedTakeProfit} must be above Bid ${referencePrice} (distance=${targetDistanceFromMarket})`
      );
    }
  } else {
    stopDistanceFromMarket = normalizedStopLoss - referencePrice;
    targetDistanceFromMarket = referencePrice - normalizedTakeProfit;
    if (!(stopDistanceFromMarket > eps)) {
      base.reasonCode = MT5_INVALID_STOP_DISTANCE_PRECHECK;
      base.reasons.push(
        `SELL SL ${normalizedStopLoss} must be above Ask ${referencePrice} (distance=${stopDistanceFromMarket})`
      );
    }
    if (!(targetDistanceFromMarket > eps)) {
      base.reasonCode = MT5_INVALID_STOP_DISTANCE_PRECHECK;
      base.reasons.push(
        `SELL TP ${normalizedTakeProfit} must be below Ask ${referencePrice} (distance=${targetDistanceFromMarket})`
      );
    }
  }

  base.stopDistanceFromMarket = stopDistanceFromMarket;
  base.targetDistanceFromMarket = targetDistanceFromMarket;

  if (minimumStopDistance > 0) {
    if (stopDistanceFromMarket + eps < minimumStopDistance) {
      base.reasonCode = MT5_INVALID_STOP_DISTANCE_PRECHECK;
      base.reasons.push(
        `SL distance ${stopDistanceFromMarket} < minimumStopDistance ${minimumStopDistance} (stopsLevel=${base.stopsLevel}×point=${base.point})`
      );
    }
    if (targetDistanceFromMarket + eps < minimumStopDistance) {
      base.reasonCode = MT5_INVALID_STOP_DISTANCE_PRECHECK;
      base.reasons.push(
        `TP distance ${targetDistanceFromMarket} < minimumStopDistance ${minimumStopDistance} (stopsLevel=${base.stopsLevel}×point=${base.point})`
      );
    }
  }

  if (base.reasons.length > 0) {
    return base;
  }

  return {
    ...base,
    ok: true,
    reasonCode: null,
    reasons: []
  };
}

/** True when market price is within freezeLevel×point of current SL or TP. */
export function isPriceInFreezeLevel(input: {
  marketPrice: number;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
  freezeLevel: number | null | undefined;
  point: number | null | undefined;
}): boolean {
  if (
    !isFiniteNumber(input.freezeLevel) ||
    input.freezeLevel <= 0 ||
    !isFiniteNumber(input.point) ||
    !(input.point > 0) ||
    !isFiniteNumber(input.marketPrice)
  ) {
    return false;
  }
  const freezeDist = input.freezeLevel * input.point;
  if (isFiniteNumber(input.stopLoss) && input.stopLoss > 0) {
    if (Math.abs(input.marketPrice - input.stopLoss) <= freezeDist) return true;
  }
  if (isFiniteNumber(input.takeProfit) && input.takeProfit > 0) {
    if (Math.abs(input.marketPrice - input.takeProfit) <= freezeDist) return true;
  }
  return false;
}
