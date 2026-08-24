import { describe, expect, it } from "vitest";
import { createBrokerAdapter } from "../legacyDerivOptionsBroker.js";
import {
  assertMt5DemoAdapterAllowed,
  buildMt5StatusEnvelope,
  gateMt5EngineOrders,
  isMt5DemoApiEnabled,
  isMt5EngineAutomationEnabled,
  isMt5RealPath,
  REAL_MT5_NOT_IMPLEMENTED
} from "./demoAccess.js";
import { aggregatePaperForwardPerformance } from "../../research/paperForwardAggregator.js";
import { aggregateMt5BrokerDemoForwardPerformance } from "../../research/mt5BrokerDemoForwardAggregator.js";

const paperStub = { name: "paper_cfd" } as never;

describe("MT5 demo access / status diagnostics", () => {
  it("broker_demo_mt5 + REAL_MONEY_ENABLED=false is a demo API path", () => {
    const config = {
      EXECUTION_MODE: "broker_demo_mt5",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: false,
      MT5_TEST_MODE: true
    };
    expect(isMt5RealPath(config)).toBe(false);
    expect(() => assertMt5DemoAdapterAllowed(config)).not.toThrow();
    expect(isMt5DemoApiEnabled(config)).toBe(true);
    expect(isMt5EngineAutomationEnabled(config)).toBe(false);
    const status = buildMt5StatusEnvelope(config, { connected: false });
    expect(status.status.mode).toBe("broker_demo_mt5");
    expect(status.status.enabled).toBe(true);
    expect(status.status.engineAutomationEnabled).toBe(false);
    expect(status.status.error).toBeNull();
  });

  it("does not construct/use a real adapter for broker_demo_mt5", () => {
    const adapter = createBrokerAdapter({
      executionMode: "broker_demo_mt5",
      legacyBinaryEnabled: false,
      paper: paperStub,
      derivMt5: { name: "deriv_mt5_demo" } as never
    });
    expect(adapter.name).toBe("deriv_mt5_demo");
  });

  it("reports MT5_ENGINE_ENABLED=false correctly even when test mode is on", () => {
    const status = buildMt5StatusEnvelope({
      EXECUTION_MODE: "broker_demo_mt5",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: false,
      MT5_TEST_MODE: true
    });
    expect(status.status.engineAutomationEnabled).toBe(false);
    expect((status.status.config as { mt5EngineEnabled: boolean }).mt5EngineEnabled).toBe(false);
    expect(gateMt5EngineOrders({
      EXECUTION_MODE: "broker_demo_mt5",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: false
    }).reason).toBe("MT5_ENGINE_DISABLED");
  });

  it("broker_real_mt5 is always blocked", () => {
    const config = {
      EXECUTION_MODE: "broker_real_mt5",
      REAL_MONEY_ENABLED: true,
      MT5_ENGINE_ENABLED: true,
      MT5_TEST_MODE: true
    };
    expect(isMt5RealPath(config)).toBe(true);
    expect(() => assertMt5DemoAdapterAllowed(config)).toThrow(REAL_MT5_NOT_IMPLEMENTED);
    expect(isMt5DemoApiEnabled(config)).toBe(false);
    expect(isMt5EngineAutomationEnabled(config)).toBe(false);
    const status = buildMt5StatusEnvelope(config);
    expect(status.status.enabled).toBe(false);
    expect(status.status.error).toBe(REAL_MT5_NOT_IMPLEMENTED);
    expect(() =>
      createBrokerAdapter({
        executionMode: "broker_real_mt5",
        legacyBinaryEnabled: false,
        paper: paperStub
      })
    ).toThrow(REAL_MT5_NOT_IMPLEMENTED);
  });

  it("paper_cfd status is idle unless MT5_TEST_MODE", () => {
    const idle = buildMt5StatusEnvelope({
      EXECUTION_MODE: "paper_cfd",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: false,
      MT5_TEST_MODE: false
    });
    expect(idle.status.mode).toBe("paper_cfd");
    expect(idle.status.enabled).toBe(false);
    expect(idle.status.engineAutomationEnabled).toBe(false);
    expect(String(idle.status.message)).toMatch(/paper_cfd/i);

    const testOnly = buildMt5StatusEnvelope({
      EXECUTION_MODE: "paper_cfd",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: false,
      MT5_TEST_MODE: true
    });
    expect(testOnly.status.enabled).toBe(true);
    expect(testOnly.status.engineAutomationEnabled).toBe(false);
    expect(isMt5EngineAutomationEnabled({
      EXECUTION_MODE: "paper_cfd",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: true,
      MT5_TEST_MODE: true
    })).toBe(false);
  });

  it("MT5_TEST_MODE permits guarded APIs without engine automation", () => {
    const config = {
      EXECUTION_MODE: "broker_demo_mt5",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: false,
      MT5_TEST_MODE: true
    };
    expect(isMt5DemoApiEnabled(config)).toBe(true);
    expect(isMt5EngineAutomationEnabled(config)).toBe(false);
    expect(gateMt5EngineOrders(config).allowed).toBe(false);
  });

  it("includes internal/broker mapping diagnostics without enabling trading", () => {
    const status = buildMt5StatusEnvelope(
      {
        EXECUTION_MODE: "broker_demo_mt5",
        REAL_MONEY_ENABLED: false,
        MT5_ENGINE_ENABLED: false,
        MT5_TEST_MODE: true,
        MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10",
        MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1",
        MT5_ENGINE_MAX_VOLUME: 0.01
      },
      { connected: true },
      null,
      [
        {
          internalSymbol: "R_10",
          brokerSymbol: "Volatility 10 Index",
          verified: true,
          minVolume: 0.5,
          volumeStep: 0.01,
          maxVolume: 400
        }
      ]
    );
    const config = status.status.config as {
      rollout: {
        allowedInternalSymbols: string[];
        resolvedBrokerSymbols: Array<{ brokerSymbol: string; verified: boolean }>;
        engineMaxVolume: number;
      };
      autonomous: { blocked: boolean; reason: string | null };
      engineAutomationEnabled: boolean;
    };
    expect(config.engineAutomationEnabled).toBe(false);
    expect(config.rollout.allowedInternalSymbols).toEqual(["R_10"]);
    expect(config.rollout.resolvedBrokerSymbols[0]?.brokerSymbol).toBe("Volatility 10 Index");
    expect(config.rollout.engineMaxVolume).toBe(0.01);
    expect(config.autonomous.blocked).toBe(true);
    expect(config.autonomous.reason).toBe("BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME");
  });

  it("keeps paper and MT5 forward lanes separate", () => {
    const paperRow = {
      strategyId: "ema",
      symbol: "X",
      interval: "1m",
      regime: "STRONG_UPTREND",
      direction: "BUY" as const,
      entryPrice: 1,
      exitPrice: 2,
      volume: 0.01,
      realizedPnl: 1,
      riskAmount: 1,
      openedAt: 1,
      closedAt: 2,
      origin: "ENGINE",
      executionVenue: "PAPER" as const
    };
    const mt5Row = { ...paperRow, realizedPnl: 99, executionVenue: "MT5_DEMO" as const };
    expect(aggregatePaperForwardPerformance([paperRow, mt5Row])).toHaveLength(1);
    expect(aggregatePaperForwardPerformance([paperRow, mt5Row])[0]?.tradeCount).toBe(1);
    expect(aggregateMt5BrokerDemoForwardPerformance([paperRow, mt5Row])).toHaveLength(1);
    expect(aggregateMt5BrokerDemoForwardPerformance([mt5Row])[0]?.tradeCount).toBe(1);
    expect(aggregateMt5BrokerDemoForwardPerformance([{ ...mt5Row, origin: "TEST" }])).toEqual([]);
  });
});
