import { CFD_SIMULATOR_VERSION } from "@regimex/shared";
import { describe, expect, it } from "vitest";
import {
  assertEntrySnapshotNoLookahead,
  buildCfdTradeEntryFeatureSnapshot
} from "./cfdTradeEntrySnapshot.js";
import { type Candle } from "@regimex/shared";
import { type MarketFeatureSnapshot } from "@regimex/shared";

function candle(closeTime: number, ohlc: { o: number; h: number; l: number; c: number }): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: closeTime - 60_000,
    closeTime,
    open: ohlc.o,
    high: ohlc.h,
    low: ohlc.l,
    close: ohlc.c,
    tickCount: 42,
    isComplete: true,
    source: "SEED"
  };
}

function feature(overrides: Partial<MarketFeatureSnapshot> = {}): MarketFeatureSnapshot {
  return {
    symbol: "R_10",
    interval: "1m",
    timestamp: 1_000,
    close: 100,
    emaFast: 99.5,
    emaSlow: 98,
    emaLong: 97,
    emaFastSlope: 0.001,
    emaSlowSlope: 0.0005,
    rsi: 45,
    atr: 0.5,
    atrPercent: 0.005,
    adx: 28,
    macd: 0.1,
    macdSignal: 0.05,
    macdHistogram: 0.05,
    bollingerUpper: 101,
    bollingerMiddle: 100,
    bollingerLower: 99,
    bollingerWidth: 0.02,
    priceDistanceFromEma: 0.002,
    recentReturn: 0.001,
    higherHighCount: 2,
    lowerLowCount: 1,
    donchianHigh: 102,
    donchianLow: 98,
    trendDirection: 1,
    volatilityPercentile: 55,
    momentumScore: null,
    trendScore: null,
    rangeScore: null,
    breakoutScore: null,
    ...overrides
  };
}

describe("buildCfdTradeEntryFeatureSnapshot", () => {
  it("uses only decision-time candle and feature fields", () => {
    const closeTime = 5_000;
    const snap = buildCfdTradeEntryFeatureSnapshot({
      feature: feature({ timestamp: closeTime }),
      candle: candle(closeTime, { o: 99.8, h: 100.2, l: 99.2, c: 100 }),
      decision: {
        action: "BUY",
        confidence: 0.72,
        entryReason: ["test"],
        invalidationReason: [],
        proposedStake: null,
        expiryDuration: 5,
        expiryUnit: "m",
        signalTimestamp: closeTime,
        strategyId: "ema-pullback-v1",
        strategyVersion: "1",
        metadata: { targetEma: 99.5, pullbackLow: 99.1, pullbackHigh: 100.2 }
      },
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.82
    });

    expect(snap.timestamp).toBe(closeTime);
    expect(snap.strategyId).toBe("ema-pullback-v1");
    expect(snap.action).toBe("BUY");
    expect(snap.regime).toBe("STRONG_UPTREND");
    expect(snap.tickCount).toBe(42);
    expect(snap.pullbackDepth).toBeGreaterThan(0);
    expect(snap.rejectionWickBodyRatio).not.toBeNull();
    expect(() => assertEntrySnapshotNoLookahead(closeTime, snap)).not.toThrow();
    expect(() => assertEntrySnapshotNoLookahead(closeTime - 1, snap)).toThrow();
  });

  it("computes bollinger position for mean-reversion context", () => {
    const snap = buildCfdTradeEntryFeatureSnapshot({
      feature: feature(),
      candle: candle(2_000, { o: 99.5, h: 100.5, l: 98.5, c: 99 }),
      decision: {
        action: "BUY",
        confidence: 0.68,
        entryReason: [],
        invalidationReason: [],
        proposedStake: null,
        expiryDuration: 5,
        expiryUnit: "m",
        signalTimestamp: 2_000,
        strategyId: "bollinger-reversion-v1",
        strategyVersion: "1",
        metadata: {}
      },
      regime: "RANGE_LOW_VOLATILITY",
      regimeConfidence: 0.7
    });

    expect(snap.bollingerPosition).toBeLessThan(0);
    expect(snap.distanceFromMean).not.toBeNull();
  });
});
