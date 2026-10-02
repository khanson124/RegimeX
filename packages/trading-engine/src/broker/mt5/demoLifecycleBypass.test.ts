import { describe, expect, it } from "vitest";
import { gateMt5EngineSubmission, isMt5DemoLifecycleBypassListed } from "./engineRollout.js";

const pair = "R_10:squeeze-breakout-v1";
const config = {
  EXECUTION_MODE: "broker_demo_mt5", REAL_MONEY_ENABLED: false, MT5_ENGINE_ENABLED: true,
  MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10,R_25",
  MT5_ENGINE_STRATEGY_ALLOWLIST: "squeeze-breakout-v1,ema-pullback-v1",
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS: 1, MT5_ENGINE_MAX_VOLUME: 0.5
};
const input = {
  config, symbol: "R_10", strategyId: "squeeze-breakout-v1", openOwnedCount: 0,
  lifecycle: "SUSPENDED" as const,
  mapping: { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index", verified: true,
    minVolume: 0.5, volumeStep: 0.01, maxVolume: 400 }
};
const listed = { ...config, MT5_DEMO_LIFECYCLE_BYPASS: pair };

describe("DEMO lifecycle bypass", () => {
  it("allows explicitly listed suspended DEMO submissions", () => {
    expect(gateMt5EngineSubmission({ ...input, config: listed })).toEqual({
      allowed: true, reason: null, decisionCode: "SUBMIT"
    });
  });
  it("supports CSV pairs, whitespace and duplicate pairs", () => {
    const csv = { ...config, MT5_DEMO_LIFECYCLE_BYPASS:
      "R_25:ema-pullback-v1, R_10 : squeeze-breakout-v1, R_10:squeeze-breakout-v1" };
    expect(gateMt5EngineSubmission({ ...input, config: csv }).allowed).toBe(true);
    expect(isMt5DemoLifecycleBypassListed(csv, "R_25", "ema-pullback-v1")).toBe(true);
  });
  it("blocks suspended DEMO strategies not on the exact pair list", () => {
    expect(gateMt5EngineSubmission({ ...input, config: listed,
      strategyId: "ema-pullback-v1" }).decisionCode).toBe("LIFECYCLE_BLOCKED");
    expect(isMt5DemoLifecycleBypassListed(listed, "R_25", "squeeze-breakout-v1")).toBe(false);
  });
  it.each([undefined, null, "", " ", ",,,", "R_10", "R_10:", ":squeeze-breakout-v1",
    "R_10:squeeze-breakout-v1:extra", "*:squeeze-breakout-v1", "R_10:*",
    "r_10:squeeze-breakout-v1", "R_10:SQUEEZE-breakout-v1", "R_25:squeeze-breakout-v1",
    "R_10:ema-pullback-v1", "R_10:squeeze breakout-v1"])(
    "fails closed for missing, malformed or unmatched config %s", (raw) => {
      expect(gateMt5EngineSubmission({ ...input,
        config: { ...config, MT5_DEMO_LIFECYCLE_BYPASS: raw } }).decisionCode)
        .toBe("LIFECYCLE_BLOCKED");
    });
  it.each(["SUSPENDED", "REJECTED"] as const)("REAL still blocks %s even with bypass config", (lifecycle) => {
    const live = { ...listed, EXECUTION_MODE: "broker_real_mt5", REAL_MONEY_ENABLED: true,
      LIVE_MT5_ENABLED: true, LIVE_ALLOWED_SYMBOLS: "R_10", LIVE_MAX_CONCURRENT_POSITIONS: 1,
      LIVE_MAX_LOT_SIZE: 0.5, MT5_BRIDGE_SECRET: "secret", MT5_BRIDGE_URL: "http://mt5-bridge:8765",
      MT5_EXPECTED_ENVIRONMENT: "live" as const };
    // Prove the lifecycle check, rather than an earlier capability/arm check, blocks REAL.
    expect(gateMt5EngineSubmission({ ...input, config: live, liveTradingArmed: true,
      lifecycle: "EXPERIMENTAL" }).allowed).toBe(true);
    expect(gateMt5EngineSubmission({ ...input, config: live, liveTradingArmed: true,
      lifecycle }).decisionCode).toBe("LIFECYCLE_BLOCKED");
    expect(isMt5DemoLifecycleBypassListed(live, input.symbol, input.strategyId)).toBe(false);
  });
  it("keeps REJECTED DEMO strategies blocked even when listed", () => {
    expect(gateMt5EngineSubmission({ ...input, config: listed, lifecycle: "REJECTED" })
      .decisionCode).toBe("LIFECYCLE_BLOCKED");
  });
  it("preserves engine enable, strategy allowlist, mapping and capacity gates", () => {
    expect(gateMt5EngineSubmission({ ...input, config: { ...listed, MT5_ENGINE_ENABLED: false } })
      .decisionCode).toBe("MT5_ENGINE_DISABLED");
    expect(gateMt5EngineSubmission({ ...input,
      config: { ...listed, MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1" } })
      .decisionCode).toBe("STRATEGY_NOT_ALLOWED");
    expect(gateMt5EngineSubmission({ ...input, config: listed, mapping: null }).allowed).toBe(false);
    expect(gateMt5EngineSubmission({ ...input, config: listed, openOwnedCount: 1 })
      .decisionCode).toBe("MAX_CONCURRENT_POSITIONS");
  });
  it("does not enable paper execution", () => {
    expect(gateMt5EngineSubmission({ ...input, config: { ...listed, EXECUTION_MODE: "paper_cfd" } })
      .decisionCode).toBe("PAPER_MODE");
  });
});
