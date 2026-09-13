import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  XAU_FORWARD_TRIAL_EXPERIMENTAL_REASON,
  isXauTrendPullbackForwardTrialExecutable,
  shouldBlockXauUsdForwardTrialExecution
} from "./xauTrendPullbackForwardTrialGuard.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("XAU trend-pullback DEMO forward-trial guard", () => {
  const allowed = {
    executionBackend: "broker_demo_mt5",
    symbol: "XAUUSD",
    interval: "15m",
    strategyId: "xau-trend-pullback-v1",
    action: "BUY",
    realMoneyEnabled: false
  } as const;

  it("allows XAU M15 pullback BUY in DEMO", () => {
    expect(isXauTrendPullbackForwardTrialExecutable(allowed)).toBe(true);
    expect(shouldBlockXauUsdForwardTrialExecution(allowed)).toBe(false);
    expect(XAU_FORWARD_TRIAL_EXPERIMENTAL_REASON).toBe("XAU_FORWARD_TRIAL_EXPERIMENTAL");
  });

  it("allows XAU M15 pullback SELL in DEMO", () => {
    expect(
      shouldBlockXauUsdForwardTrialExecution({ ...allowed, action: "SELL" })
    ).toBe(false);
  });

  it("blocks XAU 1m", () => {
    expect(shouldBlockXauUsdForwardTrialExecution({ ...allowed, interval: "1m" })).toBe(true);
  });

  it("blocks XAU 5m", () => {
    expect(shouldBlockXauUsdForwardTrialExecution({ ...allowed, interval: "5m" })).toBe(true);
  });

  it("blocks XAU 1h", () => {
    expect(shouldBlockXauUsdForwardTrialExecution({ ...allowed, interval: "1h" })).toBe(true);
  });

  it("blocks breakout-v2", () => {
    expect(
      shouldBlockXauUsdForwardTrialExecution({
        ...allowed,
        strategyId: "xau-trend-breakout-v2"
      })
    ).toBe(true);
  });

  it("blocks real-money backend", () => {
    expect(
      shouldBlockXauUsdForwardTrialExecution({
        ...allowed,
        executionBackend: "broker_real_mt5"
      })
    ).toBe(true);
    expect(
      shouldBlockXauUsdForwardTrialExecution({
        ...allowed,
        realMoneyEnabled: true
      })
    ).toBe(true);
  });

  it("leaves another symbol unchanged", () => {
    expect(
      shouldBlockXauUsdForwardTrialExecution({
        ...allowed,
        symbol: "R_10",
        interval: "1m",
        strategyId: "squeeze-breakout-v1",
        action: "SELL"
      })
    ).toBe(false);
  });

  it("does not block paper backends for XAU (non-MT5 DEMO path)", () => {
    expect(
      shouldBlockXauUsdForwardTrialExecution({
        ...allowed,
        executionBackend: "paper_cfd"
      })
    ).toBe(false);
  });

  it("session wires guard after SIGNAL_PRODUCED and before executeCfdSignal", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("shouldBlockXauUsdForwardTrialExecution");
    expect(src).toContain("XAU_FORWARD_TRIAL_EXPERIMENTAL_REASON");
    expect(src).toContain("isXauTrendPullbackForwardTrialExecutable");

    const produced = src.indexOf('await this.logDecision("SIGNAL_PRODUCED"');
    const xauGuard = src.indexOf("shouldBlockXauUsdForwardTrialExecution({");
    const execute = src.indexOf("this.mt5Cfd.executeCfdSignal");
    expect(produced).toBeGreaterThan(-1);
    expect(xauGuard).toBeGreaterThan(produced);
    expect(execute).toBeGreaterThan(xauGuard);
  });
});
