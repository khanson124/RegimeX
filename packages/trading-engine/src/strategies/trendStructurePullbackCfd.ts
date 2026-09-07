import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";
import { mergeCfdParams } from "./cfdParams.js";

export interface TrendStructurePullbackCfdParams {
  targetRMultiple: number;
  stopAtrMultiple: number;
  structureBufferAtr: number;
  maxHoldBars?: number;
  tickSize: number;
}

export const DEFAULT_TREND_STRUCTURE_PULLBACK_CFD_PARAMS: TrendStructurePullbackCfdParams = {
  targetRMultiple: 2,
  stopAtrMultiple: 1.5,
  structureBufferAtr: 0.25,
  tickSize: 0.01
};

/**
 * Same structure-first stop/target geometry as EMA pullback CFD:
 * stop beyond pullback swing extreme; target at targetRMultiple R.
 * Strategy entry filters already enforce pullback/extension quality.
 */
export function proposeTrendStructurePullbackStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<TrendStructurePullbackCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = mergeCfdParams(DEFAULT_TREND_STRUCTURE_PULLBACK_CFD_PARAMS, input.params);
  const reasons: string[] = [];
  const { direction, entryPrice } = input;
  const f = input.features;
  const candle = input.candles[input.candles.length - 1];
  const atr = f.atr ?? null;

  const metaLow =
    typeof input.metadata?.pullbackLow === "number" ? input.metadata.pullbackLow : null;
  const metaHigh =
    typeof input.metadata?.pullbackHigh === "number" ? input.metadata.pullbackHigh : null;

  const swingLow = metaLow ?? candle?.low ?? null;
  const swingHigh = metaHigh ?? candle?.high ?? null;

  let stopLoss: number | null = null;
  let stopMethod = "structure";
  const atrBuffer = atr !== null && atr > 0 ? atr * p.structureBufferAtr : p.tickSize * 2;

  if (direction === "BUY") {
    if (swingLow !== null && swingLow < entryPrice) {
      stopLoss = swingLow - atrBuffer;
      reasons.push(
        `Structure stop below pullback swing low (${swingLow}) with ${p.structureBufferAtr}× ATR buffer`
      );
    } else if (atr !== null && atr > 0) {
      stopLoss = entryPrice - atr * p.stopAtrMultiple;
      stopMethod = "atr_fallback";
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR below entry`);
    }
  } else if (swingHigh !== null && swingHigh > entryPrice) {
    stopLoss = swingHigh + atrBuffer;
    reasons.push(
      `Structure stop above pullback swing high (${swingHigh}) with ${p.structureBufferAtr}× ATR buffer`
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

  reasons.push(`Target at ${p.targetRMultiple}R (${targetDistance.toFixed(4)} from entry)`);

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
