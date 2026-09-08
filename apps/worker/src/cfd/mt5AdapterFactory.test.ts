import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveMt5BridgeUrl } from "@regimex/trading-engine";
import { buildDerivMt5BrokerConfig } from "./mt5AdapterFactory.js";
import { researchDatasetPath, resolveResearchDatasetsDir } from "../lib/researchDatasetsPath.js";

function demoConfig(overrides: Record<string, unknown> = {}) {
  return {
    EXECUTION_MODE: "broker_demo_mt5",
    REAL_MONEY_ENABLED: false,
    MT5_BRIDGE_SECRET: "test-secret-value-32chars-long!!",
    MT5_COMMAND_TIMEOUT_MS: 15_000,
    MAX_EXECUTION_QUOTE_AGE_MS: 30_000,
    MT5_MAX_TEST_VOLUME: 0.01,
    MT5_MAX_TEST_RISK_PERCENT: 0.1,
    MT5_MAGIC_NUMBER: 26082301,
    MT5_EXPECTED_BROKER: "Deriv",
    MT5_EXPECTED_ENVIRONMENT: "demo",
    MT5_EXPECTED_SERVER: null,
    MT5_EXPECTED_LOGIN: null,
    ...overrides
  } as never;
}

describe("shared MT5 adapter factory (R_10 + XAUUSD tooling)", () => {
  it("resolves bridge URL without MT5_BRIDGE_URL (Compose/default host path)", () => {
    expect(
      resolveMt5BridgeUrl({
        EXECUTION_MODE: "broker_demo_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false,
        MT5_BRIDGE_HOST: "mt5-bridge",
        MT5_BRIDGE_PORT: 8765
      })
    ).toBe("http://mt5-bridge:8765");

    expect(
      resolveMt5BridgeUrl({
        EXECUTION_MODE: "broker_demo_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toBe("http://mt5-bridge:8765");
  });

  it("buildDerivMt5BrokerConfig does not require MT5_BRIDGE_URL in env", () => {
    const cfg = buildDerivMt5BrokerConfig(
      demoConfig({
        MT5_BRIDGE_URL: undefined,
        MT5_BRIDGE_HOST: "mt5-bridge",
        MT5_BRIDGE_PORT: 8765
      })
    );
    expect(cfg.bridgeUrl).toBe("http://mt5-bridge:8765");
    expect(cfg.requireDemoAccount).toBe(true);
  });

  it("discovery/observe scripts use createConfiguredMt5Client and do not early-gate on MT5_BRIDGE_URL", () => {
    const discover = readFileSync(resolve(process.cwd(), "scripts/discoverXauUsdMt5.ts"), "utf8");
    const observe = readFileSync(resolve(process.cwd(), "scripts/observeXauUsdMt5Spreads.ts"), "utf8");
    expect(discover).toContain("createConfiguredMt5Client");
    expect(observe).toContain("createConfiguredMt5Client");
    expect(discover).not.toContain("MT5_BRIDGE_NOT_CONFIGURED");
    expect(discover).not.toMatch(/if\s*\(\s*!config\.MT5_BRIDGE_URL/);
    expect(observe).not.toMatch(/if\s*\(\s*!config\.MT5_BRIDGE_URL/);
    // Read-only: no openMarket / openMarketPosition
    expect(discover).not.toContain("openMarket");
    expect(observe).not.toContain("openMarket");
    expect(discover).not.toContain("MT5_ENGINE_SYMBOL_ALLOWLIST");
    expect(observe).not.toContain("startSession");
  });

  it("keeps XAUUSD telemetry path isolated from R_10", () => {
    const prev = process.env.RESEARCH_DATASETS_DIR;
    process.env.RESEARCH_DATASETS_DIR = "/tmp/rx-research-test-datasets";
    try {
      const dir = resolveResearchDatasetsDir();
      expect(researchDatasetPath("XAUUSD_mt5_passive_spread_samples.jsonl")).toBe(
        `${dir}/XAUUSD_mt5_passive_spread_samples.jsonl`
      );
      expect(researchDatasetPath("R_10_mt5_passive_spread_samples.jsonl")).toBe(
        `${dir}/R_10_mt5_passive_spread_samples.jsonl`
      );
      expect(researchDatasetPath("XAUUSD_mt5_passive_spread_samples.jsonl")).not.toBe(
        researchDatasetPath("R_10_mt5_passive_spread_samples.jsonl")
      );
    } finally {
      if (prev === undefined) delete process.env.RESEARCH_DATASETS_DIR;
      else process.env.RESEARCH_DATASETS_DIR = prev;
    }
  });
});
