import { type Candle, type MarketFeatureSnapshot, type RegimeResult } from "@regimex/shared";

/** Deterministic PRNG for reproducible synthetic data. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticSeriesOptions {
  count: number;
  startPrice?: number;
  seed?: number;
  /** Per-candle drift (positive = uptrend). */
  drift?: number;
  /** Per-candle volatility. */
  volatility?: number;
  intervalMsValue?: number;
  startTime?: number;
}

/** Generate deterministic synthetic candles (random walk with drift). */
export function syntheticCandles(options: SyntheticSeriesOptions): Candle[] {
  const {
    count,
    startPrice = 1000,
    seed = 1,
    drift = 0,
    volatility = 2,
    intervalMsValue = 60_000,
    startTime = Date.UTC(2026, 0, 1)
  } = options;
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const moves = [0, 0, 0].map(() => open + (rand() - 0.5) * volatility + drift);
    const close = open + (rand() - 0.5) * volatility + drift;
    const high = Math.max(open, close, ...moves) + rand() * volatility * 0.2;
    const low = Math.min(open, close, ...moves) - rand() * volatility * 0.2;
    price = close;
    const openTime = startTime + i * intervalMsValue;
    candles.push({
      symbol: "R_10",
      interval: "1m",
      openTime,
      closeTime: openTime + intervalMsValue,
      open: Number(open.toFixed(3)),
      high: Number(high.toFixed(3)),
      low: Number(low.toFixed(3)),
      close: Number(close.toFixed(3)),
      tickCount: 30,
      isComplete: true,
      source: "SEED"
    });
  }
  return candles;
}

/** A fully-populated feature snapshot with overridable fields. */
export function featureFixture(overrides: Partial<MarketFeatureSnapshot> = {}): MarketFeatureSnapshot {
  return {
    symbol: "R_10",
    interval: "1m",
    timestamp: Date.UTC(2026, 0, 2),
    close: 1000,
    emaFast: 998,
    emaSlow: 996,
    emaLong: 990,
    emaFastSlope: 0.001,
    emaSlowSlope: 0.0008,
    rsi: 60,
    atr: 2,
    atrPercent: 0.002,
    adx: 30,
    macd: 0.5,
    macdSignal: 0.3,
    macdHistogram: 0.2,
    bollingerUpper: 1005,
    bollingerMiddle: 998,
    bollingerLower: 991,
    bollingerWidth: 0.014,
    priceDistanceFromEma: 0.004,
    recentReturn: 0.003,
    higherHighCount: 3,
    lowerLowCount: 0,
    donchianHigh: 999,
    donchianLow: 985,
    trendDirection: 1,
    volatilityPercentile: 60,
    momentumScore: null,
    trendScore: null,
    rangeScore: null,
    breakoutScore: null,
    ...overrides
  };
}

export function regimeFixture(overrides: Partial<RegimeResult> = {}): RegimeResult {
  return {
    regime: "STRONG_UPTREND",
    confidence: 0.8,
    scores: { trend: 80, momentum: 70, volatility: 55, range: 10, breakout: 60 },
    reasons: ["fixture"],
    timestamp: Date.UTC(2026, 0, 2),
    classifierVersion: "rule-based-1.0.0",
    ...overrides
  };
}
