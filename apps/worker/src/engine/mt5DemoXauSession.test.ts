import { describe, expect, it } from "vitest";
import { XAU_TREND_PULLBACK_DEFAULTS, resolveMt5EngineRiskCap } from "@regimex/trading-engine";
import { resolveMt5DemoXauSession } from "./mt5DemoXauSession.js";

const parameters = XAU_TREND_PULLBACK_DEFAULTS;
const input = {
  executionMode: "broker_demo_mt5", symbol: "XAUUSD", interval: "15m",
  strategyId: "xau-trend-pullback-v1", parameters, sessionStartUtc: 0, sessionEndUtc: 24
};

describe("DEMO XAU session override", () => {
  it("selects 0/24 only for the exact scope without changing any other parameter", () => {
    const before = { ...parameters };
    const resolved = resolveMt5DemoXauSession(input);
    expect(resolved).toMatchObject({
      defaultSession: { start: 7, end: 17 }, selectedSession: { start: 0, end: 24 },
      demoSessionOverrideApplied: true
    });
    expect(resolved.parameters).toEqual({ ...before, sessionStartHourUtc: 0, sessionEndHourUtc: 24 });
    expect(parameters).toEqual(before);
    expect(parameters.sessionStartHourUtc).toBe(7);
    expect(parameters.sessionEndHourUtc).toBe(17);
  });

  it.each([
    { executionMode: "broker_real_mt5" }, { executionMode: "paper_cfd" },
    { symbol: "R_10" }, { strategyId: "xau-trend-breakout-v2" },
    { interval: "1m" }, { interval: "5m" }, { interval: "4h" }
  ])("preserves parameters outside scope: %j", (different) => {
    const resolved = resolveMt5DemoXauSession({ ...input, ...different });
    expect(resolved.selectedSession).toEqual({ start: 7, end: 17 });
    expect(resolved.demoSessionOverrideApplied).toBe(false);
    expect(resolved.parameters).toBe(parameters);
  });

  it("preserves a strategy without session parameters and custom sessions outside scope", () => {
    const cases: Record<string, number>[] = [{ adxMinimum: 20 }, { sessionStartHourUtc: 3, sessionEndHourUtc: 12 }];
    for (const otherParameters of cases) {
      const resolved = resolveMt5DemoXauSession({ ...input, symbol: "R_10", parameters: otherParameters });
      expect(resolved.parameters).toBe(otherParameters);
      expect(resolved.demoSessionOverrideApplied).toBe(false);
    }
  });

  it.each([
    [undefined, undefined], [undefined, 24], [0, undefined], [NaN, 24], [0, Infinity],
    [-1, 24], [0, 25], [0.5, 24], [0, 23.5], [24, 24], [7, 7], [17, 7]
  ])("falls back for missing/invalid pair %s/%s", (sessionStartUtc, sessionEndUtc) => {
    const resolved = resolveMt5DemoXauSession({ ...input, sessionStartUtc, sessionEndUtc });
    expect(resolved.selectedSession).toEqual({ start: 7, end: 17 });
    expect(resolved.demoSessionOverrideApplied).toBe(false);
    expect(resolved.parameters).toBe(parameters);
  });

  it("preserves the independent 0.20 DEMO XAU and 0.10 global risk caps", () => {
    const riskInput = { ...input, globalCap: 0.1, demoXauCap: 0.2 };
    expect(resolveMt5EngineRiskCap(riskInput)).toMatchObject({ globalRiskCap: 0.1, selectedRiskCap: 0.2 });
    expect(resolveMt5EngineRiskCap({ ...riskInput, executionMode: "broker_real_mt5" }).selectedRiskCap).toBe(0.1);
    expect(resolveMt5EngineRiskCap({ ...riskInput, symbol: "R_10" }).selectedRiskCap).toBe(0.1);
  });
});
