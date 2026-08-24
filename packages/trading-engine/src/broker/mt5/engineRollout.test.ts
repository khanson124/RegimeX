import { describe, expect, it } from "vitest";
import {
  describeMt5AutonomousAvailability,
  engineSymbolToMt5BrokerSymbol,
  gateMt5EngineSubmission,
  parseCsvAllowlist
} from "./engineRollout.js";

const demoBase = {
  EXECUTION_MODE: "broker_demo_mt5",
  REAL_MONEY_ENABLED: false,
  MT5_ENGINE_ENABLED: true,
  MT5_TEST_MODE: false,
  MT5_ENGINE_SYMBOL_ALLOWLIST: "EURUSD",
  MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1",
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS: 1
};

describe("MT5 engine rollout gates", () => {
  it("maps frx forex catalogue names to MT5 broker symbols", () => {
    expect(engineSymbolToMt5BrokerSymbol("frxEURUSD")).toBe("EURUSD");
    expect(engineSymbolToMt5BrokerSymbol("EURUSD")).toBe("EURUSD");
    expect(parseCsvAllowlist("EURUSD, GBPUSD")).toEqual(["EURUSD", "GBPUSD"]);
  });

  it("blocks autonomous submissions when MT5_ENGINE_ENABLED is false", () => {
    const gate = gateMt5EngineSubmission({
      config: { ...demoBase, MT5_ENGINE_ENABLED: false },
      symbol: "EURUSD",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("MT5_ENGINE_DISABLED");
    expect(gate.decisionCode).toBe("MT5_ENGINE_DISABLED");
  });

  it("never submits from paper mode even if the engine flag is on", () => {
    const gate = gateMt5EngineSubmission({
      config: { ...demoBase, EXECUTION_MODE: "paper_cfd" },
      symbol: "EURUSD",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0
    });
    expect(gate.allowed).toBe(false);
    expect(gate.decisionCode).toBe("PAPER_MODE");
  });

  it("keeps real-money paths impossible", () => {
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, EXECUTION_MODE: "broker_real_mt5", REAL_MONEY_ENABLED: true },
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).decisionCode
    ).toBe("REAL_MONEY_BLOCKED");
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, REAL_MONEY_ENABLED: true },
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).reason
    ).toBe("REAL_MT5_EXECUTION_NOT_IMPLEMENTED");
  });

  it("fail-closes on empty symbol or strategy allowlists", () => {
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, MT5_ENGINE_SYMBOL_ALLOWLIST: "" },
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).reason
    ).toBe("MT5_ENGINE_SYMBOL_ALLOWLIST_EMPTY");
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, MT5_ENGINE_STRATEGY_ALLOWLIST: "  " },
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).reason
    ).toBe("MT5_ENGINE_STRATEGY_ALLOWLIST_EMPTY");
  });

  it("enforces symbol and strategy allowlists", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "GBPUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).reason
    ).toBe("MT5_ENGINE_SYMBOL_NOT_ALLOWED");
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "EURUSD",
        strategyId: "breakout-momentum-v1",
        openOwnedCount: 0
      }).reason
    ).toBe("MT5_ENGINE_STRATEGY_NOT_ALLOWED");
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "frxEURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).allowed
    ).toBe(true);
  });

  it("caps concurrent owned positions", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 1
      }).reason
    ).toBe("MT5_ENGINE_MAX_CONCURRENT");
  });

  it("blocks degraded/suspended/rejected lifecycles as evidence", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        lifecycle: "DEGRADED"
      }).decisionCode
    ).toBe("EVIDENCE_BLOCKED");
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        lifecycle: "SUSPENDED"
      }).decisionCode
    ).toBe("EVIDENCE_BLOCKED");
  });

  it("allows an eligible demo signal to pass the submission gate", () => {
    const gate = gateMt5EngineSubmission({
      config: demoBase,
      symbol: "EURUSD",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0,
      lifecycle: "EXPERIMENTAL"
    });
    expect(gate.allowed).toBe(true);
    expect(gate.decisionCode).toBe("SUBMIT");
    expect(describeMt5AutonomousAvailability(demoBase).enabled).toBe(true);
    expect(describeMt5AutonomousAvailability({ ...demoBase, MT5_ENGINE_ENABLED: false }).enabled).toBe(
      false
    );
  });

  it("does not treat MT5_TEST_MODE as autonomous enablement", () => {
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, MT5_ENGINE_ENABLED: false, MT5_TEST_MODE: true },
        symbol: "EURUSD",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0
      }).allowed
    ).toBe(false);
  });
});
