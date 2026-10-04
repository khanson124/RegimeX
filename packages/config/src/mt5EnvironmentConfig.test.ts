import { describe, expect, it } from "vitest";
import { type AppConfig } from "./index.js";
import { resolveMt5EnvironmentConfig } from "./mt5EnvironmentConfig.js";
const base = { EXECUTION_MODE: "broker_demo_mt5", REAL_MONEY_ENABLED: false, LIVE_MT5_ENABLED: false,
  MT5_EXPECTED_ENVIRONMENT: "demo", MT5_EXPECTED_SERVER: "Demo", MT5_EXPECTED_LOGIN: "demo-login", MT5_EXPECTED_BROKER: "Deriv",
  MT5_BRIDGE_URL: "http://legacy", MT5_DEMO_BRIDGE_URL: "http://demo", MT5_LIVE_BRIDGE_URL: "http://live",
  MT5_LIVE_EXPECTED_SERVER: "Real", MT5_LIVE_EXPECTED_LOGIN: "real-login", MT5_ENGINE_MAX_RISK_PERCENT: .1,
  LIVE_MAX_LOT_SIZE: .01, MT5_DEMO_LIFECYCLE_BYPASS: "R_10:squeeze-breakout-v1" } as AppConfig;
describe("per-environment MT5 configuration", () => {
  it("routes LIVE consistently without enabling flags or raising risk/volume limits", () => {
    const live = resolveMt5EnvironmentConfig(base, "LIVE");
    expect(live).toMatchObject({ EXECUTION_MODE: "broker_real_mt5", MT5_EXPECTED_ENVIRONMENT: "live",
      MT5_BRIDGE_URL: "http://live", MT5_EXPECTED_SERVER: "Real", MT5_EXPECTED_LOGIN: "real-login",
      REAL_MONEY_ENABLED: false, LIVE_MT5_ENABLED: false, MT5_ENGINE_MAX_RISK_PERCENT: .1, LIVE_MAX_LOT_SIZE: .01 });
    expect(base.EXECUTION_MODE).toBe("broker_demo_mt5");expect(base.MT5_EXPECTED_LOGIN).toBe("demo-login");
    expect(live).not.toBe(base);
  });
  it("does not leak a LIVE session's identity or backend into a subsequent DEMO session", () => {
    const live = resolveMt5EnvironmentConfig(base, "LIVE");
    const demo = resolveMt5EnvironmentConfig(base, "DEMO");
    expect(demo).toMatchObject({ EXECUTION_MODE: "broker_demo_mt5", MT5_EXPECTED_ENVIRONMENT: "demo",
      MT5_BRIDGE_URL: "http://demo", MT5_EXPECTED_LOGIN: "demo-login", MT5_EXPECTED_SERVER: "Demo" });
    expect(live.MT5_EXPECTED_LOGIN).toBe("real-login");
  });
  it("preserves explicit legacy pinning when LIVE identity overrides are absent", () => {
    const config = { ...base, MT5_LIVE_EXPECTED_LOGIN: undefined, MT5_LIVE_EXPECTED_SERVER: undefined };
    expect(resolveMt5EnvironmentConfig(config, "LIVE").MT5_EXPECTED_LOGIN).toBe("demo-login");
    expect(resolveMt5EnvironmentConfig(config, "LIVE").MT5_EXPECTED_SERVER).toBe("Demo");
  });
  it("leaves missing environment and non-MT5 backends unchanged", () => {
    expect(resolveMt5EnvironmentConfig(base, null)).toBe(base);
    const paper = { ...base, EXECUTION_MODE: "paper_cfd" as const };
    expect(resolveMt5EnvironmentConfig(paper, "LIVE")).toBe(paper);
  });
});
