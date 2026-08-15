import {
  adx,
  atr,
  atrPercent,
  bollingerBands,
  consecutiveHigherHighs,
  consecutiveLowerLows,
  donchianChannel,
  ema,
  macd,
  percentileRank,
  rateOfChange,
  rsi
} from "@regimex/indicators";
import { type Candle, type MarketFeatureSnapshot, type TrendDirection } from "@regimex/shared";

/** Indicator periods used to build feature snapshots. */
export interface FeatureConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  emaLongPeriod: number;
  rsiPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  donchianPeriod: number;
  /** Bars used for EMA slope (fractional change over this window). */
  slopePeriod: number;
  recentReturnPeriod: number;
  /** Window used for the volatility percentile. */
  volatilityPercentilePeriod: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  emaLongPeriod: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  donchianPeriod: 20,
  slopePeriod: 5,
  recentReturnPeriod: 10,
  volatilityPercentilePeriod: 100
};

/** Minimum closed candles for a fully-populated snapshot. */
export function minimumCandlesForFeatures(config: FeatureConfig): number {
  return Math.max(
    config.emaLongPeriod + config.slopePeriod,
    config.adxPeriod * 2,
    config.bollingerPeriod,
    config.donchianPeriod + 1
  );
}

function slopeOf(series: Array<number | null>, i: number, lookback: number): number | null {
  const now = series[i];
  const past = i - lookback >= 0 ? series[i - lookback] : null;
  if (now === null || now === undefined || past === null || past === undefined || past === 0) {
    return null;
  }
  return (now - past) / Math.abs(past);
}

/**
 * Build one feature snapshot per candle. Snapshot[i] uses only candles[0..i],
 * so iterating the output candle-by-candle is free of look-ahead bias.
 * Composite scores (trend/momentum/range/breakout) are filled by the regime
 * classifier, which owns the scoring thresholds.
 */
export function extractFeatures(
  candles: ReadonlyArray<Candle>,
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG
): MarketFeatureSnapshot[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const emaFast = ema(closes, config.emaFastPeriod);
  const emaSlow = ema(closes, config.emaSlowPeriod);
  const emaLong = ema(closes, config.emaLongPeriod);
  const rsiSeries = rsi(closes, config.rsiPeriod);
  const atrSeries = atr(candles, config.atrPeriod);
  const atrPctSeries = atrPercent(candles, config.atrPeriod);
  const adxSeries = adx(candles, config.adxPeriod);
  const macdSeries = macd(closes);
  const bbSeries = bollingerBands(closes, config.bollingerPeriod, config.bollingerStdDev);
  const donchian = donchianChannel(highs, lows, config.donchianPeriod);
  const recentRet = rateOfChange(closes, config.recentReturnPeriod);
  const hhCounts = consecutiveHigherHighs(highs);
  const llCounts = consecutiveLowerLows(lows);

  // Volatility percentile over ATR% history (nulls replaced by 0 pre-window;
  // percentile output is null until its own window fills anyway).
  const atrPctDense = atrPctSeries.map((v) => v ?? 0);
  const volPercentile = percentileRank(atrPctDense, config.volatilityPercentilePeriod);

  return candles.map((candle, i) => {
    const fast = emaFast[i] ?? null;
    const slow = emaSlow[i] ?? null;
    const long = emaLong[i] ?? null;
    const bb = bbSeries[i] ?? null;
    const m = macdSeries[i] ?? null;
    const dc = donchian[i] ?? null;

    let trendDirection: TrendDirection = 0;
    if (fast !== null && slow !== null && long !== null) {
      if (fast > slow && candle.close > long) trendDirection = 1;
      else if (fast < slow && candle.close < long) trendDirection = -1;
    }

    return {
      symbol: candle.symbol,
      interval: candle.interval,
      timestamp: candle.closeTime,
      close: candle.close,
      emaFast: fast,
      emaSlow: slow,
      emaLong: long,
      emaFastSlope: slopeOf(emaFast, i, config.slopePeriod),
      emaSlowSlope: slopeOf(emaSlow, i, config.slopePeriod),
      rsi: rsiSeries[i] ?? null,
      atr: atrSeries[i] ?? null,
      atrPercent: atrPctSeries[i] ?? null,
      adx: adxSeries[i] ?? null,
      macd: m?.macd ?? null,
      macdSignal: m?.signal ?? null,
      macdHistogram: m?.histogram ?? null,
      bollingerUpper: bb?.upper ?? null,
      bollingerMiddle: bb?.middle ?? null,
      bollingerLower: bb?.lower ?? null,
      bollingerWidth: bb?.width ?? null,
      priceDistanceFromEma:
        slow !== null && slow !== 0 ? (candle.close - slow) / slow : null,
      recentReturn: recentRet[i] ?? null,
      higherHighCount: hhCounts[i] ?? 0,
      lowerLowCount: llCounts[i] ?? 0,
      donchianHigh: dc?.upper ?? null,
      donchianLow: dc?.lower ?? null,
      trendDirection,
      volatilityPercentile:
        (atrPctSeries[i] ?? null) === null ? null : (volPercentile[i] ?? null),
      momentumScore: null,
      trendScore: null,
      rangeScore: null,
      breakoutScore: null
    } satisfies MarketFeatureSnapshot;
  });
}
