import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "./index.js";
const required = { DATABASE_URL: "postgresql://test:test@localhost:5432/test", JWT_ACCESS_SECRET: "a".repeat(32),
 JWT_REFRESH_SECRET: "b".repeat(32), CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32) };
afterEach(resetConfigCache);
describe("R_10 DEMO HTF shadow configuration", () => {
  it("defaults OFF and keeps risk/lifecycle defaults intact", () => {
    const c = loadConfig(required);
    expect(c.MT5_DEMO_R10_HTF_SHADOW_ENABLED).toBe(false);
    expect(c.MT5_ENGINE_MAX_RISK_PERCENT).toBe(.1);
    expect(c.MT5_EVIDENCE_CONSECUTIVE_LOSSES_SUSPEND).toBe(8);
    expect(c.REAL_MONEY_ENABLED).toBe(false);
  });
  it.each([["true", true], ["false", false]])("parses %s explicitly", (raw, expected) => {
    resetConfigCache(); expect(loadConfig({ ...required, MT5_DEMO_R10_HTF_SHADOW_ENABLED: raw }).MT5_DEMO_R10_HTF_SHADOW_ENABLED).toBe(expected);
  });
});
