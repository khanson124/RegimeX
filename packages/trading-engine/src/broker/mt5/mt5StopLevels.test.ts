import { describe, expect, it } from "vitest";
import {
  MT5_INVALID_STOP_DISTANCE_PRECHECK,
  MT5_STOP_METADATA_UNAVAILABLE,
  isPriceInFreezeLevel,
  normalizeStopPriceToTick,
  resolveMinimumStopDistance,
  validateAndNormalizeMt5Stops
} from "./mt5StopLevels.js";

const base = {
  point: 0.001,
  tickSize: 0.001,
  digits: 3,
  stopsLevel: 50,
  freezeLevel: 10,
  bid: 4783.0,
  ask: 4783.5
};

describe("validateAndNormalizeMt5Stops", () => {
  it("SELL with SL too close fails closed", () => {
    // minDist = 50 * 0.001 = 0.05; Ask=4783.5 → SL must be >= 4783.55
    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "SELL",
      stopLoss: 4783.52,
      takeProfit: 4780.0
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_INVALID_STOP_DISTANCE_PRECHECK);
    expect(result.minimumStopDistance).toBeCloseTo(0.05);
  });

  it("SELL with TP too close fails closed", () => {
    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "SELL",
      stopLoss: 4790.0,
      takeProfit: 4783.48 // Ask - 0.02 < 0.05
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_INVALID_STOP_DISTANCE_PRECHECK);
  });

  it("BUY with SL too close fails closed", () => {
    // Bid=4783 → SL must be <= 4782.95
    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "BUY",
      stopLoss: 4782.98,
      takeProfit: 4790.0
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_INVALID_STOP_DISTANCE_PRECHECK);
  });

  it("BUY with TP too close fails closed", () => {
    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "BUY",
      stopLoss: 4780.0,
      takeProfit: 4783.02
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_INVALID_STOP_DISTANCE_PRECHECK);
  });

  it("valid SELL stops pass with live Ask reference", () => {
    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "SELL",
      stopLoss: 4790.0,
      takeProfit: 4770.0
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedStopLoss).toBe(4790);
    expect(result.normalizedTakeProfit).toBe(4770);
    expect(result.referencePrice).toBe(base.ask);
    expect(result.stopDistanceFromMarket!).toBeGreaterThanOrEqual(result.minimumStopDistance!);
    expect(result.targetDistanceFromMarket!).toBeGreaterThanOrEqual(result.minimumStopDistance!);
  });

  it("valid BUY stops pass with live Bid reference", () => {
    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "BUY",
      stopLoss: 4770.0,
      takeProfit: 4790.0
    });
    expect(result.ok).toBe(true);
    expect(result.referencePrice).toBe(base.bid);
  });

  it("tick-size normalization rounds protectively without arbitrary widening beyond tick", () => {
    const rounded = normalizeStopPriceToTick({
      price: 4783.5127,
      tickSize: 0.001,
      digits: 3,
      direction: "SELL",
      kind: "stopLoss"
    });
    expect(rounded).toBe(4783.513);

    const result = validateAndNormalizeMt5Stops({
      ...base,
      direction: "SELL",
      stopLoss: 4790.0004,
      takeProfit: 4770.0004
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedStopLoss).toBe(4790.001);
    expect(result.normalizedTakeProfit).toBe(4770);
  });

  it("price movement between signal and submission: stale entry-valid SL fails vs live Ask", () => {
    // Strategy sized SL from entry ~4780; market moved Ask to 4789.96 so SL 4790 is only 0.04 away
    const result = validateAndNormalizeMt5Stops({
      ...base,
      bid: 4789.5,
      ask: 4789.96,
      direction: "SELL",
      stopLoss: 4790.0,
      takeProfit: 4770.0
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_INVALID_STOP_DISTANCE_PRECHECK);
  });

  it("fail-closed when stop metadata is unavailable", () => {
    const missing = validateAndNormalizeMt5Stops({
      direction: "SELL",
      stopLoss: 4790,
      takeProfit: 4770,
      bid: 4783,
      ask: 4783.5,
      point: 0.001,
      tickSize: 0.001,
      digits: 3,
      stopsLevel: null
    });
    expect(missing.ok).toBe(false);
    expect(missing.reasonCode).toBe(MT5_STOP_METADATA_UNAVAILABLE);

    const missingPoint = validateAndNormalizeMt5Stops({
      direction: "BUY",
      stopLoss: 4770,
      takeProfit: 4790,
      bid: 4783,
      ask: 4783.5,
      point: undefined,
      tickSize: 0.001,
      digits: 3,
      stopsLevel: 0
    });
    expect(missingPoint.ok).toBe(false);
    expect(missingPoint.reasonCode).toBe(MT5_STOP_METADATA_UNAVAILABLE);
  });

  it("stopsLevel == 0 allows any correct-side distance", () => {
    const result = validateAndNormalizeMt5Stops({
      ...base,
      stopsLevel: 0,
      direction: "SELL",
      stopLoss: 4783.501, // just above Ask
      takeProfit: 4783.499 // just below Ask
    });
    expect(result.ok).toBe(true);
    expect(result.minimumStopDistance).toBe(0);
  });

  it("stopsLevel == 0 still rejects wrong-side stops", () => {
    const result = validateAndNormalizeMt5Stops({
      ...base,
      stopsLevel: 0,
      direction: "SELL",
      stopLoss: 4780, // below Ask — invalid
      takeProfit: 4790
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_INVALID_STOP_DISTANCE_PRECHECK);
  });
});

describe("resolveMinimumStopDistance / freeze level", () => {
  it("computes minimumStopDistance = stopsLevel * point", () => {
    expect(resolveMinimumStopDistance(50, 0.001)).toBeCloseTo(0.05);
    expect(resolveMinimumStopDistance(0, 0.001)).toBe(0);
  });

  it("detects price inside freeze level for modify protection", () => {
    expect(
      isPriceInFreezeLevel({
        marketPrice: 4783.005,
        stopLoss: 4783.0,
        takeProfit: 4790,
        freezeLevel: 10,
        point: 0.001
      })
    ).toBe(true);
    expect(
      isPriceInFreezeLevel({
        marketPrice: 4785,
        stopLoss: 4780,
        takeProfit: 4790,
        freezeLevel: 10,
        point: 0.001
      })
    ).toBe(false);
  });
});
