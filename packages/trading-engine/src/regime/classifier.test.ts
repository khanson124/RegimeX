import { describe, expect, it } from "vitest";
import { RuleBasedRegimeClassifier, DEFAULT_REGIME_THRESHOLDS } from "./classifier.js";
import { featureFixture } from "../testing/fixtures.js";

const classifier = new RuleBasedRegimeClassifier();

describe("RuleBasedRegimeClassifier", () => {
  it("classifies a strong uptrend", () => {
    const result = classifier.classify({
      features: featureFixture({
        emaFast: 1002,
        emaSlow: 998,
        emaLong: 990,
        emaFastSlope: 0.002,
        emaSlowSlope: 0.001,
        adx: 35,
        close: 1005,
        trendDirection: 1,
        higherHighCount: 4,
        donchianHigh: 1010,
        donchianLow: 980,
        recentReturn: 0.004,
        macdHistogram: 0.3
      })
    });
    expect(result.regime).toBe("STRONG_UPTREND");
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.scores.trend).toBeGreaterThanOrEqual(65);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("classifies a strong downtrend (mirrored)", () => {
    const result = classifier.classify({
      features: featureFixture({
        emaFast: 990,
        emaSlow: 995,
        emaLong: 1005,
        emaFastSlope: -0.002,
        emaSlowSlope: -0.001,
        adx: 35,
        close: 985,
        trendDirection: -1,
        higherHighCount: 0,
        lowerLowCount: 4,
        recentReturn: -0.004,
        macdHistogram: -0.3,
        donchianHigh: 1010,
        donchianLow: 980
      })
    });
    expect(result.regime).toBe("STRONG_DOWNTREND");
  });

  it("classifies a low-volatility range", () => {
    const result = classifier.classify({
      features: featureFixture({
        adx: 12,
        emaFastSlope: 0.0001,
        emaSlowSlope: 0.0001,
        trendDirection: 0,
        priceDistanceFromEma: 0.0005,
        higherHighCount: 0,
        lowerLowCount: 0,
        volatilityPercentile: 40,
        bollingerWidth: 0.012,
        recentReturn: 0.0001,
        macdHistogram: 0.001,
        close: 998,
        donchianHigh: 1005,
        donchianLow: 990
      })
    });
    expect(result.regime).toBe("RANGE_LOW_VOLATILITY");
  });

  it("classifies volatility compression", () => {
    const result = classifier.classify({
      features: featureFixture({
        adx: 22,
        emaFastSlope: 0.0002,
        emaSlowSlope: 0.0001,
        trendDirection: 0,
        volatilityPercentile: 10,
        bollingerWidth: 0.005,
        priceDistanceFromEma: 0.001,
        higherHighCount: 1,
        lowerLowCount: 0,
        recentReturn: 0.0002,
        macdHistogram: 0.01,
        close: 998,
        donchianHigh: 1005,
        donchianLow: 990
      })
    });
    expect(result.regime).toBe("VOLATILITY_COMPRESSION");
  });

  it("classifies breakout expansion when price exits the Donchian range with momentum", () => {
    const result = classifier.classify({
      features: featureFixture({
        close: 1015,
        donchianHigh: 1010,
        donchianLow: 980,
        volatilityPercentile: 85,
        bollingerWidth: 0.02,
        macdHistogram: 0.4,
        recentReturn: 0.006,
        adx: 24,
        emaFastSlope: 0.001,
        emaSlowSlope: 0.0008,
        trendDirection: 1
      })
    });
    expect(result.regime).toBe("BREAKOUT_EXPANSION");
  });

  it("caps confidence when indicators are missing", () => {
    const result = classifier.classify({
      features: featureFixture({
        emaFast: null,
        emaSlow: null,
        emaLong: null,
        emaFastSlope: null,
        emaSlowSlope: null,
        rsi: null,
        atr: null,
        atrPercent: null,
        adx: null,
        macdHistogram: null,
        bollingerWidth: null,
        donchianHigh: null,
        donchianLow: null,
        volatilityPercentile: null,
        trendDirection: 0
      })
    });
    expect(result.confidence).toBeLessThanOrEqual(DEFAULT_REGIME_THRESHOLDS.lowDataConfidenceCap);
    expect(result.regime).toBe("UNKNOWN");
  });

  it("is deterministic for identical input", () => {
    const features = featureFixture();
    const a = classifier.classify({ features });
    const b = classifier.classify({ features });
    expect(a).toEqual(b);
  });
});
