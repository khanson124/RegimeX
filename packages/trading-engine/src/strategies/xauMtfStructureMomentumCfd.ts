/**
 * CFD stop/target for xau-mtf-structure-momentum-v1.
 * Structural invalidation stop from pullback swing; target at intended R
 * capped by structural room when provided in metadata.
 */
import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";
import { mergeCfdParams } from "./cfdParams.js";

export interface XauMtfStructureMomentumCfdParams {
  targetRMultiple: number;
  stopAtrMultiple: number;
  structureBufferAtr: number;
  tickSize: number;
}

export const DEFAULT_XAU_MTF_STRUCTURE_MOMENTUM_CFD_PARAMS: XauMtfStructureMomentumCfdParams = {
  targetRMultiple: 2,
  stopAtrMultiple: 1.5,
  structureBufferAtr: 0.15,
  tickSize: 0.01
};

export function proposeXauMtfStructureMomentumStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<XauMtfStructureMomentumCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = mergeCfdParams(DEFAULT_XAU_MTF_STRUCTURE_MOMENTUM_CFD_PARAMS, input.params);
  const reasons: string[] = [];
  const { direction, entryPrice } = input;
  const atr = input.features.atr ?? null;
  const candle = input.candles[input.candles.length - 1];

  const metaLow =
    typeof input.metadata?.pullbackLow === "number" ? input.metadata.pullbackLow : null;
  const metaHigh =
    typeof input.metadata?.pullbackHigh === "number" ? input.metadata.pullbackHigh : null;
  const intendedR =
    typeof input.metadata?.intendedR === "number" ? input.metadata.intendedR : p.targetRMultiple;
  const structuralRoomR =
    typeof input.metadata?.structuralRoomR === "number" ? input.metadata.structuralRoomR : null;

  const swingLow = metaLow ?? candle?.low ?? null;
  const swingHigh = metaHigh ?? candle?.high ?? null;
  const atrBuffer = atr != null && atr > 0 ? atr * p.structureBufferAtr : p.tickSize * 2;

  let stopLoss: number | null = null;
  let stopMethod = "structure";

  if (direction === "BUY") {
    if (swingLow != null && swingLow < entryPrice) {
      stopLoss = swingLow - atrBuffer;
      reasons.push(`Structure stop below pullback swing low ${swingLow}`);
    } else if (atr != null && atr > 0) {
      stopLoss = entryPrice - atr * p.stopAtrMultiple;
      stopMethod = "atr_fallback";
      reasons.push(`ATR fallback stop ${p.stopAtrMultiple}×ATR`);
    }
  } else if (swingHigh != null && swingHigh > entryPrice) {
    stopLoss = swingHigh + atrBuffer;
    reasons.push(`Structure stop above pullback swing high ${swingHigh}`);
  } else if (atr != null && atr > 0) {
    stopLoss = entryPrice + atr * p.stopAtrMultiple;
    stopMethod = "atr_fallback";
    reasons.push(`ATR fallback stop ${p.stopAtrMultiple}×ATR`);
  }

  if (stopLoss == null || !Number.isFinite(stopLoss)) return null;
  if (direction === "BUY" && stopLoss >= entryPrice) return null;
  if (direction === "SELL" && stopLoss <= entryPrice) return null;

  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) return null;

  // Cap target R by structural room when tighter than intended R (no silent widen).
  let targetR = intendedR;
  if (structuralRoomR != null && structuralRoomR > 0) {
    targetR = Math.min(intendedR, structuralRoomR);
    reasons.push(`Target R capped by structural room (${structuralRoomR.toFixed(2)})`);
  }
  const targetDistance = stopDistance * targetR;
  const takeProfit =
    direction === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;
  if (!Number.isFinite(takeProfit) || targetDistance <= 0) return null;

  reasons.push(`Target at ${targetR}R`);

  return {
    direction,
    entryPrice,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    targetDistance: Number(targetDistance.toFixed(8)),
    riskRewardRatio: targetR,
    stopMethod,
    targetMethod: "structure_room_capped_r",
    initialRiskReward: targetR,
    method: stopMethod,
    reasons
  };
}
