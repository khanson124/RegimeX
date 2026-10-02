import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "./index.js";
const required = {
  DATABASE_URL: "postgresql://regimex:regimex@localhost:5432/regimex",
  JWT_ACCESS_SECRET: "a".repeat(32), JWT_REFRESH_SECRET: "b".repeat(32),
  CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32)
};
afterEach(resetConfigCache);
describe("MT5_DEMO_LIFECYCLE_BYPASS config", () => {
  it("defaults to no bypass", () => {
    resetConfigCache();
    expect(loadConfig(required).MT5_DEMO_LIFECYCLE_BYPASS).toBe("");
  });
  it.each(["", "R_10:squeeze-breakout-v1", "R_10:squeeze-breakout-v1, R_25:ema-pullback-v1", "malformed"])(
    "passes CSV text through for fail-closed matching: %s", (value) => {
      resetConfigCache();
      const parsed = loadConfig({ ...required, MT5_DEMO_LIFECYCLE_BYPASS: value });
      expect(parsed.MT5_DEMO_LIFECYCLE_BYPASS).toBe(value);
      expect(parsed.MT5_EVIDENCE_CONSECUTIVE_LOSSES_SUSPEND).toBe(8);
      expect(parsed.MT5_ENGINE_MAX_RISK_PERCENT).toBe(0.1);
    });
});
