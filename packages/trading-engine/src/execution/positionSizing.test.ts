import { describe, expect, it } from "vitest";
import { DefaultPositionSizingService } from "./positionSizing.js";
import { type InstrumentMetadata } from "@regimex/shared";

const instrument: InstrumentMetadata = {
  symbol: "TEST",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  tickSize: 0.01,
  tickValue: 1,
  marginRate: 0.01,
  spreadBps: 8,
  slippageBps: 3,
  pricePrecision: 2,
  currency: "USD"
};

describe("DefaultPositionSizingService", () => {
  const sizing = new DefaultPositionSizingService();

  it("fails closed when instrument metadata is disabled", () => {
    const result = sizing.calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 99,
      riskPerTradePercent: 0.5,
      instrument: { ...instrument, enabled: false }
    });
    expect(result.success).toBe(false);
    expect(result.volume).toBeNull();
  });

  it("sizes volume from equity risk and stop distance", () => {
    const result = sizing.calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 99,
      riskPerTradePercent: 0.5,
      instrument
    });
    expect(result.success).toBe(true);
    expect(result.riskAmount).toBe(50);
    expect(result.volume).toBe(0.5);
    expect(result.lossAtStop).toBeLessThanOrEqual(50.01);
  });

  it("rejects when stop is on the wrong side", () => {
    const result = sizing.calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 101,
      riskPerTradePercent: 0.5,
      instrument
    });
    expect(result.success).toBe(false);
  });

  it("calculateRaw does not raise or reject at broker minVolume", () => {
    const raw = sizing.calculateRaw({
      equity: 10,
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 99,
      riskPerTradePercent: 0.5,
      instrument
    });
    expect(raw.success).toBe(true);
    expect(raw.rawVolume).not.toBeNull();
    expect(raw.rawVolume!).toBeLessThan(instrument.minVolume);
    const clamped = sizing.calculate({
      equity: 10,
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 99,
      riskPerTradePercent: 0.5,
      instrument
    });
    expect(clamped.success).toBe(false);
  });
});
