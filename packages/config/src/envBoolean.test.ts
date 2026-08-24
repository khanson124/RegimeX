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
});
