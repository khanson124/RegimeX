import { describe, expect, it } from "vitest";
import { type InstrumentMetadata } from "@regimex/shared";
import { DefaultPositionSizingService } from "../../execution/positionSizing.js";
import {
  BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME,
  MIN_VOLUME_EXCEEDS_RISK,
  VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK,
  buildAutonomousExecutionPreflight,
  resolveMt5EngineVolume,
  rolloutBlockedByBrokerMinVolume
} from "./engineVolume.js";

/** Live Deriv MT5 DEMO V10 specs (verified). */
const v10: InstrumentMetadata = {
  symbol: "Volatility 10 Index",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.5,
  maxVolume: 400,
  tickSize: 0.001,
  tickValue: 0.001,
  marginRate: 0.01,
  spreadBps: 0,
  slippageBps: 0,
  pricePrecision: 3,
  currency: "USD",
  source: "mt5_live_discovery"
};

const sizing = new DefaultPositionSizingService();

function volumeFor(input: {
  equity?: number;
  riskPercent?: number;
  entry?: number;
  stop?: number;
  engineMaxVolume: number;
  instrument?: InstrumentMetadata;
}) {
  const equity = input.equity ?? 10_000;
  const riskPercent = input.riskPercent ?? 0.1;
  const entry = input.entry ?? 100;
  const stop = input.stop ?? 90;
  const instrument = input.instrument ?? v10;
  const raw = sizing.calculateRaw({
    equity,
    direction: "BUY",
    entryPrice: entry,
    stopLoss: stop,
    riskPerTradePercent: riskPercent,
    instrument
  });
  expect(raw.success).toBe(true);
  return resolveMt5EngineVolume({
    equity,
    riskPerTradePercent: riskPercent,
    riskSizedVolume: raw.rawVolume!,
    direction: "BUY",
    entryPrice: entry,
    stopLoss: stop,
    instrument,
    engineMaxVolume: input.engineMaxVolume
  });
}

describe("MT5 engine volume vs broker min and risk", () => {
  it("uses normal sizing when raw volume is above broker min", () => {
    const decision = volumeFor({ engineMaxVolume: 2, stop: 90 });
    expect(decision.riskSizedVolume).toBeGreaterThan(0.5);
    expect(decision.wouldSubmit).toBe(true);
    expect(decision.finalVolume).toBeGreaterThanOrEqual(0.5);
    expect(decision.raisedToBrokerMin).toBe(false);
    expect(decision.decision).toBe("SUBMIT");
  });

  it("may raise to broker min when the min still fits allowed risk", () => {
    const decision = volumeFor({
      engineMaxVolume: 1,
      entry: 100,
      stop: 79.99
    });
    expect(decision.normalizedVolume).toBeLessThan(0.5);
    expect(decision.wouldSubmit).toBe(true);
    expect(decision.reasonCode).toBe(VOLUME_RAISED_TO_BROKER_MIN_WITHIN_RISK);
    expect(decision.finalVolume).toBe(0.5);
    expect(decision.raisedToBrokerMin).toBe(true);
    expect(decision.riskAtBrokerMinVolume).toBeLessThanOrEqual(decision.allowedRiskAmount + 0.01);
  });

  it("rejects when broker min would exceed allowed risk", () => {
    const decision = volumeFor({
      engineMaxVolume: 1,
      entry: 100,
      stop: 75
    });
    expect(decision.normalizedVolume).toBeLessThan(0.5);
    expect(decision.wouldSubmit).toBe(false);
    expect(decision.reasonCode).toBe(MIN_VOLUME_EXCEEDS_RISK);
    expect(decision.finalVolume).toBeNull();
    expect(decision.riskAtBrokerMinVolume).toBeGreaterThan(decision.allowedRiskAmount);
  });

  it("hard-rejects when broker min exceeds MT5_ENGINE_MAX_VOLUME", () => {
    const decision = volumeFor({ engineMaxVolume: 0.01, stop: 90 });
    expect(decision.wouldSubmit).toBe(false);
    expect(decision.reasonCode).toBe(BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME);
    expect(decision.finalVolume).toBeNull();
    expect(rolloutBlockedByBrokerMinVolume({ brokerMinVolume: 0.5, engineMaxVolume: 0.01 })).toBe(true);
  });

  it("normalizes down to volumeStep and never rounds up", () => {
    const decision = volumeFor({
      engineMaxVolume: 5,
      equity: 12_370,
      riskPercent: 0.1,
      entry: 100,
      stop: 90
    });
    expect(decision.brokerVolumeStep).toBe(0.01);
    const remainder = Number((decision.normalizedVolume % 0.01).toFixed(8));
    expect(remainder === 0 || remainder === 0.01).toBe(true);
    expect(decision.normalizedVolume).toBeLessThanOrEqual(decision.riskSizedVolume + 1e-12);
  });

  it("never silently increases volume beyond allowed risk", () => {
    const decision = volumeFor({ engineMaxVolume: 400, entry: 100, stop: 75 });
    expect(decision.wouldSubmit).toBe(false);
    expect(decision.finalVolume).toBeNull();
    expect(decision.reasonCode).toBe(MIN_VOLUME_EXCEEDS_RISK);
  });

  it("never silently increases volume beyond the engine max ceiling", () => {
    const decision = volumeFor({ engineMaxVolume: 0.01, equity: 1_000_000, stop: 99.999 });
    expect(decision.wouldSubmit).toBe(false);
    expect(decision.finalVolume).not.toBe(0.5);
    expect(decision.reasonCode).toBe(BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME);
  });

  it("exposes every sizing diagnostic component", () => {
    const volume = volumeFor({ engineMaxVolume: 0.01 });
    const preflight = buildAutonomousExecutionPreflight({
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 Index",
      strategyId: "ema-pullback-v1",
      equity: 10_000,
      entry: 100,
      stopLoss: 90,
      takeProfit: 115,
      volume
    });
    expect(preflight).toMatchObject({
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 Index",
      strategyId: "ema-pullback-v1",
      wouldSubmit: false,
      reasonCode: BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME
    });
    expect(preflight.requestedVolume).toBe(volume.requestedVolume);
    expect(preflight.rawVolume).toBe(volume.riskSizedVolume);
    expect(preflight.normalizedVolume).toBeDefined();
    expect(preflight.brokerMinVolume).toBe(0.5);
    expect(preflight.brokerVolumeStep).toBe(0.01);
    expect(preflight.brokerMaxVolume).toBe(400);
    expect(preflight.engineMaxVolume).toBe(0.01);
    expect(preflight.allowedRiskAmount).toBeGreaterThan(0);
    expect(preflight.riskAtBrokerMinVolume).toBeGreaterThan(0);
    expect(preflight.finalVolume).toBeNull();
    expect(preflight.decision).toBe(BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME);
    expect(volume.requestedVolume).toBe(volume.riskSizedVolume);
  });

  it("does not submit when mapping/sizing would block", () => {
    const blocked = volumeFor({ engineMaxVolume: 0.01 });
    expect(blocked.wouldSubmit).toBe(false);
    const allowed = volumeFor({ engineMaxVolume: 2, stop: 90 });
    expect(allowed.wouldSubmit).toBe(true);
  });
});
