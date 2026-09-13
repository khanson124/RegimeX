/**
 * CFD stop/target for xau-trend-pullback-v1 (research CFD backtests).
 */
import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";
import { mergeCfdParams } from "./cfdParams.js";

export interface XauTrendPullbackCfdParams {
  targetRMultiple: number;
  stopAtrMultiple: number;
  structureBufferAtr: number;
  tickSize: number;
}

export const DEFAULT_XAU_TREND_PULLBACK_CFD_PARAMS: XauTrendPullbackCfdParams = {
  targetRMultiple: 2,
  stopAtrMultiple: 1.5,
  structureBufferAtr: 0.15,
  tickSize: 0.01
};

export function proposeXauTrendPullbackStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<XauTrendPullbackCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = mergeCfdParams(DEFAULT_XAU_TREND_PULLBACK_CFD_PARAMS, input.params);
  const reasons: string[] = [];
  const atr = input.features.atr ?? null;
  const metaStop = typeof input.metadata?.stopLoss === "number" ? input.metadata.stopLoss : null;
  const metaTp = typeof input.metadata?.takeProfit === "number" ? input.metadata.takeProfit : null;
  const intendedR =
    typeof input.metadata?.intendedR === "number" ? input.metadata.intendedR : p.targetRMultiple;
  const pullbackLow =
    typeof input.metadata?.pullbackLow === "number" ? input.metadata.pullbackLow : null;
  const pullbackHigh =
    typeof input.metadata?.pullbackHigh === "number" ? input.metadata.pullbackHigh : null;

  let stopLoss = metaStop;
  let stopMethod = "strategy_metadata";
  if (stopLoss == null && atr != null && atr > 0) {
    const atrStop =
      input.direction === "BUY"
        ? input.entryPrice - atr * p.stopAtrMultiple
        : input.entryPrice + atr * p.stopAtrMultiple;
    const buffer = atr * p.structureBufferAtr;
    if (input.direction === "BUY") {
      const struct =
        pullbackLow != null && pullbackLow < input.entryPrice ? pullbackLow - buffer : null;
      stopLoss = struct != null ? Math.min(atrStop, struct) : atrStop;
      stopMethod = struct != null ? "atr_structure_conservative" : "atr";
      reasons.push("ATR/structure conservative BUY stop");
    } else {
      const struct =
        pullbackHigh != null && pullbackHigh > input.entryPrice ? pullbackHigh + buffer : null;
      stopLoss = struct != null ? Math.max(atrStop, struct) : atrStop;
      stopMethod = struct != null ? "atr_structure_conservative" : "atr";
      reasons.push("ATR/structure conservative SELL stop");
    }
  }
  if (stopLoss == null || !Number.isFinite(stopLoss)) return null;
  if (input.direction === "BUY" && stopLoss >= input.entryPrice) return null;
  if (input.direction === "SELL" && stopLoss <= input.entryPrice) return null;

  const stopDistance = Math.abs(input.entryPrice - stopLoss);
  if (stopDistance <= 0) return null;
  const targetDistance = stopDistance * intendedR;
  const takeProfit =
    metaTp ??
    (input.direction === "BUY"
      ? input.entryPrice + targetDistance
      : input.entryPrice - targetDistance);
  if (!Number.isFinite(takeProfit) || targetDistance <= 0) return null;

  reasons.push(`Target at ${intendedR}R`);

  return {
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    targetDistance: Number(targetDistance.toFixed(8)),
    riskRewardRatio: intendedR,
    stopMethod,
    targetMethod: "fixed_r",
    initialRiskReward: intendedR,
    method: stopMethod,
    reasons
  };
}
