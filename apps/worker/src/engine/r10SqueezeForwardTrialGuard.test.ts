import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY_REASON,
  R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON,
  isR10SqueezeForwardTrialExecutable,
  shouldBlockR10SqueezeForwardTrial
} from "./r10SqueezeForwardTrialGuard.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("R10 squeeze forward-trial 1m BUY|SELL guard", () => {
  const base = {
    executionBackend: "broker_demo_mt5",
    symbol: "R_10",
    interval: "1m",
    strategyId: "squeeze-breakout-v1",
    action: "BUY"
  } as const;

  it("allows R_10 1m squeeze-breakout-v1 BUY on broker_demo_mt5", () => {
    expect(isR10SqueezeForwardTrialExecutable(base)).toBe(true);
    expect(shouldBlockR10SqueezeForwardTrial(base)).toBe(false);
    expect(R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON).toBe("R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY");
    expect(R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY_REASON).toBe(R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON);
  });

  it("allows R_10 1m squeeze-breakout-v1 SELL on broker_demo_mt5 (proceeds past FT guard)", () => {
    const sell = { ...base, action: "SELL" as const };
    expect(isR10SqueezeForwardTrialExecutable(sell)).toBe(true);
    expect(shouldBlockR10SqueezeForwardTrial(sell)).toBe(false);
  });

  it("blocks 5m BUY and 5m SELL", () => {
    expect(shouldBlockR10SqueezeForwardTrial({ ...base, interval: "5m", action: "BUY" })).toBe(true);
    expect(shouldBlockR10SqueezeForwardTrial({ ...base, interval: "5m", action: "SELL" })).toBe(true);
  });

  it("blocks every other interval", () => {
    for (const interval of ["15m", "1h", "4h", "1d"] as const) {
      expect(shouldBlockR10SqueezeForwardTrial({ ...base, interval, action: "BUY" })).toBe(true);
      expect(shouldBlockR10SqueezeForwardTrial({ ...base, interval, action: "SELL" })).toBe(true);
    }
  });

  it("does not apply to another strategy on R_10", () => {
    expect(
      shouldBlockR10SqueezeForwardTrial({ ...base, strategyId: "breakout-momentum-v1", action: "SELL" })
    ).toBe(false);
  });

  it("does not apply to another symbol", () => {
    expect(shouldBlockR10SqueezeForwardTrial({ ...base, symbol: "XAUUSD", action: "SELL" })).toBe(
      false
    );
  });

  it("does not apply to paper backends", () => {
    expect(
      shouldBlockR10SqueezeForwardTrial({ ...base, executionBackend: "paper_cfd", action: "SELL" })
    ).toBe(false);
  });

  it("does not apply to REAL backends", () => {
    expect(
      shouldBlockR10SqueezeForwardTrial({ ...base, executionBackend: "broker_real_mt5", action: "SELL" })
    ).toBe(false);
    expect(
      isR10SqueezeForwardTrialExecutable({ ...base, executionBackend: "broker_real_mt5", action: "SELL" })
    ).toBe(false);
  });

  it("session places guard after SIGNAL_PRODUCED and before executeCfdSignal", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("shouldBlockR10SqueezeForwardTrial");
    expect(src).toContain("R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY_REASON");
    expect(src).toContain("Temporary DEMO forward-trial guards");
    expect(src).toContain("only 1m BUY|SELL may execute on MT5");

    const produced = src.indexOf('await this.logDecision("SIGNAL_PRODUCED"');
    const guard = src.indexOf("shouldBlockR10SqueezeForwardTrial({");
    const execute = src.indexOf("this.mt5Cfd.executeCfdSignal");
    expect(produced).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(produced);
    expect(execute).toBeGreaterThan(guard);

    const guardBlock = src.slice(guard, execute);
    expect(guardBlock).toContain('status: "SKIPPED"');
    expect(guardBlock).toContain("recordCandidate");
    expect(guardBlock).toContain('logAutonomousDecision("NO_TRADE"');
    expect(guardBlock).not.toContain("shouldConsumeStrategySignalCooldown");
    expect(guardBlock).not.toContain("lastSignalCandle.set");
  });
});
