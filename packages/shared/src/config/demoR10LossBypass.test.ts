import { describe, expect, it } from "vitest";
import { demoR10LossBypassKey, parseDemoR10LossBypassExpiry, isDemoR10LossBypassActive,
  DEMO_R10_LOSS_BYPASS_DURATION_MS } from "./demoR10LossBypass.js";
const now = 1_800_000_000_000;
const scope = { executionMode: "broker_demo_mt5", sessionMode: "DEMO_TRADING", symbol: "R_10",
  strategyId: "squeeze-breakout-v1", expiresAtMs: now + 1000 };
describe("temporary R_10 DEMO loss bypass", () => {
  it.each(["squeeze-breakout-v1", "ema-pullback-v1", "other-strategy"])("allows all R_10 strategies: %s", (strategyId) => {
    expect(isDemoR10LossBypassActive({ ...scope, strategyId }, now)).toBe(true);
  });
  it.each([
    { executionMode: "broker_real_mt5" }, { executionMode: "paper_cfd" },
    { sessionMode: "LIVE_TRADING" }, { sessionMode: "ANALYSIS_ONLY" },
    { symbol: "XAUUSD" }, { symbol: "R_25" }, { strategyId: "" },
    { expiresAtMs: null }, { expiresAtMs: now }, { expiresAtMs: now - 1 },
    { expiresAtMs: now + DEMO_R10_LOSS_BYPASS_DURATION_MS + 1 }
  ])("fails closed outside scope or validity: %s", (override) => {
    expect(isDemoR10LossBypassActive({ ...scope, ...override }, now)).toBe(false);
  });
  it.each([null, undefined, "", "true", "NaN", "-1", "1.5", "9007199254740992"])("rejects malformed expiry %s", (raw) => {
    expect(parseDemoR10LossBypassExpiry(raw)).toBeNull();
  });
  it("uses isolated user keys and parses valid expiry", () => {
    expect(demoR10LossBypassKey("a")).not.toBe(demoR10LossBypassKey("b"));
    expect(parseDemoR10LossBypassExpiry(String(scope.expiresAtMs))).toBe(scope.expiresAtMs);
  });
});
