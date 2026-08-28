import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";
import { mergeCfdParams } from "./cfdParams.js";

export interface SqueezeBreakoutCfdParams {
  /** Target as multiple of initial stop distance (R). Default 2R. */
  targetRMultiple: number;
  /** ATR multiplier when squeeze structure stop unavailable. */
  stopAtrMultiple: number;
  /** ATR buffer beyond squeeze range extreme. */
  structureBufferAtr: number;
  tickSize: number;
}

export const DEFAULT_SQUEEZE_BREAKOUT_CFD_PARAMS: SqueezeBreakoutCfdParams = {
  targetRMultiple: 2,
  stopAtrMultiple: 1.5,
  structureBufferAtr: 0.25,
  tickSize: 0.01
};

/**
 * Squeeze Breakout CFD stop/target:
 *
 * BUY (confirmed upside expansion after squeeze):
 * - Preferred: stop below squeeze structure (Donchian low / range low) − ATR buffer
 * - ATR fallback when structure invalid vs entry
 *
 * SELL: mirror above structure high
 *
 * Target: fixed R (default 2R). Trailing reserved for later — not implemented here.
 * Fail closed if no valid stop.
 */
export function proposeSqueezeBreakoutStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<SqueezeBreakoutCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = mergeCfdParams(DEFAULT_SQUEEZE_BREAKOUT_CFD_PARAMS, input.params);
  const reasons: string[] = [];
  const { direction, entryPrice } = input;
  const f = input.features;
  const atr = f.atr ?? null;

  const structureLow =
    (typeof input.metadata?.squeezeLow === "number" ? input.metadata.squeezeLow : null) ??
    (typeof input.metadata?.donchianLow === "number" ? input.metadata.donchianLow : null) ??
    f.donchianLow ??
    null;
  const structureHigh =
    (typeof input.metadata?.squeezeHigh === "number" ? input.metadata.squeezeHigh : null) ??
    (typeof input.metadata?.donchianHigh === "number" ? input.metadata.donchianHigh : null) ??
    f.donchianHigh ??
    null;

  const atrBuffer = atr !== null && atr > 0 ? atr * p.structureBufferAtr : p.tickSize * 2;

  let stopLoss: number | null = null;
  let stopMethod = "squeeze_structure";

  if (direction === "BUY") {
    if (structureLow !== null && structureLow < entryPrice) {
      stopLoss = structureLow - atrBuffer;
      reasons.push(
        `Stop below squeeze/range low (${structureLow}) with ${p.structureBufferAtr}× ATR buffer`
      );
    } else if (atr !== null && atr > 0) {
      stopLoss = entryPrice - atr * p.stopAtrMultiple;
      stopMethod = "atr_fallback";
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR below entry`);
    }
  } else if (structureHigh !== null && structureHigh > entryPrice) {
    stopLoss = structureHigh + atrBuffer;
    reasons.push(
      `Stop above squeeze/range high (${structureHigh}) with ${p.structureBufferAtr}× ATR buffer`
    );
  } else if (atr !== null && atr > 0) {
    stopLoss = entryPrice + atr * p.stopAtrMultiple;
    stopMethod = "atr_fallback";
    reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR above entry`);
  }

  if (stopLoss === null || !Number.isFinite(stopLoss)) return null;
  if (direction === "BUY" && stopLoss >= entryPrice) return null;
  if (direction === "SELL" && stopLoss <= entryPrice) return null;

  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) return null;

  const targetDistance = stopDistance * p.targetRMultiple;
  const takeProfit =
    direction === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;
  if (!Number.isFinite(takeProfit) || targetDistance <= 0) return null;

  reasons.push(`Target at ${p.targetRMultiple}R (trailing reserved for later)`);

  return {
    direction,
    entryPrice,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    targetDistance: Number(targetDistance.toFixed(8)),
    riskRewardRatio: p.targetRMultiple,
    stopMethod,
    targetMethod: "fixed_r",
    initialRiskReward: p.targetRMultiple,
    method: stopMethod,
    reasons
  };
}
