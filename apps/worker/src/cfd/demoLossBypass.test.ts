import { describe, expect, it, vi } from "vitest";
import { isDemoR10LossBypassActive } from "@regimex/shared";
import { gateMt5EngineSubmission } from "@regimex/trading-engine";
import { readDemoLossBypassScope, demoLossBypassGateConfig } from "./demoLossBypass.js";
const now = 1_800_000_000_000;
const input = { userId: "user", executionMode: "broker_demo_mt5", sessionMode: "DEMO_TRADING",
  symbol: "R_10", strategyId: "ema-pullback-v1" };
const baseConfig = { REAL_MONEY_ENABLED: false, EXECUTION_MODE: "broker_demo_mt5", MT5_ENGINE_ENABLED: true,
  MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10", MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1,squeeze-breakout-v1",
  MT5_ENGINE_MAX_VOLUME: 0.5, MT5_ENGINE_MAX_CONCURRENT_POSITIONS: 1 };
const mapping = { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index", verified: true,
  minVolume: 0.5, volumeStep: 0.01, maxVolume: 400 };
describe("worker DEMO loss switch", () => {
  it.each(["ema-pullback-v1", "squeeze-breakout-v1"])("only temporarily bypasses SUSPENDED for %s", async (strategyId) => {
    const scope = await readDemoLossBypassScope({ ...input, strategyId }, async () => String(now + 1000));
    const config = demoLossBypassGateConfig(baseConfig, scope, now);
    const gate = (lifecycle: "SUSPENDED" | "REJECTED") => gateMt5EngineSubmission({
      config, symbol: "R_10", strategyId, lifecycle, openOwnedCount: 0, mapping });
    expect(gate("SUSPENDED").allowed).toBe(true);
    expect(gate("REJECTED").decisionCode).toBe("LIFECYCLE_BLOCKED");
    expect(baseConfig).not.toHaveProperty("MT5_DEMO_LIFECYCLE_BYPASS");
    expect(gateMt5EngineSubmission({ config: demoLossBypassGateConfig(baseConfig, scope, now + 1000),
      symbol: "R_10", strategyId, lifecycle: "SUSPENDED", openOwnedCount: 0, mapping })
      .decisionCode).toBe("LIFECYCLE_BLOCKED");
  });
  it.each([{ executionMode: "broker_real_mt5" }, { sessionMode: "LIVE_TRADING" }, { symbol: "XAUUSD" }])(
    "never reads/applies the switch outside DEMO R_10: %s", async (override) => {
      const read = vi.fn().mockResolvedValue(String(now + 1000));
      const scope = await readDemoLossBypassScope({ ...input, ...override }, read);
      expect(read).not.toHaveBeenCalled();
      expect(demoLossBypassGateConfig(baseConfig, scope, now)).toBe(baseConfig);
    });
  it("OFF, unavailable storage, and malformed values fail closed", async () => {
    for (const raw of [null, "true", ""]) {
      const scope = await readDemoLossBypassScope(input, async () => raw);
      expect(demoLossBypassGateConfig(baseConfig, scope, now)).toBe(baseConfig);
    }
    const warn = vi.fn();
    const scope = await readDemoLossBypassScope(input, async () => { throw new Error("Redis down"); }, warn);
    expect(scope.expiresAtMs).toBeNull(); expect(warn).toHaveBeenCalledOnce();
  });
  it("fresh reads observe disabling during an in-flight attempt", async () => {
    const read = vi.fn().mockResolvedValueOnce(String(now + 1000)).mockResolvedValueOnce(null);
    expect(isDemoR10LossBypassActive(await readDemoLossBypassScope(input, read), now)).toBe(true);
    expect(isDemoR10LossBypassActive(await readDemoLossBypassScope(input, read), now)).toBe(false);
  });
  it("OFF takes precedence over legacy R_10 env bypass entries without changing other entries", async () => {
    const scope = await readDemoLossBypassScope(input, async () => null);
    const config = demoLossBypassGateConfig({ ...baseConfig,
      MT5_DEMO_LIFECYCLE_BYPASS: "R_10:ema-pullback-v1,XAUUSD:other" }, scope, now);
    expect(config.MT5_DEMO_LIFECYCLE_BYPASS).toBe("XAUUSD:other");
    expect(gateMt5EngineSubmission({ config, symbol: "R_10", strategyId: input.strategyId,
      lifecycle: "SUSPENDED", openOwnedCount: 0, mapping }).decisionCode).toBe("LIFECYCLE_BLOCKED");
  });
  it("retains ordinary allowlist, mapping and capacity gates", async () => {
    const scope = await readDemoLossBypassScope(input, async () => String(now + 1000));
    const config = demoLossBypassGateConfig(baseConfig, scope, now);
    expect(gateMt5EngineSubmission({ config, symbol: "R_10", strategyId: input.strategyId,
      lifecycle: "SUSPENDED", mapping, openOwnedCount: 1 }).decisionCode).toBe("MAX_CONCURRENT_POSITIONS");
    expect(gateMt5EngineSubmission({ config, symbol: "R_10", strategyId: "unlisted",
      lifecycle: "SUSPENDED", mapping, openOwnedCount: 0 }).decisionCode).toBe("STRATEGY_NOT_ALLOWED");
  });
});
