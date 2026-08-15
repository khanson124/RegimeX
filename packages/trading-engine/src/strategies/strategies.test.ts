import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "./breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "./emaPullback.js";
import { BollingerReversionStrategy, BOLLINGER_REVERSION_DEFAULTS } from "./bollingerReversion.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "./squeezeBreakout.js";
import { featureFixture, regimeFixture } from "../testing/fixtures.js";
import { type StrategyContext } from "./types.js";

function candleFixture(overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: Date.UTC(2026, 0, 2),
    closeTime: Date.UTC(2026, 0, 2) + 60_000,
    open: 1000,
    high: 1002,
    low: 999,
    close: 1001,
    tickCount: 30,
    isComplete: true,
    source: "SEED",
    ...overrides
  };
}

function contextOf(
  candles: Candle[],
  features: ReturnType<typeof featureFixture>[],
  parameters: Record<string, number | boolean | string>,
  regimeOverrides = {}
): StrategyContext {
  return {
    candles,
    features,
    regime: regimeFixture(regimeOverrides),
    parameters,
    candlesSinceLastSignal: Number.POSITIVE_INFINITY
  };
}

describe("BreakoutMomentumStrategy", () => {
  const strategy = new BreakoutMomentumStrategy();

  it("signals BUY on a confirmed upside breakout", () => {
    const f = featureFixture({
      close: 1011,
      donchianHigh: 1010,
      donchianLow: 980,
      emaFast: 1008,
      emaSlow: 1004,
      emaFastSlope: 0.002,
      emaSlowSlope: 0.001,
      adx: 30,
      macdHistogram: 0.4,
      volatilityPercentile: 60,
      priceDistanceFromEma: 0.005
    });
    const decision = strategy.evaluate(
      contextOf([candleFixture({ close: 1011 })], [f], BREAKOUT_MOMENTUM_DEFAULTS)
    );
    expect(decision.action).toBe("BUY");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.6);
    expect(decision.entryReason.length).toBeGreaterThan(0);
  });

  it("signals SELL on the mirrored downside breakout", () => {
    const f = featureFixture({
      close: 979,
      donchianHigh: 1010,
      donchianLow: 980,
      emaFast: 984,
      emaSlow: 990,
      emaFastSlope: -0.002,
      emaSlowSlope: -0.001,
      adx: 30,
      macdHistogram: -0.4,
      volatilityPercentile: 60,
      priceDistanceFromEma: -0.005,
      trendDirection: -1
    });
    const decision = strategy.evaluate(
      contextOf([candleFixture({ close: 979 })], [f], BREAKOUT_MOMENTUM_DEFAULTS)
    );
    expect(decision.action).toBe("SELL");
  });

  it("holds when ADX is below threshold", () => {
    const f = featureFixture({ close: 1011, donchianHigh: 1010, adx: 15 });
    const decision = strategy.evaluate(
      contextOf([candleFixture({ close: 1011 })], [f], BREAKOUT_MOMENTUM_DEFAULTS)
    );
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toContain("ADX");
  });

  it("holds when price is excessively extended from the EMA", () => {
    const f = featureFixture({
      close: 1011,
      donchianHigh: 1010,
      adx: 30,
      priceDistanceFromEma: 0.05
    });
    const decision = strategy.evaluate(
      contextOf([candleFixture({ close: 1011 })], [f], BREAKOUT_MOMENTUM_DEFAULTS)
    );
    expect(decision.action).toBe("HOLD");
  });

  it("holds during cooldown", () => {
    const f = featureFixture({ close: 1011, donchianHigh: 1010 });
    const ctx = { ...contextOf([candleFixture()], [f], BREAKOUT_MOMENTUM_DEFAULTS), candlesSinceLastSignal: 1 };
    expect(strategy.evaluate(ctx).action).toBe("HOLD");
  });
});

describe("EmaPullbackStrategy", () => {
  const strategy = new EmaPullbackStrategy();

  it("signals BUY on a bullish rejection at the fast EMA in an uptrend", () => {
    const emaFast = 1000;
    const candle = candleFixture({ open: 1000.2, high: 1001.5, low: 999.2, close: 1001.2 });
    const f = featureFixture({
      emaFast,
      emaSlow: 996,
      emaLong: 990,
      rsi: 48,
      adx: 25,
      trendDirection: 1,
      close: candle.close
    });
    const decision = strategy.evaluate(contextOf([candle], [f], EMA_PULLBACK_DEFAULTS));
    expect(decision.action).toBe("BUY");
    expect(decision.entryReason.join(" ")).toContain("Pullback");
  });

  it("holds when there is no trend", () => {
    const f = featureFixture({ trendDirection: 0 });
    const decision = strategy.evaluate(contextOf([candleFixture()], [f], EMA_PULLBACK_DEFAULTS));
    expect(decision.action).toBe("HOLD");
  });
});

describe("BollingerReversionStrategy", () => {
  const strategy = new BollingerReversionStrategy();

  function rangeSetup(): { candles: Candle[]; features: ReturnType<typeof featureFixture>[] } {
    // Previous candle pierces the lower band; current closes back inside.
    const prev = candleFixture({ open: 993, high: 994, low: 989.5, close: 990.4 });
    const curr = candleFixture({ open: 990.4, high: 993, low: 990, close: 992.5 });
    const fPrev = featureFixture({
      bollingerUpper: 1006,
      bollingerLower: 991,
      bollingerMiddle: 998,
      bollingerWidth: 0.012,
      adx: 15,
      rsi: 25,
      close: prev.close,
      trendDirection: 0,
      donchianHigh: 1008,
      donchianLow: 985
    });
    const fCurr = featureFixture({
      bollingerUpper: 1006,
      bollingerLower: 991,
      bollingerMiddle: 998,
      bollingerWidth: 0.012,
      adx: 15,
      rsi: 32,
      close: curr.close,
      trendDirection: 0,
      donchianHigh: 1008,
      donchianLow: 985
    });
    return { candles: [prev, curr], features: [fPrev, fCurr] };
  }

  it("signals BUY on lower-band rejection in a range", () => {
    const { candles, features } = rangeSetup();
    const decision = strategy.evaluate({
      candles,
      features,
      regime: regimeFixture({ regime: "RANGE_LOW_VOLATILITY" }),
      parameters: BOLLINGER_REVERSION_DEFAULTS,
      candlesSinceLastSignal: Number.POSITIVE_INFINITY
    });
    expect(decision.action).toBe("BUY");
  });

  it("holds when ADX indicates a trend", () => {
    const { candles, features } = rangeSetup();
    features[1] = { ...features[1]!, adx: 35 };
    const decision = strategy.evaluate({
      candles,
      features,
      regime: regimeFixture({ regime: "RANGE_LOW_VOLATILITY" }),
      parameters: BOLLINGER_REVERSION_DEFAULTS,
      candlesSinceLastSignal: Number.POSITIVE_INFINITY
    });
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toContain("ADX");
  });

  it("holds when price is breaking the recent range", () => {
    const { candles, features } = rangeSetup();
    features[1] = { ...features[1]!, close: 984, donchianLow: 985 };
    const decision = strategy.evaluate({
      candles: [candles[0]!, { ...candles[1]!, close: 984 }],
      features,
      regime: regimeFixture({ regime: "RANGE_LOW_VOLATILITY" }),
      parameters: BOLLINGER_REVERSION_DEFAULTS,
      candlesSinceLastSignal: Number.POSITIVE_INFINITY
    });
    expect(decision.action).toBe("HOLD");
  });
});

describe("SqueezeBreakoutStrategy", () => {
  const strategy = new SqueezeBreakoutStrategy();

  it("signals BUY when a squeeze resolves upward with momentum", () => {
    // 10 squeeze candles then a breakout candle.
    const candles: Candle[] = [];
    const features: ReturnType<typeof featureFixture>[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candleFixture({ close: 1000 }));
      features.push(
        featureFixture({
          bollingerWidth: 0.005,
          volatilityPercentile: 15,
          donchianHigh: 1004,
          donchianLow: 996,
          close: 1000,
          recentReturn: 0.0001,
          atrPercent: 0.001
        })
      );
    }
    candles.push(candleFixture({ close: 1006 }));
    features.push(
      featureFixture({
        bollingerWidth: 0.009,
        volatilityPercentile: 55,
        donchianHigh: 1004,
        donchianLow: 996,
        close: 1006,
        recentReturn: 0.004,
        atrPercent: 0.002
      })
    );
    const decision = strategy.evaluate({
      candles,
      features,
      regime: regimeFixture({ regime: "BREAKOUT_EXPANSION" }),
      parameters: SQUEEZE_BREAKOUT_DEFAULTS,
      candlesSinceLastSignal: Number.POSITIVE_INFINITY
    });
    expect(decision.action).toBe("BUY");
  });

  it("holds when momentum does not confirm (weak breakout)", () => {
    const candles: Candle[] = [];
    const features: ReturnType<typeof featureFixture>[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(candleFixture({ close: 1000 }));
      features.push(
        featureFixture({
          bollingerWidth: 0.005,
          volatilityPercentile: 15,
          donchianHigh: 1004,
          donchianLow: 996,
          close: 1000,
          recentReturn: 0.0001
        })
      );
    }
    candles.push(candleFixture({ close: 1006 }));
    features.push(
      featureFixture({
        bollingerWidth: 0.009,
        donchianHigh: 1004,
        donchianLow: 996,
        close: 1006,
        recentReturn: 0.0001, // below minBreakoutReturn
        volatilityPercentile: 55
      })
    );
    const decision = strategy.evaluate({
      candles,
      features,
      regime: regimeFixture({ regime: "BREAKOUT_EXPANSION" }),
      parameters: SQUEEZE_BREAKOUT_DEFAULTS,
      candlesSinceLastSignal: Number.POSITIVE_INFINITY
    });
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toContain("momentum");
  });
});
