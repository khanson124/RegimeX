/**
 * Broker-stop adaptation for MT5 autonomous execution.
 *
 * Strategy proposals stay broker-independent. This layer widens SL only as far
 * as needed for stopsLevel×point (+ a small safety buffer), recomputes TP at the
 * strategy R-multiple, and never moves a protective stop toward the market.
 */

import {
  MT5_INVALID_STOP_DISTANCE_PRECHECK,
  MT5_STOP_METADATA_UNAVAILABLE,
  normalizeStopPriceToTick,
  resolveMinimumStopDistance,
  validateAndNormalizeMt5Stops,
  type Mt5StopLevelValidationResult
} from "./mt5StopLevels.js";

/** Extra ticks beyond exact broker minimum when widening (floating-point / one-tick safety). */
export const MT5_BROKER_STOP_SAFETY_TICKS = 1;

export const MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED = "MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED";

export interface AdaptMt5BrokerStopsInput {
  direction: "BUY" | "SELL";
  stopLoss: number;
  takeProfit: number;
  /**
   * Expected fill / entry used for stopDistance and R:R TP recompute
   * (typically live Ask for BUY, Bid for SELL).
   */
  entryPrice: number;
  /** Strategy initialRiskReward / targetRMultiple (e.g. 2). */
  targetRMultiple: number;
  bid: number;
  ask: number;
  point: number | null | undefined;
  tickSize: number | null | undefined;
  digits: number | null | undefined;
  stopsLevel: number | null | undefined;
  freezeLevel?: number | null | undefined;
  /** Override safety ticks (default MT5_BROKER_STOP_SAFETY_TICKS). */
  safetyTicks?: number;
}

export interface AdaptMt5BrokerStopsResult {
  ok: boolean;
  reasonCode: string | null;
  reasons: string[];
  brokerAdjusted: boolean;
  originalStopLoss: number;
  originalTakeProfit: number;
  originalStopDistance: number;
  adjustedStopLoss: number | null;
  adjustedTakeProfit: number | null;
  adjustedStopDistance: number | null;
  targetRMultiple: number;
  safetyBuffer: number | null;
  minimumStopDistance: number | null;
  point: number | null;
  tickSize: number | null;
  digits: number | null;
  stopsLevel: number | null;
  freezeLevel: number | null;
  bid: number;
  ask: number;
  referencePrice: number | null;
  validation: Mt5StopLevelValidationResult | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function ensureSellSlDistance(sl: number, ask: number, minDist: number, tickSize: number, digits: number): number {
  let out = sl;
  const eps = Math.max(tickSize * 0.1, 1e-12);
  while (out - ask + eps < minDist) {
    out = normalizeStopPriceToTick({
      price: out + tickSize,
      tickSize,
      digits,
      direction: "SELL",
      kind: "stopLoss"
    });
    if (!(out > sl)) break;
  }
  return out;
}

function ensureBuySlDistance(sl: number, bid: number, minDist: number, tickSize: number, digits: number): number {
  let out = sl;
  const eps = Math.max(tickSize * 0.1, 1e-12);
  while (bid - out + eps < minDist) {
    out = normalizeStopPriceToTick({
      price: out - tickSize,
      tickSize,
      digits,
      direction: "BUY",
      kind: "stopLoss"
    });
    if (!(out < sl)) break;
  }
  return out;
}

/**
 * Adapt strategy SL/TP to live MT5 stop levels.
 * - Already broker-valid → tick-normalize only, leave prices otherwise unchanged.
 * - SL too close → widen away from market by minDist + safetyTicks×tickSize, then
 *   recompute TP at targetRMultiple from entryPrice.
 */
export function adaptMt5BrokerStops(input: AdaptMt5BrokerStopsInput): AdaptMt5BrokerStopsResult {
  const targetRMultiple =
    isFiniteNumber(input.targetRMultiple) && input.targetRMultiple > 0 ? input.targetRMultiple : 2;
  const originalStopDistance = Math.abs(input.entryPrice - input.stopLoss);

  const baseMeta: AdaptMt5BrokerStopsResult = {
    ok: false,
    reasonCode: null,
    reasons: [],
    brokerAdjusted: false,
    originalStopLoss: input.stopLoss,
    originalTakeProfit: input.takeProfit,
    originalStopDistance: Number(originalStopDistance.toFixed(8)),
    adjustedStopLoss: null,
    adjustedTakeProfit: null,
    adjustedStopDistance: null,
    targetRMultiple,
    safetyBuffer: null,
    minimumStopDistance: null,
    point: null,
    tickSize: null,
    digits: null,
    stopsLevel: null,
    freezeLevel: isFiniteNumber(input.freezeLevel) ? input.freezeLevel : null,
    bid: input.bid,
    ask: input.ask,
    referencePrice: null,
    validation: null
  };

  const initialValidation = validateAndNormalizeMt5Stops({
    direction: input.direction,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    bid: input.bid,
    ask: input.ask,
    point: input.point,
    tickSize: input.tickSize,
    digits: input.digits,
    stopsLevel: input.stopsLevel,
    freezeLevel: input.freezeLevel
  });
  baseMeta.validation = initialValidation;
  baseMeta.point = initialValidation.point;
  baseMeta.tickSize = initialValidation.tickSize;
  baseMeta.digits = initialValidation.digits;
  baseMeta.stopsLevel = initialValidation.stopsLevel;
  baseMeta.freezeLevel = initialValidation.freezeLevel;
  baseMeta.minimumStopDistance = initialValidation.minimumStopDistance;
  baseMeta.referencePrice = initialValidation.referencePrice;

  if (initialValidation.reasonCode === MT5_STOP_METADATA_UNAVAILABLE) {
    return {
      ...baseMeta,
      reasonCode: MT5_STOP_METADATA_UNAVAILABLE,
      reasons: initialValidation.reasons
    };
  }

  if (
    initialValidation.point == null ||
    initialValidation.tickSize == null ||
    initialValidation.digits == null ||
    initialValidation.stopsLevel == null ||
    initialValidation.minimumStopDistance == null
  ) {
    return {
      ...baseMeta,
      reasonCode: MT5_STOP_METADATA_UNAVAILABLE,
      reasons: ["MT5 stop metadata unavailable for broker adaptation"]
    };
  }

  const point = initialValidation.point;
  const tickSize = initialValidation.tickSize;
  const digits = initialValidation.digits;
  const minimumStopDistance = initialValidation.minimumStopDistance;
  const safetyTicks =
    isFiniteNumber(input.safetyTicks) && input.safetyTicks >= 0
      ? input.safetyTicks
      : MT5_BROKER_STOP_SAFETY_TICKS;
  const safetyBuffer = safetyTicks * tickSize;
  baseMeta.safetyBuffer = safetyBuffer;

  if (initialValidation.ok && initialValidation.normalizedStopLoss != null && initialValidation.normalizedTakeProfit != null) {
    const adjSl = initialValidation.normalizedStopLoss;
    const adjTp = initialValidation.normalizedTakeProfit;
    const adjDist = Math.abs(input.entryPrice - adjSl);
    return {
      ...baseMeta,
      ok: true,
      brokerAdjusted: false,
      adjustedStopLoss: adjSl,
      adjustedTakeProfit: adjTp,
      adjustedStopDistance: Number(adjDist.toFixed(8)),
      validation: initialValidation
    };
  }

  // Need adaptation — widen SL if required, recompute TP at R.
  const referencePrice = input.direction === "BUY" ? input.bid : input.ask;
  const requiredDistance = minimumStopDistance + safetyBuffer;
  const normalizedOriginalSl = normalizeStopPriceToTick({
    price: input.stopLoss,
    tickSize,
    digits,
    direction: input.direction,
    kind: "stopLoss"
  });

  let adjustedSl: number;
  if (input.direction === "BUY") {
    const maxValidRaw = referencePrice - requiredDistance;
    let maxValidSl = normalizeStopPriceToTick({
      price: maxValidRaw,
      tickSize,
      digits,
      direction: "BUY",
      kind: "stopLoss"
    });
    maxValidSl = ensureBuySlDistance(maxValidSl, referencePrice, minimumStopDistance, tickSize, digits);
    // Never move SL toward market (up for BUY).
    adjustedSl = Math.min(normalizedOriginalSl, maxValidSl);
    adjustedSl = ensureBuySlDistance(adjustedSl, referencePrice, minimumStopDistance, tickSize, digits);
  } else {
    const minValidRaw = referencePrice + requiredDistance;
    let minValidSl = normalizeStopPriceToTick({
      price: minValidRaw,
      tickSize,
      digits,
      direction: "SELL",
      kind: "stopLoss"
    });
    minValidSl = ensureSellSlDistance(minValidSl, referencePrice, minimumStopDistance, tickSize, digits);
    // Never move SL toward market (down for SELL).
    adjustedSl = Math.max(normalizedOriginalSl, minValidSl);
    adjustedSl = ensureSellSlDistance(adjustedSl, referencePrice, minimumStopDistance, tickSize, digits);
  }

  const adjustedStopDistance = Math.abs(input.entryPrice - adjustedSl);
  if (!(adjustedStopDistance > 0) || !isFiniteNumber(input.entryPrice)) {
    return {
      ...baseMeta,
      brokerAdjusted: true,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Broker-adapted stop distance is not positive relative to entry"],
      adjustedStopLoss: adjustedSl
    };
  }

  const targetDistance = adjustedStopDistance * targetRMultiple;
  const rawTp =
    input.direction === "BUY"
      ? input.entryPrice + targetDistance
      : input.entryPrice - targetDistance;
  let adjustedTp = normalizeStopPriceToTick({
    price: rawTp,
    tickSize,
    digits,
    direction: input.direction,
    kind: "takeProfit"
  });

  // If TP still inside broker minimum after R recompute, push away (keep ≥ R).
  const eps = Math.max(point * 0.1, tickSize * 0.1, 1e-12);
  if (minimumStopDistance > 0) {
    if (input.direction === "BUY") {
      const minTp = referencePrice + minimumStopDistance;
      if (adjustedTp + eps < minTp) {
        adjustedTp = normalizeStopPriceToTick({
          price: minTp + safetyBuffer,
          tickSize,
          digits,
          direction: "BUY",
          kind: "takeProfit"
        });
      }
    } else {
      const maxTp = referencePrice - minimumStopDistance;
      if (adjustedTp - eps > maxTp) {
        adjustedTp = normalizeStopPriceToTick({
          price: maxTp - safetyBuffer,
          tickSize,
          digits,
          direction: "SELL",
          kind: "takeProfit"
        });
      }
    }
  }

  const finalValidation = validateAndNormalizeMt5Stops({
    direction: input.direction,
    stopLoss: adjustedSl,
    takeProfit: adjustedTp,
    bid: input.bid,
    ask: input.ask,
    point,
    tickSize,
    digits,
    stopsLevel: initialValidation.stopsLevel,
    freezeLevel: input.freezeLevel
  });

  if (!finalValidation.ok || finalValidation.normalizedStopLoss == null || finalValidation.normalizedTakeProfit == null) {
    return {
      ...baseMeta,
      brokerAdjusted: true,
      reasonCode: finalValidation.reasonCode ?? MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: [
        "Broker stop adaptation could not produce valid SL/TP",
        ...finalValidation.reasons
      ],
      adjustedStopLoss: adjustedSl,
      adjustedTakeProfit: adjustedTp,
      adjustedStopDistance: Number(adjustedStopDistance.toFixed(8)),
      validation: finalValidation
    };
  }

  const finalSl = finalValidation.normalizedStopLoss;
  const finalTp = finalValidation.normalizedTakeProfit;
  const finalDist = Math.abs(input.entryPrice - finalSl);

  // Sanity: adaptation must not move protective stop toward the market vs original normalize.
  if (input.direction === "BUY" && finalSl > normalizedOriginalSl + eps) {
    return {
      ...baseMeta,
      brokerAdjusted: true,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Adaptation attempted to move BUY SL toward the market"],
      validation: finalValidation
    };
  }
  if (input.direction === "SELL" && finalSl < normalizedOriginalSl - eps) {
    return {
      ...baseMeta,
      brokerAdjusted: true,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Adaptation attempted to move SELL SL toward the market"],
      validation: finalValidation
    };
  }

  return {
    ...baseMeta,
    ok: true,
    brokerAdjusted: true,
    adjustedStopLoss: finalSl,
    adjustedTakeProfit: finalTp,
    adjustedStopDistance: Number(finalDist.toFixed(8)),
    reasons: [
      `Broker-adjusted SL outward for stopsLevel (minDist=${minimumStopDistance}, safetyBuffer=${safetyBuffer})`,
      `TP recomputed at ${targetRMultiple}R from entry ${input.entryPrice}`
    ],
    validation: finalValidation
  };
}

export interface RecomputeMt5TakeProfitAtTargetRInput {
  direction: "BUY" | "SELL";
  /** Authoritative executable entry (fresh Ask for BUY, Bid for SELL). */
  entryPrice: number;
  stopLoss: number;
  /** Strategy-intended R multiple (e.g. 2 for ema-pullback-v1). */
  intendedTargetRMultiple: number;
  bid: number;
  ask: number;
  point: number | null | undefined;
  tickSize: number | null | undefined;
  digits: number | null | undefined;
  stopsLevel: number | null | undefined;
  freezeLevel?: number | null | undefined;
  safetyTicks?: number;
}

export interface RecomputeMt5TakeProfitAtTargetRResult {
  ok: boolean;
  reasonCode: string | null;
  reasons: string[];
  takeProfit: number | null;
  stopLoss: number | null;
  stopDistance: number | null;
  targetDistance: number | null;
  intendedTargetRMultiple: number;
  actualTargetRMultiple: number | null;
  validation: Mt5StopLevelValidationResult | null;
}

/**
 * Recompute TP from final executable entry + final SL at the intended R multiple.
 * Always used after final SL is known so entry drift cannot leave a stale TP.
 */
export function recomputeMt5TakeProfitAtTargetR(
  input: RecomputeMt5TakeProfitAtTargetRInput
): RecomputeMt5TakeProfitAtTargetRResult {
  const intendedTargetRMultiple =
    isFiniteNumber(input.intendedTargetRMultiple) && input.intendedTargetRMultiple > 0
      ? input.intendedTargetRMultiple
      : 2;
  const empty: RecomputeMt5TakeProfitAtTargetRResult = {
    ok: false,
    reasonCode: null,
    reasons: [],
    takeProfit: null,
    stopLoss: null,
    stopDistance: null,
    targetDistance: null,
    intendedTargetRMultiple,
    actualTargetRMultiple: null,
    validation: null
  };

  if (!isFiniteNumber(input.entryPrice) || !isFiniteNumber(input.stopLoss)) {
    return {
      ...empty,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Final entry and stop-loss must be finite for target-R TP recompute"]
    };
  }

  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  if (!(stopDistance > 0)) {
    return {
      ...empty,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Final stop distance must be positive for target-R TP recompute"]
    };
  }

  const slValidation = validateAndNormalizeMt5Stops({
    direction: input.direction,
    stopLoss: input.stopLoss,
    // Temporary TP far enough that SL-side validation can proceed; replaced below.
    takeProfit:
      input.direction === "BUY"
        ? input.entryPrice + stopDistance * Math.max(intendedTargetRMultiple, 1)
        : input.entryPrice - stopDistance * Math.max(intendedTargetRMultiple, 1),
    bid: input.bid,
    ask: input.ask,
    point: input.point,
    tickSize: input.tickSize,
    digits: input.digits,
    stopsLevel: input.stopsLevel,
    freezeLevel: input.freezeLevel
  });

  if (
    slValidation.reasonCode === MT5_STOP_METADATA_UNAVAILABLE ||
    slValidation.point == null ||
    slValidation.tickSize == null ||
    slValidation.digits == null ||
    slValidation.stopsLevel == null ||
    slValidation.minimumStopDistance == null
  ) {
    return {
      ...empty,
      reasonCode: MT5_STOP_METADATA_UNAVAILABLE,
      reasons: slValidation.reasons.length
        ? slValidation.reasons
        : ["MT5 stop metadata unavailable for target-R TP recompute"],
      validation: slValidation
    };
  }

  const point = slValidation.point;
  const tickSize = slValidation.tickSize;
  const digits = slValidation.digits;
  const minimumStopDistance = slValidation.minimumStopDistance;
  const safetyTicks =
    isFiniteNumber(input.safetyTicks) && input.safetyTicks >= 0
      ? input.safetyTicks
      : MT5_BROKER_STOP_SAFETY_TICKS;
  const safetyBuffer = safetyTicks * tickSize;
  const referencePrice = input.direction === "BUY" ? input.bid : input.ask;
  const normalizedSl =
    slValidation.normalizedStopLoss ??
    normalizeStopPriceToTick({
      price: input.stopLoss,
      tickSize,
      digits,
      direction: input.direction,
      kind: "stopLoss"
    });
  const finalStopDistance = Math.abs(input.entryPrice - normalizedSl);
  if (!(finalStopDistance > 0)) {
    return {
      ...empty,
      reasonCode: MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: ["Normalized final stop distance is not positive"],
      stopLoss: normalizedSl,
      validation: slValidation
    };
  }

  const targetDistance = finalStopDistance * intendedTargetRMultiple;
  const rawTp =
    input.direction === "BUY"
      ? input.entryPrice + targetDistance
      : input.entryPrice - targetDistance;
  let adjustedTp = normalizeStopPriceToTick({
    price: rawTp,
    tickSize,
    digits,
    direction: input.direction,
    kind: "takeProfit"
  });

  // Broker min distance may require pushing TP further away (actual R ≥ intended).
  const eps = Math.max(point * 0.1, tickSize * 0.1, 1e-12);
  if (minimumStopDistance > 0) {
    if (input.direction === "BUY") {
      const minTp = referencePrice + minimumStopDistance;
      if (adjustedTp + eps < minTp) {
        adjustedTp = normalizeStopPriceToTick({
          price: minTp + safetyBuffer,
          tickSize,
          digits,
          direction: "BUY",
          kind: "takeProfit"
        });
      }
    } else {
      const maxTp = referencePrice - minimumStopDistance;
      if (adjustedTp - eps > maxTp) {
        adjustedTp = normalizeStopPriceToTick({
          price: maxTp - safetyBuffer,
          tickSize,
          digits,
          direction: "SELL",
          kind: "takeProfit"
        });
      }
    }
  }

  const validation = validateAndNormalizeMt5Stops({
    direction: input.direction,
    stopLoss: normalizedSl,
    takeProfit: adjustedTp,
    bid: input.bid,
    ask: input.ask,
    point,
    tickSize,
    digits,
    stopsLevel: slValidation.stopsLevel,
    freezeLevel: input.freezeLevel
  });

  if (!validation.ok || validation.normalizedStopLoss == null || validation.normalizedTakeProfit == null) {
    return {
      ...empty,
      reasonCode: validation.reasonCode ?? MT5_INVALID_STOP_DISTANCE_PRECHECK,
      reasons: [
        "Target-R TP recompute could not produce broker-valid SL/TP",
        ...validation.reasons
      ],
      stopLoss: normalizedSl,
      takeProfit: adjustedTp,
      stopDistance: Number(finalStopDistance.toFixed(8)),
      validation
    };
  }

  const finalSl = validation.normalizedStopLoss;
  const finalTp = validation.normalizedTakeProfit;
  const finalRisk = Math.abs(input.entryPrice - finalSl);
  const finalReward = Math.abs(finalTp - input.entryPrice);
  const actualTargetRMultiple =
    finalRisk > 0 ? Number((finalReward / finalRisk).toFixed(4)) : null;

  return {
    ok: true,
    reasonCode: null,
    reasons: [
      `TP recomputed at ${intendedTargetRMultiple}R from final entry ${input.entryPrice} and SL ${finalSl}`
    ],
    takeProfit: finalTp,
    stopLoss: finalSl,
    stopDistance: Number(finalRisk.toFixed(8)),
    targetDistance: Number(finalReward.toFixed(8)),
    intendedTargetRMultiple,
    actualTargetRMultiple,
    validation
  };
}
