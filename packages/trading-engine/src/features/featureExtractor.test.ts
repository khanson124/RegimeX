import { describe, expect, it } from "vitest";
import { extractFeatures, minimumCandlesForFeatures, DEFAULT_FEATURE_CONFIG } from "./featureExtractor.js";
import { syntheticCandles } from "../testing/fixtures.js";

describe("extractFeatures", () => {
  it("returns nulls during warmup and values after", () => {
    const candles = syntheticCandles({ count: 200, seed: 2 });
    const features = extractFeatures(candles);
    const warmup = minimumCandlesForFeatures(DEFAULT_FEATURE_CONFIG);
    expect(features[5]!.emaLong).toBeNull();
    const late = features[warmup + 10]!;
    expect(late.emaFast).not.toBeNull();
    expect(late.emaSlow).not.toBeNull();
    expect(late.emaLong).not.toBeNull();
    expect(late.rsi).not.toBeNull();
    expect(late.atr).not.toBeNull();
    expect(late.adx).not.toBeNull();
    expect(late.bollingerWidth).not.toBeNull();
    expect(late.donchianHigh).not.toBeNull();
  });

  it("has no look-ahead: features unchanged when future candles change", () => {
    const base = syntheticCandles({ count: 300, seed: 9 });
    const mutated = base.map((c, i) => (i >= 250 ? { ...c, close: c.close * 3, high: c.high * 3 } : c));
    const a = extractFeatures(base).slice(0, 250);
    const b = extractFeatures(mutated).slice(0, 250);
    // Volatility percentile uses a trailing window that includes index 250+ only
    // for later snapshots, so the first 250 must be strictly identical.
    expect(b).toEqual(a);
  });

  it("aligns timestamps with candle close times", () => {
    const candles = syntheticCandles({ count: 10, seed: 4 });
    const features = extractFeatures(candles);
    expect(features[3]!.timestamp).toBe(candles[3]!.closeTime);
  });
});
