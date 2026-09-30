import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MT5_DEMO_XAU_RISK_CAP_EXECUTION_MODE,
  MT5_DEMO_XAU_RISK_CAP_INTERVAL,
  MT5_DEMO_XAU_RISK_CAP_STRATEGY_ID,
  MT5_DEMO_XAU_RISK_CAP_SYMBOL,
  resolveMt5EngineRiskCap
} from "./engineRiskCap.js";

const GLOBAL = 0.1;
const OVERRIDE = 0.2;

const demoXau = {
  executionMode: MT5_DEMO_XAU_RISK_CAP_EXECUTION_MODE,
  symbol: MT5_DEMO_XAU_RISK_CAP_SYMBOL,
  interval: MT5_DEMO_XAU_RISK_CAP_INTERVAL,
  strategyId: MT5_DEMO_XAU_RISK_CAP_STRATEGY_ID,
  globalCap: GLOBAL,
  demoXauCap: OVERRIDE
};

describe("resolveMt5EngineRiskCap", () => {
  it("selects 0.20 for broker_demo_mt5 + XAUUSD + 15m + xau-trend-pullback-v1", () => {
    expect(resolveMt5EngineRiskCap(demoXau)).toEqual({
      globalRiskCap: 0.1,
      selectedRiskCap: 0.2,
      demoXauRiskOverrideApplied: true
    });
  });

  it("keeps 0.10 for DEMO R_10", () => {
    expect(
      resolveMt5EngineRiskCap({
        ...demoXau,
        symbol: "R_10",
        interval: "5m",
        strategyId: "ema-pullback-v1"
      }).selectedRiskCap
    ).toBe(0.1);
    expect(
      resolveMt5EngineRiskCap({ ...demoXau, symbol: "R_10" })
    ).toMatchObject({ selectedRiskCap: 0.1, demoXauRiskOverrideApplied: false });
  });

  it("keeps 0.10 for broker_real_mt5 + XAUUSD", () => {
    expect(
      resolveMt5EngineRiskCap({ ...demoXau, executionMode: "broker_real_mt5" })
    ).toMatchObject({ selectedRiskCap: 0.1, demoXauRiskOverrideApplied: false });
  });

  it("keeps 0.10 for XAUUSD with the wrong strategy", () => {
    expect(
      resolveMt5EngineRiskCap({ ...demoXau, strategyId: "xau-trend-breakout-v2" })
    ).toMatchObject({ selectedRiskCap: 0.1, demoXauRiskOverrideApplied: false });
    expect(
      resolveMt5EngineRiskCap({ ...demoXau, strategyId: "squeeze-breakout-v1" })
    ).toMatchObject({ selectedRiskCap: 0.1, demoXauRiskOverrideApplied: false });
  });

  it("keeps 0.10 for XAUUSD with the wrong interval", () => {
    expect(resolveMt5EngineRiskCap({ ...demoXau, interval: "1m" }).selectedRiskCap).toBe(0.1);
    expect(resolveMt5EngineRiskCap({ ...demoXau, interval: "5m" }).selectedRiskCap).toBe(0.1);
    expect(resolveMt5EngineRiskCap({ ...demoXau, interval: "4h" }).selectedRiskCap).toBe(0.1);
  });

  it("falls back to the global cap when the override is missing or unusable", () => {
    for (const demoXauCap of [undefined, null, 0, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveMt5EngineRiskCap({ ...demoXau, demoXauCap }),
        String(demoXauCap)
      ).toMatchObject({ selectedRiskCap: 0.1, demoXauRiskOverrideApplied: false });
    }
  });

  it("RiskProfile remains an upper bound of the selected cap", () => {
    const selected = resolveMt5EngineRiskCap(demoXau).selectedRiskCap;
    expect(Math.min(0.15, selected)).toBe(0.15);
    expect(Math.min(0.5, selected)).toBe(0.2);
    expect(Math.min(0.5, resolveMt5EngineRiskCap({ ...demoXau, symbol: "R_10" }).selectedRiskCap)).toBe(
      0.1
    );
  });

  it("leaves existing non-XAU DEMO behavior on the global cap", () => {
    expect(
      resolveMt5EngineRiskCap({
        executionMode: "broker_demo_mt5",
        symbol: "R_25",
        interval: "5m",
        strategyId: "ema-pullback-v1",
        globalCap: GLOBAL,
        demoXauCap: OVERRIDE
      })
    ).toMatchObject({ selectedRiskCap: 0.1, demoXauRiskOverrideApplied: false });
    expect(
      resolveMt5EngineRiskCap({
        executionMode: "paper_cfd",
        symbol: MT5_DEMO_XAU_RISK_CAP_SYMBOL,
        interval: MT5_DEMO_XAU_RISK_CAP_INTERVAL,
        strategyId: MT5_DEMO_XAU_RISK_CAP_STRATEGY_ID,
        globalCap: GLOBAL,
        demoXauCap: OVERRIDE
      }).selectedRiskCap
    ).toBe(0.1);
  });

  it("does not read env, mutate config, or touch the database", () => {
    const src = readFileSync(new URL("./engineRiskCap.ts", import.meta.url), "utf8");
    for (const banned of ["prisma", "Prisma", "process.env", "loadConfig", "writeFile", "@regimex/config"]) {
      expect(src).not.toContain(banned);
    }
  });
});
