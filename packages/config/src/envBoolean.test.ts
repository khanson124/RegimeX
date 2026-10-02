import { describe, expect, it } from "vitest";
import { parseEnvBoolean } from "./envBoolean.js";
import { loadConfig, resetConfigCache } from "./index.js";

const required = {
  DATABASE_URL: "postgresql://regimex:regimex@localhost:5432/regimex",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32)
};

describe("parseEnvBoolean", () => {
  it("treats the string false as false (z.coerce.boolean does not)", () => {
    expect(parseEnvBoolean("false")).toBe(false);
    expect(parseEnvBoolean("FALSE")).toBe(false);
    expect(parseEnvBoolean("0")).toBe(false);
    expect(parseEnvBoolean("off")).toBe(false);
    expect(parseEnvBoolean("no")).toBe(false);
    expect(Boolean("false")).toBe(true);
  });

  it("treats true-like strings as true", () => {
    expect(parseEnvBoolean("true")).toBe(true);
    expect(parseEnvBoolean("1")).toBe(true);
    expect(parseEnvBoolean("yes")).toBe(true);
    expect(parseEnvBoolean("on")).toBe(true);
  });
});

describe("loadConfig boolean env", () => {
  it("parses MT5_ENGINE_ENABLED=false and REAL_MONEY_ENABLED=false as false", () => {
    resetConfigCache();
    const config = loadConfig({
      ...required,
      EXECUTION_MODE: "broker_demo_mt5",
      REAL_MONEY_ENABLED: "false",
      MT5_ENGINE_ENABLED: "false",
      MT5_TEST_MODE: "true",
      MT5_BRIDGE_URL: "http://mt5-bridge:8765",
      MT5_BRIDGE_SECRET: "test-secret-value-32chars-long!"
    });
    expect(config.REAL_MONEY_ENABLED).toBe(false);
    expect(config.MT5_ENGINE_ENABLED).toBe(false);
    expect(config.MT5_TEST_MODE).toBe(true);
    expect(config.EXECUTION_MODE).toBe("broker_demo_mt5");
  });

  it("parses the DEMO XAU risk-cap override and fail-closes when it is missing or invalid", () => {
    resetConfigCache();
    const withOverride = loadConfig({
      ...required,
      EXECUTION_MODE: "broker_demo_mt5",
      MT5_DEMO_XAUUSD_MAX_RISK_PERCENT: "0.2"
    });
    expect(withOverride.MT5_ENGINE_MAX_RISK_PERCENT).toBe(0.1);
    expect(withOverride.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT).toBe(0.2);

    resetConfigCache();
    const missing = loadConfig({
      ...required,
      EXECUTION_MODE: "broker_demo_mt5",
      MT5_DEMO_XAUUSD_MAX_RISK_PERCENT: ""
    });
    expect(missing.MT5_ENGINE_MAX_RISK_PERCENT).toBe(0.1);
    expect(missing.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT).toBeUndefined();

    resetConfigCache();
    const invalid = loadConfig({
      ...required,
      EXECUTION_MODE: "broker_demo_mt5",
      MT5_DEMO_XAUUSD_MAX_RISK_PERCENT: "not-a-number"
    });
    expect(invalid.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT).toBeUndefined();
  });
});


describe("DEMO XAU session env", () => {
  it("accepts midnight and end-of-day without altering risk settings", () => {
    resetConfigCache();
    const config = loadConfig({ ...required,
      MT5_DEMO_XAUUSD_SESSION_START_UTC: "0", MT5_DEMO_XAUUSD_SESSION_END_UTC: "24",
      MT5_DEMO_XAUUSD_MAX_RISK_PERCENT: "0.2"
    });
    expect(config.MT5_DEMO_XAUUSD_SESSION_START_UTC).toBe(0);
    expect(config.MT5_DEMO_XAUUSD_SESSION_END_UTC).toBe(24);
    expect(config.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT).toBe(0.2);
    expect(config.MT5_ENGINE_MAX_RISK_PERCENT).toBe(0.1);
  });

  it.each([undefined, "", " ", "invalid", "NaN", "Infinity", "-1", "25", "0.5"])(
    "disables invalid optional hours: %s", (value) => {
      resetConfigCache();
      const config = loadConfig({ ...required,
        MT5_DEMO_XAUUSD_SESSION_START_UTC: value, MT5_DEMO_XAUUSD_SESSION_END_UTC: value
      });
      expect(config.MT5_DEMO_XAUUSD_SESSION_START_UTC).toBeUndefined();
      expect(config.MT5_DEMO_XAUUSD_SESSION_END_UTC).toBeUndefined();
    }
  );
});
