import { describe, expect, it } from "vitest";
import { DEFAULT_CFD_RISK_LIMITS } from "@regimex/shared";
import { DefaultPositionSizingService } from "../../execution/positionSizing.js";
import { StopTargetValidator } from "../../execution/stopTargetValidator.js";
import {
  buildPendingMt5ExecutionTelemetry,
  computeExecutedRiskAmount,
  computePriceBasedRiskReward,
  mergeOpenMt5ExecutionTelemetry,
  mergePositionMetadataForOpen,
  MT5_EXECUTION_TELEMETRY_VERSION
} from "./mt5ExecutionTelemetry.js";

const sizing = new DefaultPositionSizingService();
const validator = new StopTargetValidator();

const VOL10_INSTRUMENT = {
  symbol: "R_10",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 10,
  tickSize: 0.001,
  tickValue: 0.001,
  marginRate: 0.01,
  spreadBps: 10,
  slippageBps: 5,
  pricePrecision: 3,
  currency: "USD"
};

/** Production demo trade 1 */
const TRADE_1 = {
  fill: 4778.249,
  sl: 4776.935,
  tp: 4780.34,
  preflightAsk: 4778.249
};

/** Production demo trade 2 */
const TRADE_2 = {
  fill: 4761.318,
  sl: 4760.124,
  tp: 4763.529,
  preflightAsk: 4761.318
};

describe("computePriceBasedRiskReward", () => {
  it("1. production BUY trade 1 executed R:R ≈ 1.59", () => {
    expect(
      computePriceBasedRiskReward({
        direction: "BUY",
        entry: TRADE_1.fill,
        stopLoss: TRADE_1.sl,
        takeProfit: TRADE_1.tp
      })
    ).toBeCloseTo(1.5913, 2);
  });

  it("2. production BUY trade 2 executed R:R ≈ 1.85", () => {
    expect(
      computePriceBasedRiskReward({
        direction: "BUY",
        entry: TRADE_2.fill,
        stopLoss: TRADE_2.sl,
        takeProfit: TRADE_2.tp
      })
    ).toBeCloseTo(1.8518, 2);
  });

  it("7. SELL formula", () => {
    expect(
      computePriceBasedRiskReward({
        direction: "SELL",
        entry: 100,
        stopLoss: 102,
        takeProfit: 96
      })
    ).toBe(2);
  });

  it("8. zero risk distance returns null", () => {
    expect(
      computePriceBasedRiskReward({
        direction: "BUY",
        entry: 100,
        stopLoss: 100,
        takeProfit: 110
      })
    ).toBeNull();
  });

  it("8. missing takeProfit returns null", () => {
    expect(
      computePriceBasedRiskReward({
        direction: "BUY",
        entry: 100,
        stopLoss: 99,
        takeProfit: null
      })
    ).toBeNull();
  });
});

describe("buildPendingMt5ExecutionTelemetry", () => {
  it("3. allowedRiskAmount ≈ 9.92 while executed at 0.5 lot is ~0.57–0.71", () => {
    const raw = sizing.calculateRaw({
      equity: 1984,
      direction: "BUY",
      entryPrice: TRADE_1.preflightAsk,
      stopLoss: TRADE_1.sl,
      riskPerTradePercent: 0.5,
      instrument: VOL10_INSTRUMENT
    });
    expect(raw.riskAmount).toBeCloseTo(9.92, 1);

    const pending = buildPendingMt5ExecutionTelemetry({
      direction: "BUY",
      strategyEntryPrice: 4777.87,
      strategyStopLoss: TRADE_1.sl,
      strategyTakeProfit: TRADE_1.tp,
      strategyRequestedRiskReward: 2,
      preflightEntry: TRADE_1.preflightAsk,
      adaptedStopLoss: TRADE_1.sl,
      adaptedTakeProfit: TRADE_1.tp,
      targetRMultiple: 2,
      allowedRiskAmount: raw.riskAmount,
      requestedVolume: raw.rawVolume ?? 8.74,
      finalVolume: 0.5,
      perUnitLossAtPreflight: raw.perUnitLoss,
      instrument: VOL10_INSTRUMENT
    });
    expect(pending.allowedRiskAmount).toBeCloseTo(9.92, 1);
    expect(pending.telemetryVersion).toBe(MT5_EXECUTION_TELEMETRY_VERSION);

    const executed = computeExecutedRiskAmount({
      direction: "BUY",
      fillPrice: TRADE_1.fill,
      stopLoss: TRADE_1.sl,
      volume: 0.5,
      tickSize: VOL10_INSTRUMENT.tickSize,
      tickValue: VOL10_INSTRUMENT.tickValue
    });
    expect(executed).toBeGreaterThan(0.57);
    expect(executed).toBeLessThan(0.71);
  });

  it("4. brokerRequestedRiskReward uses preflight ask, not candle close", () => {
    const candleClose = 4777.87;
    const pending = buildPendingMt5ExecutionTelemetry({
      direction: "BUY",
      strategyEntryPrice: candleClose,
      strategyStopLoss: TRADE_1.sl,
      strategyTakeProfit: TRADE_1.tp,
      preflightEntry: TRADE_1.preflightAsk,
      adaptedStopLoss: TRADE_1.sl,
      adaptedTakeProfit: TRADE_1.tp,
      targetRMultiple: 2,
      allowedRiskAmount: 9.92,
      requestedVolume: 8.74,
      finalVolume: 0.5,
      perUnitLossAtPreflight: 1.314,
      instrument: VOL10_INSTRUMENT
    });
    expect(pending.brokerRequestedRiskReward).toBeCloseTo(1.5913, 2);
    const atCandleClose = computePriceBasedRiskReward({
      direction: "BUY",
      entry: candleClose,
      stopLoss: TRADE_1.sl,
      takeProfit: TRADE_1.tp
    });
    expect(atCandleClose).toBeCloseTo(2.6378, 2);
    expect(pending.brokerRequestedRiskReward).not.toBeCloseTo(atCandleClose!, 1);
  });

  it("5. strategyRequestedRiskReward preserves strategy intent (2R)", () => {
    const pending = buildPendingMt5ExecutionTelemetry({
      direction: "BUY",
      strategyEntryPrice: 4777.87,
      strategyStopLoss: 4776.5,
      strategyTakeProfit: 4780.61,
      strategyRequestedRiskReward: 2,
      preflightEntry: TRADE_1.preflightAsk,
      adaptedStopLoss: TRADE_1.sl,
      adaptedTakeProfit: TRADE_1.tp,
      targetRMultiple: 2,
      allowedRiskAmount: 9.92,
      requestedVolume: 8.74,
      finalVolume: 0.5,
      perUnitLossAtPreflight: 1.314,
      instrument: VOL10_INSTRUMENT
    });
    expect(pending.strategyRequestedRiskReward).toBe(2);
    expect(pending.initialRiskRewardLegacyNote).toContain("initialRiskReward");
  });

  it("6. intendedTargetRMultiple stays 2 while actualFinalTargetRMultiple is telemetry-only", () => {
    const pending = buildPendingMt5ExecutionTelemetry({
      direction: "SELL",
      strategyEntryPrice: 4785.886,
      strategyStopLoss: 4787.021,
      strategyTakeProfit: 4783.616,
      strategyRequestedRiskReward: 2,
      preflightEntry: 4785.886,
      adaptedStopLoss: 4787.021,
      adaptedTakeProfit: 4783.967,
      targetRMultiple: 2,
      intendedTargetRMultiple: 2,
      actualFinalTargetRMultiple: 1.6907,
      allowedRiskAmount: 1,
      requestedVolume: 0.5,
      finalVolume: 0.5,
      perUnitLossAtPreflight: 1.135,
      instrument: VOL10_INSTRUMENT
    });
    expect(pending.targetRMultiple).toBe(2);
    expect(pending.intendedTargetRMultiple).toBe(2);
    expect(pending.actualFinalTargetRMultiple).toBeCloseTo(1.6907, 4);
    expect(pending.brokerRequestedRiskReward).toBeCloseTo(1.6907, 3);
    expect(pending.intendedTargetRMultiple).not.toBe(pending.actualFinalTargetRMultiple);
  });
});

describe("mergeOpenMt5ExecutionTelemetry", () => {
  it("OPEN merge adds executed fields from broker fill", () => {
    const pending = buildPendingMt5ExecutionTelemetry({
      direction: "BUY",
      strategyEntryPrice: 4777.87,
      strategyStopLoss: TRADE_1.sl,
      strategyTakeProfit: TRADE_1.tp,
      strategyRequestedRiskReward: 2,
      preflightEntry: TRADE_1.preflightAsk,
      adaptedStopLoss: TRADE_1.sl,
      adaptedTakeProfit: TRADE_1.tp,
      targetRMultiple: 2,
      allowedRiskAmount: 9.92,
      requestedVolume: 8.74,
      finalVolume: 0.5,
      perUnitLossAtPreflight: 1.314,
      instrument: VOL10_INSTRUMENT
    });
    const open = mergeOpenMt5ExecutionTelemetry({
      pending,
      direction: "BUY",
      actualFillPrice: TRADE_1.fill,
      actualFillVolume: 0.5,
      stopLoss: TRADE_1.sl,
      takeProfit: TRADE_1.tp,
      openedAt: "2026-09-01T12:00:00.000Z"
    });
    expect(open.executedRiskReward).toBeCloseTo(1.5913, 2);
    expect(open.executedRiskAmount).toBeGreaterThan(0.57);
    expect(open.strategyRequestedRiskReward).toBe(2);
    expect(open.brokerRequestedRiskReward).toBeCloseTo(1.5913, 2);
    expect(open.openedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("8. missing tick metadata yields null executedRiskAmount", () => {
    const open = mergeOpenMt5ExecutionTelemetry({
      pending: null,
      direction: "BUY",
      actualFillPrice: TRADE_1.fill,
      actualFillVolume: 0.5,
      stopLoss: TRADE_1.sl,
      takeProfit: TRADE_1.tp,
      tickSize: null,
      tickValue: null
    });
    expect(open.executedRiskAmount).toBeNull();
    expect(open.executedRiskReward).toBeCloseTo(1.5913, 2);
  });
});

describe("mergePositionMetadataForOpen", () => {
  it("6. preserves volumePreflight, broker identifiers, and pending telemetry", () => {
    const pending = buildPendingMt5ExecutionTelemetry({
      direction: "BUY",
      strategyEntryPrice: 4777.87,
      strategyStopLoss: TRADE_1.sl,
      strategyTakeProfit: TRADE_1.tp,
      strategyRequestedRiskReward: 2,
      preflightEntry: TRADE_1.preflightAsk,
      adaptedStopLoss: TRADE_1.sl,
      adaptedTakeProfit: TRADE_1.tp,
      targetRMultiple: 2,
      allowedRiskAmount: 9.92,
      requestedVolume: 8.74,
      finalVolume: 0.5,
      perUnitLossAtPreflight: 1.314,
      instrument: VOL10_INSTRUMENT
    });
    const openTelemetry = mergeOpenMt5ExecutionTelemetry({
      pending,
      direction: "BUY",
      actualFillPrice: TRADE_1.fill,
      actualFillVolume: 0.5,
      stopLoss: TRADE_1.sl,
      takeProfit: TRADE_1.tp,
      tickSize: VOL10_INSTRUMENT.tickSize,
      tickValue: VOL10_INSTRUMENT.tickValue
    });
    const merged = mergePositionMetadataForOpen({
      existingMetadata: {
        volumePreflight: { finalVolume: 0.5, allowedRiskAmount: 9.92 },
        executionTelemetry: pending,
        customFlag: true
      },
      symbolAudit: { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" },
      preflight: { finalVolume: 0.5 },
      brokerPositionMetadata: {
        orderTicket: 123,
        magic: 26082301,
        comment: "RX|abc"
      },
      executionTelemetry: openTelemetry
    });
    expect(merged.volumePreflight).toEqual({ finalVolume: 0.5 });
    expect(merged.orderTicket).toBe(123);
    expect(merged.magic).toBe(26082301);
    expect(merged.comment).toBe("RX|abc");
    expect(merged.customFlag).toBe(true);
    expect(merged.executionTelemetry).toEqual(openTelemetry);
  });
});

describe("legacy initialRiskReward gate semantics", () => {
  it("Position.initialRiskReward gate uses candle close (legacy), not fill", () => {
    const entryForStored =
      (TRADE_1.tp + 2.6378 * TRADE_1.sl) / (1 + 2.6378);
    const stopCheck = validator.validate({
      direction: "BUY",
      entryPrice: entryForStored,
      stopLoss: TRADE_1.sl,
      takeProfit: TRADE_1.tp,
      instrument: VOL10_INSTRUMENT,
      limits: DEFAULT_CFD_RISK_LIMITS
    });
    expect(stopCheck.riskRewardRatio).toBeCloseTo(2.6378, 3);
  });
});
