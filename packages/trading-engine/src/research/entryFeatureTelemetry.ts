/**
 * Compact entry-feature telemetry for forward-trade diagnosis.
 * Pure derivation from decision-time candle/features — never affects trade decisions.
 */

import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type StrategyDecision
} from "@regimex/shared";
import { buildCfdTradeEntryFeatureSnapshot } from "./cfdTradeEntrySnapshot.js";

export const ENTRY_FEATURE_TELEMETRY_VERSION = 1 as const;

/**
 * Query-friendly nested object stored under Position.metadata.entryFeatureTelemetry
 * (and DecisionLog.featureSummary.entryFeatureTelemetry). Compact numerics only.
 */
export interface EntryFeatureTelemetry {
  telemetryVersion: typeof ENTRY_FEATURE_TELEMETRY_VERSION;
  strategyId: string;
  symbol: string;
  interval: string;
  direction: "BUY" | "SELL";
  regime: string;
  strategyConfidence: number;
  regimeConfidence: number;
  timestamp: number;

  /** Trend / EMA */
  fastEma: number | null;
  slowEma: number | null;
  longEma: number | null;
  fastEmaSlope: number | null;
  slowEmaSlope: number | null;
  priceDistanceFromFastEma: number | null;
  priceDistanceFromSlowEma: number | null;
  priceDistanceFromLongEma: number | null;
  priceDistanceFromFastEmaAtr: number | null;
  priceDistanceFromSlowEmaAtr: number | null;
  priceDistanceFromLongEmaAtr: number | null;
  priceAboveFastEma: boolean | null;
  priceAboveSlowEma: boolean | null;
  priceAboveLongEma: boolean | null;
  emaStackBullish: boolean | null;
  emaStackBearish: boolean | null;
  trendDirection: -1 | 0 | 1 | null;

  /** Momentum / volatility */
  rsi: number | null;
  adx: number | null;
  atr: number | null;
  atrPercent: number | null;
  candleRange: number | null;
  candleRangeAtr: number | null;
  candleBodySize: number | null;
  candleBodySizeAtr: number | null;
  rejectionWickSize: number | null;
  rejectionWickBodyRatio: number | null;

  /** Pullback (EMA pullback strategy metadata) */
  pullbackDepth: number | null;
  pullbackDepthAtr: number | null;
  pullbackEma: string | null;
  pullbackLow: number | null;
  pullbackHigh: number | null;
  targetEma: number | null;

  /**
   * Recent channel extremes from Donchian features (not multi-bar swing pivots).
   * Named explicitly so SQL analysis does not confuse them with true swings.
   */
  distanceFromDonchianHigh: number | null;
  distanceFromDonchianLow: number | null;
  distanceFromDonchianHighAtr: number | null;
  distanceFromDonchianLowAtr: number | null;
  higherHighCount: number | null;
  lowerLowCount: number | null;

  /** Entry-quality diagnostics (trend-structure-pullback and similar). */
  extensionAtr: number | null;
  extensionLimitAtr: number | null;
  minimumPullbackDepthAtr: number | null;
  impulseDistanceAtr: number | null;
  barsSinceImpulse: number | null;
  structureState: string | null;
  distanceToNearestStructureAtr: number | null;
  entryQualityScore: number | null;
  entryQualityReasonCodes: string[] | null;
  extensionPenalty: number | null;
  pullbackQualityScore: number | null;
  structureQualityScore: number | null;
  continuationQualityScore: number | null;
  targetRoomScore: number | null;
  allEntryQualityReasonCodes: string[] | null;
  finalEntryQualityDecision: string | null;
  entryQualityIntersection: string | null;
}

function atrDistance(priceDelta: number | null, atr: number | null): number | null {
  if (priceDelta === null || atr === null || !(atr > 0) || !Number.isFinite(priceDelta)) return null;
  return Number((priceDelta / atr).toFixed(6));
}

function priceMinusEma(close: number, ema: number | null): number | null {
  if (ema === null || !Number.isFinite(ema)) return null;
  return close - ema;
}

/**
 * Build compact entry telemetry from the same candle/feature/decision context
 * used for the signal. Safe when optional indicators are null.
 */
export function buildEntryFeatureTelemetry(input: {
  feature: MarketFeatureSnapshot;
  candle: Candle;
  decision: StrategyDecision;
  regime: MarketRegime | string;
  regimeConfidence: number;
  symbol?: string;
  interval?: string;
}): EntryFeatureTelemetry {
  const { feature, candle, decision } = input;
  const snap = buildCfdTradeEntryFeatureSnapshot({
    feature,
    candle,
    decision,
    regime: input.regime as MarketRegime,
    regimeConfidence: input.regimeConfidence
  });

  const atr = snap.atr;
  const close = candle.close;
  const fastDelta = priceMinusEma(close, feature.emaFast);
  const slowDelta = priceMinusEma(close, feature.emaSlow);
  const longDelta = priceMinusEma(close, feature.emaLong);
  const candleRange = Number((candle.high - candle.low).toFixed(6));
  const rejectionWickSize =
    decision.action === "BUY"
      ? snap.lowerWick
      : decision.action === "SELL"
        ? snap.upperWick
        : null;

  const metadata = (decision.metadata ?? {}) as Record<string, unknown>;
  const pullbackEma = typeof metadata.pullbackEma === "string" ? metadata.pullbackEma : null;
  const pullbackLow = typeof metadata.pullbackLow === "number" ? metadata.pullbackLow : null;
  const pullbackHigh = typeof metadata.pullbackHigh === "number" ? metadata.pullbackHigh : null;
  const targetEma =
    typeof metadata.targetEma === "number"
      ? metadata.targetEma
      : feature.emaFast;

  const metaPullbackDepthAtr =
    typeof metadata.pullbackDepthAtr === "number" ? metadata.pullbackDepthAtr : null;
  const metaExtensionAtr = typeof metadata.extensionAtr === "number" ? metadata.extensionAtr : null;
  const metaExtensionLimitAtr =
    typeof metadata.extensionLimitAtr === "number" ? metadata.extensionLimitAtr : null;
  const metaMinPullback =
    typeof metadata.minimumPullbackDepthAtr === "number" ? metadata.minimumPullbackDepthAtr : null;
  const metaImpulse =
    typeof metadata.impulseDistanceAtr === "number" ? metadata.impulseDistanceAtr : null;
  const metaBarsSince =
    typeof metadata.barsSinceImpulse === "number" ? metadata.barsSinceImpulse : null;
  const metaStructureState =
    typeof metadata.structureState === "string" ? metadata.structureState : null;
  const metaDistStructure =
    typeof metadata.distanceToNearestStructureAtr === "number"
      ? metadata.distanceToNearestStructureAtr
      : null;
  const metaQualityScore =
    typeof metadata.entryQualityScore === "number" ? metadata.entryQualityScore : null;
  const metaReasonCodes = Array.isArray(metadata.entryQualityReasonCodes)
    ? (metadata.entryQualityReasonCodes as unknown[]).filter((x): x is string => typeof x === "string")
    : null;

  // pullbackDepth is fraction of target EMA; convert to price then ATR units.
  const pullbackDepthAtr =
    metaPullbackDepthAtr ??
    (snap.pullbackDepth != null && targetEma != null && atr != null && atr > 0
      ? Number(((Math.abs(snap.pullbackDepth) * Math.abs(targetEma)) / atr).toFixed(6))
      : null);

  const donchianHighDelta =
    feature.donchianHigh != null ? feature.donchianHigh - close : null;
  const donchianLowDelta =
    feature.donchianLow != null ? close - feature.donchianLow : null;

  const fast = feature.emaFast;
  const slow = feature.emaSlow;
  const long = feature.emaLong;
  const emaStackBullish =
    fast != null && slow != null && long != null ? fast > slow && slow > long : null;
  const emaStackBearish =
    fast != null && slow != null && long != null ? fast < slow && slow < long : null;

  return {
    telemetryVersion: ENTRY_FEATURE_TELEMETRY_VERSION,
    strategyId: decision.strategyId,
    symbol: input.symbol ?? feature.symbol,
    interval: input.interval ?? feature.interval,
    direction: decision.action as "BUY" | "SELL",
    regime: String(input.regime),
    strategyConfidence: decision.confidence,
    regimeConfidence: input.regimeConfidence,
    timestamp: candle.closeTime,

    fastEma: snap.emaFast,
    slowEma: snap.emaSlow,
    longEma: snap.emaLong,
    fastEmaSlope: snap.emaFastSlope,
    slowEmaSlope: snap.emaSlowSlope,
    priceDistanceFromFastEma: snap.priceDistanceFromFastEma,
    priceDistanceFromSlowEma: snap.priceDistanceFromSlowEma,
    priceDistanceFromLongEma:
      feature.emaLong != null && feature.emaLong !== 0
        ? Number(((close - feature.emaLong) / feature.emaLong).toFixed(6))
        : null,
    priceDistanceFromFastEmaAtr: atrDistance(fastDelta, atr),
    priceDistanceFromSlowEmaAtr: atrDistance(slowDelta, atr),
    priceDistanceFromLongEmaAtr: atrDistance(longDelta, atr),
    priceAboveFastEma: fast != null ? close > fast : null,
    priceAboveSlowEma: slow != null ? close > slow : null,
    priceAboveLongEma: long != null ? close > long : null,
    emaStackBullish,
    emaStackBearish,
    trendDirection: snap.trendDirection,

    rsi: snap.rsi,
    adx: snap.adx,
    atr,
    atrPercent: snap.atrPercent,
    candleRange,
    candleRangeAtr: atrDistance(candleRange, atr),
    candleBodySize: snap.candleBodySize,
    candleBodySizeAtr: atrDistance(snap.candleBodySize, atr),
    rejectionWickSize,
    rejectionWickBodyRatio: snap.rejectionWickBodyRatio,

    pullbackDepth: snap.pullbackDepth,
    pullbackDepthAtr,
    pullbackEma,
    pullbackLow,
    pullbackHigh,
    targetEma: targetEma ?? null,

    distanceFromDonchianHigh: snap.distanceFromDonchianHigh,
    distanceFromDonchianLow: snap.distanceFromDonchianLow,
    distanceFromDonchianHighAtr: atrDistance(donchianHighDelta, atr),
    distanceFromDonchianLowAtr: atrDistance(donchianLowDelta, atr),
    higherHighCount: feature.higherHighCount,
    lowerLowCount: feature.lowerLowCount,

    extensionAtr: metaExtensionAtr,
    extensionLimitAtr: metaExtensionLimitAtr,
    minimumPullbackDepthAtr: metaMinPullback,
    impulseDistanceAtr: metaImpulse,
    barsSinceImpulse: metaBarsSince,
    structureState: metaStructureState,
    distanceToNearestStructureAtr: metaDistStructure,
    entryQualityScore: metaQualityScore,
    entryQualityReasonCodes: metaReasonCodes,
    extensionPenalty:
      typeof metadata.extensionPenalty === "number" ? metadata.extensionPenalty : null,
    pullbackQualityScore:
      typeof metadata.pullbackQualityScore === "number" ? metadata.pullbackQualityScore : null,
    structureQualityScore:
      typeof metadata.structureQualityScore === "number" ? metadata.structureQualityScore : null,
    continuationQualityScore:
      typeof metadata.continuationQualityScore === "number"
        ? metadata.continuationQualityScore
        : null,
    targetRoomScore: typeof metadata.targetRoomScore === "number" ? metadata.targetRoomScore : null,
    allEntryQualityReasonCodes: Array.isArray(metadata.allEntryQualityReasonCodes)
      ? (metadata.allEntryQualityReasonCodes as unknown[]).filter(
          (x): x is string => typeof x === "string"
        )
      : null,
    finalEntryQualityDecision:
      typeof metadata.finalEntryQualityDecision === "string"
        ? metadata.finalEntryQualityDecision
        : null,
    entryQualityIntersection:
      typeof metadata.entryQualityIntersection === "string"
        ? metadata.entryQualityIntersection
        : null
  };
}

/** True when value is JSON-safe (finite number, bool, string, null). */
export function isEntryFeatureTelemetryJsonSafe(telemetry: EntryFeatureTelemetry): boolean {
  try {
    const roundTrip = JSON.parse(JSON.stringify(telemetry)) as EntryFeatureTelemetry;
    return roundTrip.telemetryVersion === telemetry.telemetryVersion && roundTrip.timestamp === telemetry.timestamp;
  } catch {
    return false;
  }
}
