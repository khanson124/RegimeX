import { describe, expect, it } from "vitest";
import { applyStopLossDistanceOverride } from "./traderOverrides.js";

describe("applyStopLossDistanceOverride", () => {
  it("leaves strategy SL when override is null", () => {
    const r = applyStopLossDistanceOverride({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 99,
      stopLossDistanceOverride: null
    });
    expect(r).toEqual({ stopLoss: 99, applied: false, distance: null });
  });

  it("BUY places SL below entry by override distance", () => {
    const r = applyStopLossDistanceOverride({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 99,
      stopLossDistanceOverride: 1.5
    });
    expect(r).toEqual({ stopLoss: 98.5, applied: true, distance: 1.5 });
  });

  it("SELL places SL above entry by override distance", () => {
    const r = applyStopLossDistanceOverride({
      direction: "SELL",
      entryPrice: 100,
      stopLoss: 101,
      stopLossDistanceOverride: 2
    });
    expect(r).toEqual({ stopLoss: 102, applied: true, distance: 2 });
  });
});
