import { describe, expect, it } from "vitest";
import { DEFAULT_CFD_RISK_LIMITS, type InstrumentMetadata } from "@regimex/shared";
import { StopTargetValidator } from "./stopTargetValidator.js";

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
  spreadBps: 10,
  slippageBps: 5,
  pricePrecision: 2,
  currency: "USD"
};

describe("StopTargetValidator", () => {
  const validator = new StopTargetValidator();

  it("accepts valid BUY stop and target with sufficient R:R", () => {
    const result = validator.validate({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 104,
      instrument,
      limits: DEFAULT_CFD_RISK_LIMITS
    });
    expect(result.valid).toBe(true);
    expect(result.riskRewardRatio).toBe(2);
  });

  it("rejects BUY when stop is above entry", () => {
    const result = validator.validate({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 101,
      takeProfit: 104,
      instrument,
      limits: DEFAULT_CFD_RISK_LIMITS
    });
    expect(result.valid).toBe(false);
  });

  it("rejects when R:R is below minimum", () => {
    const result = validator.validate({
      direction: "SELL",
      entryPrice: 100,
      stopLoss: 102,
      takeProfit: 99,
      instrument,
      limits: DEFAULT_CFD_RISK_LIMITS
    });
    expect(result.valid).toBe(false);
  });
});
