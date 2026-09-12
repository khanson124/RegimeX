import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY_REASON,
  shouldBlockR10SqueezeForwardTrialSell
} from "./r10SqueezeForwardTrialGuard.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("R10 squeeze forward-trial BUY-only guard", () => {
  const blocked = {
    executionBackend: "broker_demo_mt5",
    symbol: "R_10",
    interval: "1m",
    strategyId: "squeeze-breakout-v1",
    action: "SELL"
  } as const;

  it("blocks R_10 1m squeeze-breakout-v1 SELL on broker_demo_mt5", () => {
    expect(shouldBlockR10SqueezeForwardTrialSell(blocked)).toBe(true);
    expect(R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY_REASON).toBe("R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY");
  });

  it("does not block BUY", () => {
    expect(shouldBlockR10SqueezeForwardTrialSell({ ...blocked, action: "BUY" })).toBe(false);
  });

  it("does not block another strategy", () => {
    expect(
      shouldBlockR10SqueezeForwardTrialSell({ ...blocked, strategyId: "breakout-momentum-v1" })
    ).toBe(false);
  });

  it("does not block another symbol", () => {
    expect(shouldBlockR10SqueezeForwardTrialSell({ ...blocked, symbol: "XAUUSD" })).toBe(false);
  });

  it("does not block another timeframe", () => {
    expect(shouldBlockR10SqueezeForwardTrialSell({ ...blocked, interval: "5m" })).toBe(false);
  });

  it("does not block paper / non-MT5 backends", () => {
    expect(
      shouldBlockR10SqueezeForwardTrialSell({ ...blocked, executionBackend: "paper_cfd" })
    ).toBe(false);
  });

  it("session places guard after SIGNAL_PRODUCED and before executeCfdSignal; no cooldown on blocked SELL", () => {
    const src = readFileSync(join(here, "liveEngineSession.ts"), "utf8");
    expect(src).toContain("shouldBlockR10SqueezeForwardTrialSell");
    expect(src).toContain("R10_SQUEEZE_FORWARD_TRIAL_BUY_ONLY_REASON");
    expect(src).toContain("Temporary DEMO forward-trial guard");

    const produced = src.indexOf('await this.logDecision("SIGNAL_PRODUCED"');
    const guard = src.indexOf("shouldBlockR10SqueezeForwardTrialSell({");
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
