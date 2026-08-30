import { describe, expect, it } from "vitest";
import { DefaultPositionSizingService } from "../../execution/positionSizing.js";
import type { InstrumentMetadata } from "@regimex/shared";
import {
  MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED,
  MT5_BROKER_STOP_SAFETY_TICKS,
  adaptMt5BrokerStops
} from "./mt5BrokerStopAdaptation.js";
import {
  MT5_INVALID_STOP_DISTANCE_PRECHECK,
  MT5_STOP_METADATA_UNAVAILABLE,
  normalizeStopPriceToTick
} from "./mt5StopLevels.js";
import { MIN_VOLUME_EXCEEDS_RISK, resolveMt5EngineVolume } from "./engineVolume.js";

/** Live Volatility 10 Index-like metadata from the incident. */
const v10 = {
  point: 0.001,
  tickSize: 0.001,
  digits: 3,
  stopsLevel: 720,
  freezeLevel: 0,
  bid: 4771.0,
  ask: 4771.2
};

const instrument: InstrumentMetadata = {
  symbol: "Volatility 10 Index",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.5,
  maxVolume: 100,
  tickSize: 0.001,
  tickValue: 0.001,
  marginRate: 0.01,
  spreadBps: 0,
  slippageBps: 0,
  pricePrecision: 3,
  currency: "USD"
};

describe("adaptMt5BrokerStops", () => {
  it("1. SELL technical stop already valid → unchanged (tick-normalize only)", () => {
    const stopLoss = 4772.5; // ~1.3 above Ask — well past 0.720
    const takeProfit = 4768.6;
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss,
      takeProfit,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(result.brokerAdjusted).toBe(false);
    expect(result.adjustedStopLoss).toBe(
      normalizeStopPriceToTick({
        price: stopLoss,
        tickSize: v10.tickSize,
        digits: v10.digits,
        direction: "SELL",
        kind: "stopLoss"
      })
    );
    expect(result.adjustedTakeProfit).toBe(
      normalizeStopPriceToTick({
        price: takeProfit,
        tickSize: v10.tickSize,
        digits: v10.digits,
        direction: "SELL",
        kind: "takeProfit"
      })
    );
  });

  it("2. BUY technical stop already valid → unchanged", () => {
    const stopLoss = 4769.5;
    const takeProfit = 4774.0;
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "BUY",
      stopLoss,
      takeProfit,
      entryPrice: v10.bid,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(result.brokerAdjusted).toBe(false);
    expect(result.adjustedStopLoss).toBeCloseTo(stopLoss, 3);
  });

  it("3. SELL stop too close → widened to broker minimum + safety tick", () => {
    // Technical SL ~0.354 from Ask (incident-like); min = 0.720
    const stopLoss = 4771.554;
    const takeProfit = 4770.492;
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss,
      takeProfit,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(result.brokerAdjusted).toBe(true);
    expect(result.minimumStopDistance).toBeCloseTo(0.72, 6);
    expect(result.safetyBuffer).toBeCloseTo(MT5_BROKER_STOP_SAFETY_TICKS * v10.tickSize, 6);
    expect(result.adjustedStopLoss!).toBeGreaterThanOrEqual(v10.ask + 0.72);
    expect(result.adjustedStopLoss! - v10.ask).toBeGreaterThanOrEqual(0.72 + v10.tickSize - 1e-9);
    expect(result.adjustedStopLoss!).toBeGreaterThan(stopLoss);
  });

  it("4. BUY stop too close → widened correctly (lower SL)", () => {
    const stopLoss = 4770.8; // only 0.2 below Bid
    const takeProfit = 4771.4;
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "BUY",
      stopLoss,
      takeProfit,
      entryPrice: v10.bid,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(result.brokerAdjusted).toBe(true);
    expect(result.adjustedStopLoss!).toBeLessThanOrEqual(v10.bid - 0.72);
    expect(result.adjustedStopLoss!).toBeLessThan(stopLoss);
  });

  it("5. Adapted SELL TP preserves 2R", () => {
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss: 4771.554,
      takeProfit: 4770.492,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    const slDist = Math.abs(v10.ask - result.adjustedStopLoss!);
    const tpDist = Math.abs(v10.ask - result.adjustedTakeProfit!);
    expect(tpDist / slDist).toBeCloseTo(2, 2);
    expect(result.adjustedTakeProfit!).toBeLessThan(v10.ask);
  });

  it("6. Adapted BUY TP preserves 2R", () => {
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "BUY",
      stopLoss: 4770.8,
      takeProfit: 4771.4,
      entryPrice: v10.bid,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    const slDist = Math.abs(v10.bid - result.adjustedStopLoss!);
    const tpDist = Math.abs(result.adjustedTakeProfit! - v10.bid);
    expect(tpDist / slDist).toBeCloseTo(2, 2);
    expect(result.adjustedTakeProfit!).toBeGreaterThan(v10.bid);
  });

  it("7. SL and TP tick normalization", () => {
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss: 4771.5544,
      takeProfit: 4770.4927,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(Number(result.adjustedStopLoss!.toFixed(3))).toBe(result.adjustedStopLoss);
    expect(Number(result.adjustedTakeProfit!.toFixed(3))).toBe(result.adjustedTakeProfit);
  });

  it("8. Risk sizing recalculated after widening (smaller volume for wider stop)", () => {
    const sizing = new DefaultPositionSizingService();
    const narrowSl = 4771.554;
    const adapted = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss: narrowSl,
      takeProfit: 4770.492,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(adapted.brokerAdjusted).toBe(true);

    const before = sizing.calculateRaw({
      equity: 10_000,
      direction: "SELL",
      entryPrice: v10.ask,
      stopLoss: narrowSl,
      riskPerTradePercent: 0.1,
      instrument
    });
    const after = sizing.calculateRaw({
      equity: 10_000,
      direction: "SELL",
      entryPrice: v10.ask,
      stopLoss: adapted.adjustedStopLoss!,
      riskPerTradePercent: 0.1,
      instrument
    });
    expect(before.success && after.success).toBe(true);
    expect(after.rawVolume!).toBeLessThan(before.rawVolume!);
  });

  it("9. Widened stop causes min-volume risk violation → blocked code path", () => {
    const sizing = new DefaultPositionSizingService();
    const adapted = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss: 4771.554,
      takeProfit: 4770.492,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    const after = sizing.calculateRaw({
      equity: 100, // tiny equity → even min 0.5 lot exceeds risk after widen
      direction: "SELL",
      entryPrice: v10.ask,
      stopLoss: adapted.adjustedStopLoss!,
      riskPerTradePercent: 0.1,
      instrument
    });
    expect(after.success).toBe(true);
    const volume = resolveMt5EngineVolume({
      equity: 100,
      riskPerTradePercent: 0.1,
      riskSizedVolume: after.rawVolume!,
      direction: "SELL",
      entryPrice: v10.ask,
      stopLoss: adapted.adjustedStopLoss!,
      instrument,
      engineMaxVolume: 10
    });
    expect(volume.wouldSubmit).toBe(false);
    expect(volume.reasonCode).toBe(MIN_VOLUME_EXCEEDS_RISK);
    // Runtime maps this to MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED when brokerAdjusted.
    expect(MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED).toBe("MT5_BROKER_ADJUSTED_STOP_RISK_BLOCKED");
  });

  it("10. Price changes between signal and execution use live Bid/Ask", () => {
    // Strategy sized from older entry; live Ask moved so technical SL is now too close.
    const result = adaptMt5BrokerStops({
      ...v10,
      bid: 4771.8,
      ask: 4771.95,
      direction: "SELL",
      stopLoss: 4772.2, // was fine at Ask 4771.2; now only 0.25 from live Ask
      takeProfit: 4769.0,
      entryPrice: 4771.95,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(result.brokerAdjusted).toBe(true);
    expect(result.adjustedStopLoss! - 4771.95).toBeGreaterThanOrEqual(0.72);
  });

  it("11. stopsLevel=0 → no unnecessary widening", () => {
    const stopLoss = 4771.25;
    const takeProfit = 4770.9;
    const result = adaptMt5BrokerStops({
      ...v10,
      stopsLevel: 0,
      direction: "SELL",
      stopLoss,
      takeProfit,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(true);
    expect(result.brokerAdjusted).toBe(false);
    expect(result.minimumStopDistance).toBe(0);
  });

  it("12. metadata unavailable → fail-closed", () => {
    const result = adaptMt5BrokerStops({
      ...v10,
      stopsLevel: null,
      direction: "SELL",
      stopLoss: 4772.5,
      takeProfit: 4768,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe(MT5_STOP_METADATA_UNAVAILABLE);
    expect(result.brokerAdjusted).toBe(false);
  });

  it("13. adaptation never moves protective stop toward market", () => {
    const sell = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss: 4771.554,
      takeProfit: 4770.492,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(sell.adjustedStopLoss!).toBeGreaterThanOrEqual(4771.554);

    const buy = adaptMt5BrokerStops({
      ...v10,
      direction: "BUY",
      stopLoss: 4770.8,
      takeProfit: 4771.4,
      entryPrice: v10.bid,
      targetRMultiple: 2
    });
    expect(buy.adjustedStopLoss!).toBeLessThanOrEqual(4770.8);
  });

  it("14. original SL/TP remain the strategy values when adaptation unnecessary", () => {
    const stopLoss = 4773.0;
    const takeProfit = 4767.0;
    const result = adaptMt5BrokerStops({
      ...v10,
      direction: "SELL",
      stopLoss,
      takeProfit,
      entryPrice: v10.ask,
      targetRMultiple: 2
    });
    expect(result.brokerAdjusted).toBe(false);
    expect(result.originalStopLoss).toBe(stopLoss);
    expect(result.originalTakeProfit).toBe(takeProfit);
    expect(result.adjustedStopLoss).toBe(stopLoss);
    expect(result.adjustedTakeProfit).toBe(takeProfit);
  });

  it("rejects when adaptation cannot produce valid stops", () => {
    // Degenerate: entry equal to stop after impossible market — use invalid quotes caught earlier
    const result = adaptMt5BrokerStops({
      ...v10,
      bid: 0,
      ask: 0,
      direction: "SELL",
      stopLoss: 4772,
      takeProfit: 4768,
      entryPrice: 4771,
      targetRMultiple: 2
    });
    expect(result.ok).toBe(false);
    expect(
      result.reasonCode === MT5_STOP_METADATA_UNAVAILABLE ||
        result.reasonCode === MT5_INVALID_STOP_DISTANCE_PRECHECK
    ).toBe(true);
  });
});
