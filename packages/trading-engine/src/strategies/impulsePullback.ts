/**
 * 5m impulse / pullback / compression phase classification (research).
 */
import { type Candle } from "@regimex/shared";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind,
  maxHighSince,
  minLowSince
} from "./structureSwings.js";
import { type HtfStructureState } from "./htfStructure.js";

export type ImpulsePullbackPhase =
  | "IMPULSE"
  | "PULLBACK"
  | "COMPRESSION"
  | "FAILED_CONTINUATION"
  | "NEUTRAL";

export interface ImpulsePullbackSnapshot {
  phase: ImpulsePullbackPhase;
  impulseDistanceAtr: number | null;
  pullbackDepthAtr: number | null;
  pullbackPercentOfImpulse: number | null;
  barsSinceImpulseExtreme: number | null;
  impulseExtreme: number | null;
  pullbackSwing: number | null;
  atr: number | null;
  consecutiveDirectionalCloses: number;
  rangeExpansion: boolean;
}

function wilderAtr(candles: ReadonlyArray<Candle>, period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

function consecutiveCloses(
  candles: ReadonlyArray<Candle>,
  direction: "up" | "down"
): number {
  let n = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const ok = direction === "up" ? c.close > p.close : c.close < p.close;
    if (!ok) break;
    n++;
  }
  return n;
}

export function classifyImpulsePullback(input: {
  setupCandles: ReadonlyArray<Candle>;
  bias: HtfStructureState;
  swingLookback?: number;
  atrPeriod?: number;
}): ImpulsePullbackSnapshot {
  const lookback = input.swingLookback ?? 2;
  const asOf = input.setupCandles.length - 1;
  const empty: ImpulsePullbackSnapshot = {
    phase: "NEUTRAL",
    impulseDistanceAtr: null,
    pullbackDepthAtr: null,
    pullbackPercentOfImpulse: null,
    barsSinceImpulseExtreme: null,
    impulseExtreme: null,
    pullbackSwing: null,
    atr: null,
    consecutiveDirectionalCloses: 0,
    rangeExpansion: false
  };
  if (input.bias === "NEUTRAL" || asOf < lookback * 2 + 5) return empty;

  const atr = wilderAtr(input.setupCandles, input.atrPeriod ?? 14);
  if (atr == null || atr <= 0) return empty;

  const pivots = findConfirmedSwingPivots(input.setupCandles, asOf, lookback);
  const lastLow = latestSwingOfKind(pivots, "low");
  const lastHigh = latestSwingOfKind(pivots, "high");

  const recent = input.setupCandles.slice(Math.max(0, asOf - 5), asOf + 1);
  const avgRange =
    recent.reduce((a, c) => a + (c.high - c.low), 0) / Math.max(1, recent.length);
  const lastRange = input.setupCandles[asOf]!.high - input.setupCandles[asOf]!.low;
  const rangeExpansion = lastRange > avgRange * 1.25;
  const atrPrev = wilderAtr(input.setupCandles.slice(0, asOf), input.atrPeriod ?? 14);
  const atrContracting = atrPrev != null && atr < atrPrev * 0.95;

  if (input.bias === "BULLISH") {
    if (!lastLow) return { ...empty, atr };
    const impulseHigh = maxHighSince(input.setupCandles, lastLow.index, asOf);
    if (impulseHigh == null) return { ...empty, atr };
    const impulseDist = (impulseHigh - lastLow.price) / atr;
    const pullbackDepth = (impulseHigh - input.setupCandles[asOf]!.close) / atr;
    const pullbackPct = impulseDist > 0 ? pullbackDepth / impulseDist : null;

    let barsSince = 0;
    for (let i = asOf; i > lastLow.index; i--) {
      if (input.setupCandles[i]!.high >= impulseHigh - atr * 0.01) {
        barsSince = asOf - i;
        break;
      }
    }

    const failed =
      lastHigh &&
      input.setupCandles[asOf]!.close < lastLow.price &&
      pullbackDepth > impulseDist * 1.05;

    let phase: ImpulsePullbackPhase = "NEUTRAL";
    if (failed) phase = "FAILED_CONTINUATION";
    else if (atrContracting && pullbackDepth < 0.25 && impulseDist < 1) phase = "COMPRESSION";
    else if (pullbackDepth >= 0.25 && pullbackPct != null && pullbackPct >= 0.2 && pullbackPct <= 0.85)
      phase = "PULLBACK";
    else if (pullbackDepth < 0.25 && impulseDist >= 0.8 && rangeExpansion) phase = "IMPULSE";
    else if (pullbackDepth >= 0.25) phase = "PULLBACK";
    else if (impulseDist >= 0.5) phase = "IMPULSE";

    return {
      phase,
      impulseDistanceAtr: Number(impulseDist.toFixed(4)),
      pullbackDepthAtr: Number(pullbackDepth.toFixed(4)),
      pullbackPercentOfImpulse:
        pullbackPct != null ? Number(pullbackPct.toFixed(4)) : null,
      barsSinceImpulseExtreme: barsSince,
      impulseExtreme: impulseHigh,
      pullbackSwing: lastLow.price,
      atr,
      consecutiveDirectionalCloses: consecutiveCloses(input.setupCandles, "up"),
      rangeExpansion
    };
  }

  // BEARISH
  if (!lastHigh) return { ...empty, atr };
  const impulseLow = minLowSince(input.setupCandles, lastHigh.index, asOf);
  if (impulseLow == null) return { ...empty, atr };
  const impulseDist = (lastHigh.price - impulseLow) / atr;
  const pullbackDepth = (input.setupCandles[asOf]!.close - impulseLow) / atr;
  const pullbackPct = impulseDist > 0 ? pullbackDepth / impulseDist : null;

  let barsSince = 0;
  for (let i = asOf; i > lastHigh.index; i--) {
    if (input.setupCandles[i]!.low <= impulseLow + atr * 0.01) {
      barsSince = asOf - i;
      break;
    }
  }

  const failed =
    lastLow &&
    input.setupCandles[asOf]!.close > lastHigh.price &&
    pullbackDepth > impulseDist * 1.05;

  let phase: ImpulsePullbackPhase = "NEUTRAL";
  if (failed) phase = "FAILED_CONTINUATION";
  else if (atrContracting && pullbackDepth < 0.25 && impulseDist < 1) phase = "COMPRESSION";
  else if (pullbackDepth >= 0.25 && pullbackPct != null && pullbackPct >= 0.2 && pullbackPct <= 0.85)
    phase = "PULLBACK";
  else if (pullbackDepth < 0.25 && impulseDist >= 0.8 && rangeExpansion) phase = "IMPULSE";
  else if (pullbackDepth >= 0.25) phase = "PULLBACK";
  else if (impulseDist >= 0.5) phase = "IMPULSE";

  return {
    phase,
    impulseDistanceAtr: Number(impulseDist.toFixed(4)),
    pullbackDepthAtr: Number(pullbackDepth.toFixed(4)),
    pullbackPercentOfImpulse: pullbackPct != null ? Number(pullbackPct.toFixed(4)) : null,
    barsSinceImpulseExtreme: barsSince,
    impulseExtreme: impulseLow,
    pullbackSwing: lastHigh.price,
    atr,
    consecutiveDirectionalCloses: consecutiveCloses(input.setupCandles, "down"),
    rangeExpansion
  };
}
