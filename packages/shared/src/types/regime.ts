export const MARKET_REGIMES = [
  "STRONG_UPTREND",
  "WEAK_UPTREND",
  "STRONG_DOWNTREND",
  "WEAK_DOWNTREND",
  "RANGE_LOW_VOLATILITY",
  "RANGE_HIGH_VOLATILITY",
  "BREAKOUT_EXPANSION",
  "VOLATILITY_COMPRESSION",
  "TRANSITION",
  "UNKNOWN"
] as const;

export type MarketRegime = (typeof MARKET_REGIMES)[number];

/** Component scores, each 0-100. */
export interface RegimeScores {
  trend: number;
  momentum: number;
  volatility: number;
  range: number;
  breakout: number;
}

export interface RegimeResult {
  regime: MarketRegime;
  /** 0-1. Must be low when insufficient indicators are available. */
  confidence: number;
  scores: RegimeScores;
  reasons: string[];
  /** Epoch ms of the candle close this classification is based on. */
  timestamp: number;
  classifierVersion: string;
}

/** Direction of trend component: 1 up, -1 down, 0 flat/unknown. */
export type TrendDirection = 1 | 0 | -1;

/**
 * Feature snapshot generated for every completed candle.
 * Null fields mean insufficient history at that timestamp.
 */
export interface MarketFeatureSnapshot {
  symbol: string;
  interval: string;
  /** Close time of the candle (epoch ms). */
  timestamp: number;
  close: number;
  emaFast: number | null;
  emaSlow: number | null;
  emaLong: number | null;
  emaFastSlope: number | null;
  emaSlowSlope: number | null;
  rsi: number | null;
  atr: number | null;
  atrPercent: number | null;
  adx: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  bollingerWidth: number | null;
  priceDistanceFromEma: number | null;
  recentReturn: number | null;
  higherHighCount: number;
  lowerLowCount: number;
  donchianHigh: number | null;
  donchianLow: number | null;
  trendDirection: TrendDirection;
  /** 0-100 percentile of current ATR% within the lookback window. */
  volatilityPercentile: number | null;
  momentumScore: number | null;
  trendScore: number | null;
  rangeScore: number | null;
  breakoutScore: number | null;
}
