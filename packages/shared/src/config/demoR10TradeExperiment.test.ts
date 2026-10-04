import { describe, expect, it } from "vitest";
import { isDemoR10TradeExperimentActive, DEMO_R10_TRADE_EXPERIMENT_DURATION_MS } from "./demoR10TradeExperiment.js";
describe("trade experiment expiry", () => {
  const now = 1_800_000_000_000;
  it("accepts an expiry up to seven days and expires at the deadline", () => {
    const raw = String(now + DEMO_R10_TRADE_EXPERIMENT_DURATION_MS);
    expect(isDemoR10TradeExperimentActive(raw, now)).toBe(true);
    expect(isDemoR10TradeExperimentActive(raw, Number(raw))).toBe(false);
  });
  it.each([null, "", "true", "123x", "Infinity", "1.5", "9007199254740992"])("rejects malformed values: %s", (raw) => {
    expect(isDemoR10TradeExperimentActive(raw, now)).toBe(false);
  });
});
