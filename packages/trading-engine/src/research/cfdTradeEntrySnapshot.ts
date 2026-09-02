import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type StrategyDecision
} from "@regimex/shared";

/** Decision-time context captured when a CFD simulated trade opens. No future candles. */
export interface CfdTradeEntryFeatureSnapshot {
  snapshotVersion: 1;
  /** Candle close time at signal — must match trade.entryTime. */
  timestamp: number;
  strategyId: string;
  action: "BUY" | "SELL";
  regime: MarketRegime;
  regimeConfidence: number;
  strategyConfidence: number;
  emaFast: number | null;
  emaSlow: number | null;
  emaLong: number | null;
  priceDistanceFromFastEma: number | null;
  priceDistanceFromSlowEma: number | null;
  emaFastSlope: number | null;
  emaSlowSlope: number | null;
  adx: number | null;
  rsi: number | null;
  atr: number | null;
  atrPercent: number | null;
  volatilityPercentile: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  bollingerWidth: number | null;
  /** Normalized position within bands: -1 lower, 0 middle, +1 upper. */
  bollingerPosition: number | null;
  /** Z-score vs middle using half-bandwidth as scale. */
  bollingerZScore: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  recentReturn: number | null;
  trendDirection: -1 | 0 | 1;
  donchianHigh: number | null;
  donchianLow: number | null;
  distanceFromDonchianHigh: number | null;
  distanceFromDonchianLow: number | null;
  candleOpen: number;
  candleHigh: number;
  candleLow: number;
  candleClose: number;
  candleBodySize: number;
  upperWick: number;
  lowerWick: number;
  rejectionWickBodyRatio: number | null;
  tickCount: number;
  /** Fractional depth of pullback beyond target EMA (EMA pullback). */
  pullbackDepth: number | null;
  /** Absolute distance from close to band middle as fraction of price. */
  distanceFromMean: number | null;
}

function num(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

function distanceFromEma(close: number, emaValue: number | null): number | null {
  if (emaValue === null || emaValue === 0) return null;
  return (close - emaValue) / emaValue;
}

function bollingerMetrics(
  close: number,
  upper: number | null,
  middle: number | null,
  lower: number | null
): { position: number | null; zScore: number | null; distanceFromMean: number | null } {
  if (upper === null || middle === null || lower === null || middle === 0) {
    return { position: null, zScore: null, distanceFromMean: null };
  }
  const halfWidth = (upper - lower) / 2;
  if (halfWidth <= 0) {
    return { position: null, zScore: null, distanceFromMean: (close - middle) / middle };
  }
  const position = (close - middle) / halfWidth;
  const zScore = (close - middle) / halfWidth;
  return {
    position: Number(position.toFixed(6)),
    zScore: Number(zScore.toFixed(6)),
    distanceFromMean: Number(((close - middle) / middle).toFixed(6))
  };
}

function rejectionRatio(
  action: "BUY" | "SELL",
  body: number,
  upperWick: number,
  lowerWick: number
): number | null {
  const wick = action === "BUY" ? lowerWick : upperWick;
  if (body === 0) return wick > 0 ? null : 0;
  return Number((wick / body).toFixed(6));
}

function pullbackDepth(
  action: "BUY" | "SELL",
  metadata: Record<string, unknown> | undefined,
  targetEma: number | null
): number | null {
  if (!metadata || targetEma === null || targetEma === 0) return null;
  const low = typeof metadata.pullbackLow === "number" ? metadata.pullbackLow : null;
  const high = typeof metadata.pullbackHigh === "number" ? metadata.pullbackHigh : null;
  if (action === "BUY" && low !== null) {
    return Number(((targetEma - low) / targetEma).toFixed(6));
  }
  if (action === "SELL" && high !== null) {
    return Number(((high - targetEma) / targetEma).toFixed(6));
  }
  return null;
}

/**
 * Build an entry feature snapshot from decision-time candle/features only.
 */
export function buildCfdTradeEntryFeatureSnapshot(input: {
  feature: MarketFeatureSnapshot;
  candle: Candle;
  decision: StrategyDecision;
  regime: MarketRegime;
  regimeConfidence: number;
}): CfdTradeEntryFeatureSnapshot {
  const { feature, candle, decision, regime, regimeConfidence } = input;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const bb = bollingerMetrics(
    candle.close,
    feature.bollingerUpper,
    feature.bollingerMiddle,
    feature.bollingerLower
  );
  const metadata = decision.metadata as Record<string, unknown> | undefined;
  const targetEma =
    typeof metadata?.targetEma === "number"
      ? metadata.targetEma
      : feature.emaFast;

  return {
    snapshotVersion: 1,
    timestamp: candle.closeTime,
    strategyId: decision.strategyId,
    action: decision.action as "BUY" | "SELL",
    regime,
    regimeConfidence,
    strategyConfidence: decision.confidence,
    emaFast: num(feature.emaFast),
    emaSlow: num(feature.emaSlow),
    emaLong: num(feature.emaLong),
    priceDistanceFromFastEma: distanceFromEma(candle.close, feature.emaFast),
    priceDistanceFromSlowEma: distanceFromEma(candle.close, feature.emaSlow),
    emaFastSlope: num(feature.emaFastSlope),
    emaSlowSlope: num(feature.emaSlowSlope),
    adx: num(feature.adx),
    rsi: num(feature.rsi),
    atr: num(feature.atr),
    atrPercent: num(feature.atrPercent),
    volatilityPercentile: num(feature.volatilityPercentile),
    bollingerUpper: num(feature.bollingerUpper),
    bollingerMiddle: num(feature.bollingerMiddle),
    bollingerLower: num(feature.bollingerLower),
    bollingerWidth: num(feature.bollingerWidth),
    bollingerPosition: bb.position,
    bollingerZScore: bb.zScore,
    macd: num(feature.macd),
    macdSignal: num(feature.macdSignal),
    macdHistogram: num(feature.macdHistogram),
    recentReturn: num(feature.recentReturn),
    trendDirection: feature.trendDirection,
    donchianHigh: num(feature.donchianHigh),
    donchianLow: num(feature.donchianLow),
    distanceFromDonchianHigh:
      feature.donchianHigh !== null && candle.close !== 0
        ? Number(((feature.donchianHigh - candle.close) / candle.close).toFixed(6))
        : null,
    distanceFromDonchianLow:
      feature.donchianLow !== null && candle.close !== 0
        ? Number(((candle.close - feature.donchianLow) / candle.close).toFixed(6))
        : null,
    candleOpen: candle.open,
    candleHigh: candle.high,
    candleLow: candle.low,
    candleClose: candle.close,
    candleBodySize: Number(body.toFixed(6)),
    upperWick: Number(upperWick.toFixed(6)),
    lowerWick: Number(lowerWick.toFixed(6)),
    rejectionWickBodyRatio: rejectionRatio(decision.action as "BUY" | "SELL", body, upperWick, lowerWick),
    tickCount: candle.tickCount,
    pullbackDepth: pullbackDepth(decision.action as "BUY" | "SELL", metadata, targetEma ?? null),
    distanceFromMean: bb.distanceFromMean
  };
}

/** Guard: snapshot must not include timestamps after entry. */
export function assertEntrySnapshotNoLookahead(
  tradeEntryTime: number,
  snapshot: CfdTradeEntryFeatureSnapshot
): void {
  if (snapshot.timestamp > tradeEntryTime) {
    throw new Error("Entry feature snapshot timestamp is after trade entry time");
  }
}
