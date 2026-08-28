import {
  type CfdRiskLimits,
  type StopTargetProposal,
  type PositionDirection,
  resolveCfdRiskLimits,
  type CfdRiskProfileExtension
} from "@regimex/shared";
import { type MarketFeatureSnapshot } from "@regimex/shared";
import { type Candle } from "@regimex/shared";
import { mergeCfdParams } from "./cfdParams.js";

export interface BreakoutMomentumCfdParams {
  /** Target as multiple of initial stop distance (R). Default 2R. */
  targetRMultiple: number;
  /** ATR multiplier when structure stop unavailable. */
  stopAtrMultiple: number;
  /** Buffer below/above structure in price units. */
  structureBufferTicks: number;
  tickSize: number;
}

export const DEFAULT_BREAKOUT_CFD_PARAMS: BreakoutMomentumCfdParams = {
  targetRMultiple: 2,
  stopAtrMultiple: 1.5,
  structureBufferTicks: 2,
  tickSize: 0.01
};

/**
 * Breakout Momentum CFD stop/target rules (pilot):
 *
 * - **Structure stop (preferred):** BUY → below Donchian low − buffer; SELL → above Donchian high + buffer.
 * - **ATR fallback:** when structure level is invalid vs entry, use entry ± ATR × stopAtrMultiple.
 * - **Target:** entry ± stopDistance × targetRMultiple (default 2R).
 */
export function proposeBreakoutMomentumStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<BreakoutMomentumCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = mergeCfdParams(DEFAULT_BREAKOUT_CFD_PARAMS, input.params);
  const reasons: string[] = [];
  const { direction, entryPrice } = input;
  const f = input.features;

  const donchianLow = f.donchianLow ?? (input.metadata?.donchianLow as number | undefined) ?? null;
  const donchianHigh = f.donchianHigh ?? (input.metadata?.donchianHigh as number | undefined) ?? null;
  const atr = f.atr ?? null;

  let stopLoss: number | null = null;
  let method = "structure";

  const buffer = p.structureBufferTicks * p.tickSize;

  if (direction === "BUY") {
    if (donchianLow !== null && donchianLow < entryPrice) {
      stopLoss = donchianLow - buffer;
      reasons.push(`Structure stop below Donchian low (${donchianLow}) with ${p.structureBufferTicks}-tick buffer`);
    } else if (atr !== null && atr > 0) {
      stopLoss = entryPrice - atr * p.stopAtrMultiple;
      method = "atr_fallback";
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR (${atr.toFixed(4)}) below entry`);
    }
  } else {
    if (donchianHigh !== null && donchianHigh > entryPrice) {
      stopLoss = donchianHigh + buffer;
      reasons.push(`Structure stop above Donchian high (${donchianHigh}) with ${p.structureBufferTicks}-tick buffer`);
    } else if (atr !== null && atr > 0) {
      stopLoss = entryPrice + atr * p.stopAtrMultiple;
      method = "atr_fallback";
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR (${atr.toFixed(4)}) above entry`);
    }
  }

  if (stopLoss === null || !Number.isFinite(stopLoss)) {
    return null;
  }

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
    stopMethod: method,
    targetMethod: "fixed_r",
    initialRiskReward: p.targetRMultiple,
    method,
    reasons
  };
}

export function resolveCfdLimitsFromProfile(profile: CfdRiskProfileExtension): CfdRiskLimits {
  return resolveCfdRiskLimits(profile);
}
