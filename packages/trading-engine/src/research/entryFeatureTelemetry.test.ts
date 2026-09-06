import { describe, expect, it } from "vitest";
import {
  buildEntryFeatureTelemetry,
  isEntryFeatureTelemetryJsonSafe,
  type EntryFeatureTelemetry
} from "./entryFeatureTelemetry.js";
import { type Candle, type MarketFeatureSnapshot, type StrategyDecision } from "@regimex/shared";

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
    tickCount: 40,
    isComplete: true,
    source: "SEED"
  };
}

function feature(overrides: Partial<MarketFeatureSnapshot> = {}): MarketFeatureSnapshot {
  return {
    symbol: "R_10",
    interval: "1m",
    timestamp: 1_000,
    close: 4785.9,
    emaFast: 4785.0,
    emaSlow: 4783.5,
    emaLong: 4780.0,
    emaFastSlope: 0.002,
    emaSlowSlope: 0.001,
    rsi: 48,
    atr: 1.2,
    atrPercent: 0.00025,
    adx: 26,
    macd: 0.1,
    macdSignal: 0.05,
    macdHistogram: 0.05,
    bollingerUpper: 4790,
    bollingerMiddle: 4785,
    bollingerLower: 4780,
    bollingerWidth: 0.002,
    priceDistanceFromEma: 0.0005,
    recentReturn: 0.0001,
    higherHighCount: 3,
    lowerLowCount: 1,
    donchianHigh: 4792,
    donchianLow: 4778,
    trendDirection: 1,
    volatilityPercentile: 40,
    momentumScore: null,
    trendScore: null,
    rangeScore: null,
    breakoutScore: null,
    ...overrides
  };
}

function decision(
  action: "BUY" | "SELL",
  metadata: Record<string, unknown> = {}
): StrategyDecision {
  return {
    action,
    confidence: 0.7,
    entryReason: ["test"],
    invalidationReason: [],
    proposedStake: null,
    expiryDuration: 5,
    expiryUnit: "m",
    signalTimestamp: 5_000,
    strategyId: "ema-pullback-v1",
    strategyVersion: "1",
    metadata: {
      pullbackEma: "fast",
      pullbackLow: 4784.5,
      pullbackHigh: 4787.2,
      targetEma: 4785.0,
      ...metadata
    }
  };
}

describe("buildEntryFeatureTelemetry", () => {
  it("populates BUY telemetry with ATR-normalized EMA distances and pullback depth", () => {
    const closeTime = 5_000;
    const tel = buildEntryFeatureTelemetry({
      feature: feature({ timestamp: closeTime }),
      candle: candle(closeTime, { o: 4785.2, h: 4786.5, l: 4784.4, c: 4785.9 }),
      decision: decision("BUY"),
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.81,
      symbol: "R_10",
      interval: "1m"
    });

    expect(tel.direction).toBe("BUY");
    expect(tel.strategyId).toBe("ema-pullback-v1");
    expect(tel.symbol).toBe("R_10");
    expect(tel.interval).toBe("1m");
    expect(tel.regime).toBe("STRONG_UPTREND");
    expect(tel.strategyConfidence).toBe(0.7);
    expect(tel.regimeConfidence).toBe(0.81);
    expect(tel.timestamp).toBe(closeTime);
    expect(tel.rsi).toBe(48);
    expect(tel.adx).toBe(26);
    expect(tel.atr).toBe(1.2);
    expect(tel.fastEmaSlope).toBe(0.002);
    expect(tel.priceDistanceFromFastEmaAtr).not.toBeNull();
    expect(tel.priceDistanceFromSlowEmaAtr).not.toBeNull();
    expect(tel.priceDistanceFromLongEmaAtr).not.toBeNull();
    expect(tel.pullbackDepthAtr).not.toBeNull();
    expect(tel.priceAboveFastEma).toBe(true);
    expect(tel.emaStackBullish).toBe(true);
    expect(tel.emaStackBearish).toBe(false);
    expect(tel.rejectionWickBodyRatio).not.toBeNull();
    expect(tel.higherHighCount).toBe(3);
    expect(isEntryFeatureTelemetryJsonSafe(tel)).toBe(true);
  });

  it("populates SELL telemetry with mirrored rejection wick and bearish stack flags", () => {
    const tel = buildEntryFeatureTelemetry({
      feature: feature({
        emaFast: 4786,
        emaSlow: 4788,
        emaLong: 4790,
        trendDirection: -1,
        higherHighCount: 0,
        lowerLowCount: 4
      }),
      candle: candle(6_000, { o: 4786.5, h: 4787.8, l: 4785.0, c: 4785.5 }),
      decision: decision("SELL", { pullbackHigh: 4787.5, pullbackLow: 4784.0, targetEma: 4786 }),
      regime: "STRONG_DOWNTREND",
      regimeConfidence: 0.77
    });

    expect(tel.direction).toBe("SELL");
    expect(tel.priceAboveFastEma).toBe(false);
    expect(tel.emaStackBearish).toBe(true);
    expect(tel.emaStackBullish).toBe(false);
    expect(tel.rejectionWickSize).toBeGreaterThan(0);
    expect(tel.lowerLowCount).toBe(4);
    expect(tel.pullbackDepth).not.toBeNull();
  });

  it("does not throw when optional indicators are missing", () => {
    const tel = buildEntryFeatureTelemetry({
      feature: feature({
        emaFast: null,
        emaSlow: null,
        emaLong: null,
        emaFastSlope: null,
        emaSlowSlope: null,
        rsi: null,
        atr: null,
        atrPercent: null,
        adx: null,
        donchianHigh: null,
        donchianLow: null
      }),
      candle: candle(7_000, { o: 100, h: 101, l: 99, c: 100.5 }),
      decision: {
        ...decision("BUY"),
        metadata: {}
      },
      regime: "TRANSITION",
      regimeConfidence: 0.2
    });

    expect(tel.rsi).toBeNull();
    expect(tel.adx).toBeNull();
    expect(tel.atr).toBeNull();
    expect(tel.priceDistanceFromFastEmaAtr).toBeNull();
    expect(tel.pullbackDepthAtr).toBeNull();
    expect(tel.emaStackBullish).toBeNull();
    expect(tel.priceAboveFastEma).toBeNull();
    expect(isEntryFeatureTelemetryJsonSafe(tel)).toBe(true);
  });

  it("serialized metadata remains valid compact JSON without candle arrays", () => {
    const tel = buildEntryFeatureTelemetry({
      feature: feature(),
      candle: candle(8_000, { o: 4785, h: 4786, l: 4784, c: 4785.5 }),
      decision: decision("BUY"),
      regime: "WEAK_UPTREND",
      regimeConfidence: 0.6
    });
    const json = JSON.stringify({ entryFeatureTelemetry: tel });
    const parsed = JSON.parse(json) as { entryFeatureTelemetry: EntryFeatureTelemetry };
    expect(parsed.entryFeatureTelemetry.fastEmaSlope).toBe(tel.fastEmaSlope);
    expect(json).not.toContain("candles");
    expect(Object.keys(parsed.entryFeatureTelemetry).length).toBeGreaterThan(20);
  });

  it("is a pure function — identical inputs yield identical telemetry (no trade decision side effects)", () => {
    const input = {
      feature: feature(),
      candle: candle(9_000, { o: 4785, h: 4786, l: 4784, c: 4785.2 }),
      decision: decision("BUY"),
      regime: "STRONG_UPTREND" as const,
      regimeConfidence: 0.9
    };
    const a = buildEntryFeatureTelemetry(input);
    const b = buildEntryFeatureTelemetry(input);
    expect(a).toEqual(b);
    expect(input.decision.action).toBe("BUY");
    expect(input.decision.confidence).toBe(0.7);
  });
});
