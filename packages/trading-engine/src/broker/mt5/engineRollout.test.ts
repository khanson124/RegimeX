import { describe, expect, it } from "vitest";
import {
  describeMt5AutonomousAvailability,
  gateMt5EngineSubmission,
  parseCsvAllowlist,
  publicMt5RolloutSnapshot
} from "./engineRollout.js";
import { BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME } from "./engineVolume.js";
import { BROKER_SYMBOL_MAPPING_MISSING, BROKER_SYMBOL_MAPPING_UNVERIFIED } from "./brokerSymbolMapping.js";

const v10Mapping = {
  internalSymbol: "R_10",
  brokerSymbol: "Volatility 10 Index",
  verified: true,
  minVolume: 0.5,
  volumeStep: 0.01,
  maxVolume: 400
};

const demoBase = {
  EXECUTION_MODE: "broker_demo_mt5",
  REAL_MONEY_ENABLED: false,
  MT5_ENGINE_ENABLED: true,
  MT5_TEST_MODE: false,
  MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10",
  MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1",
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS: 1,
  MT5_ENGINE_MAX_VOLUME: 0.5,
  MT5_ENGINE_MAX_RISK_PERCENT: 0.1
};

describe("MT5 engine rollout gates", () => {
  it("treats the allowlist as internal RegimeX symbols", () => {
    expect(parseCsvAllowlist("R_10, R_25")).toEqual(["R_10", "R_25"]);
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).allowed
    ).toBe(true);
  });

  it("does not require the broker-native name on the allowlist", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "Volatility 10 Index",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).decisionCode
    ).toBe("SYMBOL_NOT_ALLOWED");
  });

  it("blocks autonomous submissions when MT5_ENGINE_ENABLED is false", () => {
    const gate = gateMt5EngineSubmission({
      config: { ...demoBase, MT5_ENGINE_ENABLED: false },
      symbol: "R_10",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0,
      mapping: v10Mapping
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("MT5_ENGINE_DISABLED");
    expect(gate.decisionCode).toBe("MT5_ENGINE_DISABLED");
  });

  it("never submits from paper mode even if the engine flag is on", () => {
    const gate = gateMt5EngineSubmission({
      config: { ...demoBase, EXECUTION_MODE: "paper_cfd" },
      symbol: "R_10",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0,
      mapping: v10Mapping
    });
    expect(gate.allowed).toBe(false);
    expect(gate.decisionCode).toBe("PAPER_MODE");
  });

  it("keeps real-money paths impossible", () => {
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, EXECUTION_MODE: "broker_real_mt5", REAL_MONEY_ENABLED: true },
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).decisionCode
    ).toBe("REAL_MONEY_BLOCKED");
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, REAL_MONEY_ENABLED: true },
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).reason
    ).toBe("REAL_MT5_EXECUTION_NOT_IMPLEMENTED");
  });

  it("fail-closes on empty symbol or strategy allowlists", () => {
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, MT5_ENGINE_SYMBOL_ALLOWLIST: "" },
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).reason
    ).toBe("MT5_ENGINE_SYMBOL_ALLOWLIST_EMPTY");
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, MT5_ENGINE_STRATEGY_ALLOWLIST: "  " },
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).reason
    ).toBe("MT5_ENGINE_STRATEGY_ALLOWLIST_EMPTY");
  });

  it("rejects a missing mapping fail-closed", () => {
    const gate = gateMt5EngineSubmission({
      config: demoBase,
      symbol: "R_10",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(BROKER_SYMBOL_MAPPING_MISSING);
    expect(gate.decisionCode).toBe("BROKER_SYMBOL_MAPPING_MISSING");
  });

  it("rejects an unverified mapping fail-closed", () => {
    const gate = gateMt5EngineSubmission({
      config: demoBase,
      symbol: "R_10",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0,
      mapping: { ...v10Mapping, verified: false }
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(BROKER_SYMBOL_MAPPING_UNVERIFIED);
  });

  it("hard-rejects when broker min exceeds engine max volume", () => {
    const gate = gateMt5EngineSubmission({
      config: { ...demoBase, MT5_ENGINE_MAX_VOLUME: 0.01 },
      symbol: "R_10",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0,
      mapping: v10Mapping
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME);
  });

  it("surfaces volume impossibility even while the engine flag is off", () => {
    const availability = describeMt5AutonomousAvailability(
      { ...demoBase, MT5_ENGINE_ENABLED: false, MT5_ENGINE_MAX_VOLUME: 0.01 },
      [v10Mapping]
    );
    expect(availability.enabled).toBe(false);
    expect(availability.blocked).toBe(true);
    expect(availability.reason).toBe(BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME);
  });

  it("enforces strategy allowlists", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "R_10",
        strategyId: "breakout-momentum-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).reason
    ).toBe("MT5_ENGINE_STRATEGY_NOT_ALLOWED");
  });

  it("caps concurrent owned positions", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 1,
        mapping: v10Mapping
      }).decisionCode
    ).toBe("MAX_CONCURRENT_POSITIONS");
  });

  it("blocks degraded/suspended/rejected lifecycles", () => {
    expect(
      gateMt5EngineSubmission({
        config: demoBase,
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        lifecycle: "DEGRADED",
        mapping: v10Mapping
      }).decisionCode
    ).toBe("LIFECYCLE_BLOCKED");
  });

  it("allows an eligible demo signal to pass the submission gate", () => {
    const gate = gateMt5EngineSubmission({
      config: demoBase,
      symbol: "R_10",
      strategyId: "ema-pullback-v1",
      openOwnedCount: 0,
      lifecycle: "EXPERIMENTAL",
      mapping: v10Mapping
    });
    expect(gate.allowed).toBe(true);
    expect(gate.decisionCode).toBe("SUBMIT");
    expect(describeMt5AutonomousAvailability(demoBase, [v10Mapping]).enabled).toBe(true);
    expect(
      describeMt5AutonomousAvailability({ ...demoBase, MT5_ENGINE_ENABLED: false }, [v10Mapping]).enabled
    ).toBe(false);
  });

  it("does not treat MT5_TEST_MODE as autonomous enablement", () => {
    expect(
      gateMt5EngineSubmission({
        config: { ...demoBase, MT5_ENGINE_ENABLED: false, MT5_TEST_MODE: true },
        symbol: "R_10",
        strategyId: "ema-pullback-v1",
        openOwnedCount: 0,
        mapping: v10Mapping
      }).allowed
    ).toBe(false);
  });

  it("exposes allowed internal symbols and resolved broker symbols", () => {
    const snapshot = publicMt5RolloutSnapshot({ ...demoBase, MT5_ENGINE_MAX_VOLUME: 0.01 }, [v10Mapping]);
    expect(snapshot.allowedInternalSymbols).toEqual(["R_10"]);
    expect(snapshot.resolvedBrokerSymbols).toEqual([
      expect.objectContaining({
        internalSymbol: "R_10",
        brokerSymbol: "Volatility 10 Index",
        verified: true,
        minVolume: 0.5
      })
    ]);
    expect(snapshot.engineMaxVolume).toBe(0.01);
  });
});
