import { describe, expect, it } from "vitest";
import { CFD_INTRABAR_POLICY } from "@regimex/shared";
import { BarCfdPositionSimulator } from "./cfdSimulator.js";
import { type InstrumentMetadata } from "@regimex/shared";

const instrument: InstrumentMetadata = {
  symbol: "TEST",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  tickSize: 1,
  tickValue: 1,
  marginRate: 0.01,
  spreadBps: 10,
  slippageBps: 5,
  pricePrecision: 0,
  currency: "USD"
};

describe("BarCfdPositionSimulator", () => {
  const sim = new BarCfdPositionSimulator();

  it("uses STOP_LOSS_FIRST when both SL and TP are reachable on one bar", () => {
    const result = sim.simulate({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      volume: 1,
      instrument,
      spreadBps: 0,
      slippageBps: 0,
      bars: [{ open: 100, high: 112, low: 94, close: 101 }]
    });
    expect(result.intrabarPolicy).toBe(CFD_INTRABAR_POLICY);
    expect(result.closeReason).toBe("STOP_LOSS");
    expect(result.exitTriggerPrice).toBe(95);
    expect(result.exitPrice).toBe(95);
  });

  it("closes on take-profit when only TP is touched", () => {
    const result = sim.simulate({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 90,
      takeProfit: 105,
      volume: 1,
      instrument,
      spreadBps: 0,
      slippageBps: 0,
      bars: [{ open: 100, high: 106, low: 99, close: 104 }]
    });
    expect(result.closeReason).toBe("TAKE_PROFIT");
    expect(result.exitTriggerPrice).toBe(105);
    expect(result.exitPrice).toBe(105);
  });

  it("applies exit half-spread + slip to netPnl but not grossPnl", () => {
    const result = sim.simulate({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 90,
      takeProfit: 110,
      volume: 1,
      instrument: { ...instrument, tickSize: 1, tickValue: 1, spreadBps: 200, slippageBps: 0 },
      spreadBps: 200,
      slippageBps: 0,
      bars: [{ open: 100, high: 112, low: 99, close: 110 }]
    });
    // mid TP=110; half spread = 110*0.02/2 = 1.1 → exit fill 108.9
    expect(result.closeReason).toBe("TAKE_PROFIT");
    expect(result.grossPnl).toBe(10);
    expect(result.exitPrice).toBeCloseTo(108.9, 5);
    expect(result.netPnl).toBeCloseTo(8.9, 5);
    expect(result.grossR).toBe(1);
    expect(result.netR).toBeCloseTo(0.89, 2);
  });
});
