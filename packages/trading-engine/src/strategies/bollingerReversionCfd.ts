import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";

export interface BollingerReversionCfdParams {
  /** Fallback target as multiple of stop distance when mid-band R:R is insufficient. */
  targetRMultiple: number;
  /** Minimum acceptable R:R for mid-band or fallback target. */
  minRiskRewardRatio: number;
  /** ATR buffer beyond band / swing extreme for the stop. */
  stopBufferAtr: number;
  /** ATR multiple fallback when structure/band stop is invalid. */
  stopAtrMultiple: number;
  tickSize: number;
}

export const DEFAULT_BOLLINGER_REVERSION_CFD_PARAMS: BollingerReversionCfdParams = {
  targetRMultiple: 2,
  minRiskRewardRatio: 1.5,
  stopBufferAtr: 0.35,
  stopAtrMultiple: 1.25,
  tickSize: 0.01
};

/**
 * Bollinger Reversion CFD stop/target (range / mean-reversion only — regime
 * filtering remains on the strategy evaluate path).
 *
 * BUY:
 * - Stop below local extreme: min(pullback low, lower band) − ATR buffer
 * - Target: mid-band when R:R ≥ minRiskRewardRatio; else fixed R if valid
 *
 * SELL: mirror
 *
 * Never forces a mid-band trade below min R:R; returns null if no valid target.
 */
export function proposeBollingerReversionStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<BollingerReversionCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = { ...DEFAULT_BOLLINGER_REVERSION_CFD_PARAMS, ...input.params };
  const reasons: string[] = [];
  const { direction, entryPrice } = input;
  const f = input.features;
  const candle = input.candles[input.candles.length - 1];
  const atr = f.atr ?? null;

  const lower =
    (typeof input.metadata?.bollingerLower === "number"
      ? input.metadata.bollingerLower
      : f.bollingerLower) ?? null;
  const upper =
    (typeof input.metadata?.bollingerUpper === "number"
      ? input.metadata.bollingerUpper
      : f.bollingerUpper) ?? null;
  const mid =
    (typeof input.metadata?.bollingerMid === "number"
      ? input.metadata.bollingerMid
      : typeof input.metadata?.bollingerMiddle === "number"
        ? input.metadata.bollingerMiddle
        : f.bollingerMiddle) ?? null;

  const swingLow =
    (typeof input.metadata?.extremeLow === "number" ? input.metadata.extremeLow : null) ??
    candle?.low ??
    null;
  const swingHigh =
    (typeof input.metadata?.extremeHigh === "number" ? input.metadata.extremeHigh : null) ??
    candle?.high ??
    null;

  const atrBuffer = atr !== null && atr > 0 ? atr * p.stopBufferAtr : p.tickSize * 2;

  let stopLoss: number | null = null;
  let stopMethod = "band_structure";

  if (direction === "BUY") {
    const extreme =
      lower !== null && swingLow !== null
        ? Math.min(lower, swingLow)
        : (swingLow ?? lower);
    if (extreme !== null && extreme < entryPrice) {
      stopLoss = extreme - atrBuffer;
      reasons.push(
        `Stop beyond lower-band/local extreme (${extreme}) with ${p.stopBufferAtr}× ATR buffer`
      );
    } else if (atr !== null && atr > 0) {
      stopLoss = entryPrice - atr * p.stopAtrMultiple;
      stopMethod = "atr_fallback";
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR below entry`);
    }
  } else {
    const extreme =
      upper !== null && swingHigh !== null
        ? Math.max(upper, swingHigh)
        : (swingHigh ?? upper);
    if (extreme !== null && extreme > entryPrice) {
      stopLoss = extreme + atrBuffer;
      reasons.push(
        `Stop beyond upper-band/local extreme (${extreme}) with ${p.stopBufferAtr}× ATR buffer`
      );
    } else if (atr !== null && atr > 0) {
      stopLoss = entryPrice + atr * p.stopAtrMultiple;
      stopMethod = "atr_fallback";
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR above entry`);
    }
  }

  if (stopLoss === null || !Number.isFinite(stopLoss)) return null;
  if (direction === "BUY" && stopLoss >= entryPrice) return null;
  if (direction === "SELL" && stopLoss <= entryPrice) return null;

  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) return null;

  let takeProfit: number | null = null;
  let targetMethod = "fixed_r";
  let riskRewardRatio = p.targetRMultiple;

  // Priority 1: mid-band when it produces acceptable R:R
  if (mid !== null && Number.isFinite(mid)) {
    const midOnSide =
      direction === "BUY" ? mid > entryPrice : mid < entryPrice;
    if (midOnSide) {
      const midDistance = Math.abs(mid - entryPrice);
      const midRr = midDistance / stopDistance;
      if (midRr + 1e-9 >= p.minRiskRewardRatio) {
        takeProfit = mid;
        targetMethod = "bollinger_mid";
        riskRewardRatio = Number(midRr.toFixed(4));
        reasons.push(
          `Target at Bollinger mid (${mid}) with R:R ${riskRewardRatio} ≥ min ${p.minRiskRewardRatio}`
        );
      } else {
        reasons.push(
          `Bollinger mid R:R ${midRr.toFixed(2)} < min ${p.minRiskRewardRatio} — not forcing mid-band trade`
        );
      }
    }
  }

  // Priority 2: configurable R target
  if (takeProfit === null) {
    if (p.targetRMultiple + 1e-9 < p.minRiskRewardRatio) {
      reasons.push(
        `Fallback targetRMultiple ${p.targetRMultiple} below min R:R ${p.minRiskRewardRatio}`
      );
      return null;
    }
    const targetDistance = stopDistance * p.targetRMultiple;
    takeProfit =
      direction === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;
    targetMethod = "fixed_r";
    riskRewardRatio = p.targetRMultiple;
    reasons.push(`Fallback target at ${p.targetRMultiple}R`);
  }

  return {
    direction,
    entryPrice,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    targetDistance: Number(Math.abs(takeProfit - entryPrice).toFixed(8)),
    riskRewardRatio,
    stopMethod,
    targetMethod,
    initialRiskReward: riskRewardRatio,
    method: stopMethod,
    reasons
  };
}
