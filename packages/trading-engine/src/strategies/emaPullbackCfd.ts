import {
  type Candle,
  type MarketFeatureSnapshot,
  type PositionDirection,
  type StopTargetProposal
} from "@regimex/shared";

export interface EmaPullbackCfdParams {
  /** Target as multiple of initial stop distance (R). Default 2R. */
  targetRMultiple: number;
  /** ATR multiplier when structure stop unavailable. */
  stopAtrMultiple: number;
  /** ATR buffer beyond pullback swing extreme. */
  structureBufferAtr: number;
  /** Optional max bars to hold in backtests (passed through config when set). */
  maxHoldBars?: number;
  tickSize: number;
}

export const DEFAULT_EMA_PULLBACK_CFD_PARAMS: EmaPullbackCfdParams = {
  targetRMultiple: 2,
  stopAtrMultiple: 1.5,
  structureBufferAtr: 0.25,
  tickSize: 0.01
};

/**
 * EMA Pullback CFD stop/target:
 *
 * BUY (trend continuation after pullback rejection):
 * - Preferred structure stop: below pullback swing low (rejection candle low) − ATR buffer
 * - ATR fallback: entry − ATR × stopAtrMultiple when structure is invalid vs entry
 *
 * SELL: mirror above swing high
 *
 * Target: entry ± stopDistance × targetRMultiple (default 2R)
 *
 * Fail closed (null) if no valid stop can be produced.
 */
export function proposeEmaPullbackStopTarget(input: {
  direction: PositionDirection;
  entryPrice: number;
  features: MarketFeatureSnapshot;
  candles: ReadonlyArray<Candle>;
  params?: Partial<EmaPullbackCfdParams>;
  metadata?: Record<string, unknown>;
}): StopTargetProposal | null {
  const p = { ...DEFAULT_EMA_PULLBACK_CFD_PARAMS, ...input.params };
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
      reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR (${atr.toFixed(4)}) below entry`);
    }
  } else if (swingHigh !== null && swingHigh > entryPrice) {
    stopLoss = swingHigh + atrBuffer;
    reasons.push(
      `Structure stop above pullback swing high (${swingHigh}) with ${p.structureBufferAtr}× ATR buffer`
    );
  } else if (atr !== null && atr > 0) {
    stopLoss = entryPrice + atr * p.stopAtrMultiple;
    stopMethod = "atr_fallback";
    reasons.push(`ATR fallback stop: ${p.stopAtrMultiple}× ATR (${atr.toFixed(4)}) above entry`);
  }

  if (stopLoss === null || !Number.isFinite(stopLoss)) {
    return null;
  }

  // Structure stop must remain on the adverse side of entry after buffer.
  if (direction === "BUY" && stopLoss >= entryPrice) return null;
  if (direction === "SELL" && stopLoss <= entryPrice) return null;

  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) return null;

  const targetDistance = stopDistance * p.targetRMultiple;
  const takeProfit =
    direction === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;
  const targetMethod = "fixed_r";
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
    targetMethod,
    initialRiskReward: p.targetRMultiple,
    method: stopMethod,
    reasons
  };
}
