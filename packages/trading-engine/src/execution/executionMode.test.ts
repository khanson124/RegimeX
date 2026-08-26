import { describe, expect, it } from "vitest";
import {
  assertCfdExecutionReachable,
  assertLegacyBinaryReachable,
  isPaperCfdExecution,
  resolveExecutionBackend
} from "./executionMode.js";

const mt5Demo = {
  EXECUTION_MODE: "broker_demo_mt5" as const,
  LEGACY_BINARY_ENABLED: false,
  REAL_MONEY_ENABLED: false,
  MT5_BRIDGE_SECRET: "test-secret-value-32chars-long!",
  MT5_BRIDGE_URL: "http://mt5-bridge:8765",
  MT5_EXPECTED_ENVIRONMENT: "demo" as const
};

describe("executionMode", () => {
  it("defaults to paper_cfd", () => {
    expect(
      resolveExecutionBackend({
        EXECUTION_MODE: "paper_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toBe("paper_cfd");
  });

  it("blocks legacy_binary without LEGACY_BINARY_ENABLED", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "legacy_binary",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/LEGACY_BINARY_ENABLED/);
  });

  it("blocks legacy execution helpers when paper_cfd is active", () => {
    const cfg = {
      EXECUTION_MODE: "paper_cfd" as const,
      LEGACY_BINARY_ENABLED: false,
      REAL_MONEY_ENABLED: false
    };
    expect(isPaperCfdExecution(cfg)).toBe(true);
    expect(() => assertLegacyBinaryReachable(cfg)).toThrow(/blocked/);
    expect(() => assertCfdExecutionReachable(cfg)).not.toThrow();
  });

  it("fail-closed for broker_real_cfd with REAL_CFD_EXECUTION_NOT_IMPLEMENTED", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_real_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/REAL_CFD_EXECUTION_NOT_IMPLEMENTED/);
  });

  it("fail-closed for broker_demo_cfd without credentials", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_demo_cfd",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/CTRADER_CLIENT_ID/);
  });

  it("fail-closed for broker_real_mt5 with REAL_MT5_EXECUTION_NOT_IMPLEMENTED", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_real_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: true
      })
    ).toThrow(/REAL_MT5_EXECUTION_NOT_IMPLEMENTED/);
  });

  it("fail-closed for broker_demo_mt5 without credentials", () => {
    expect(() =>
      resolveExecutionBackend({
        EXECUTION_MODE: "broker_demo_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/MT5_BRIDGE_SECRET/);
  });

  it("allows broker_demo_mt5 with secret and REAL_MONEY_ENABLED=false", () => {
    expect(resolveExecutionBackend(mt5Demo)).toBe("broker_demo_mt5");
  });

  it("blocks legacy binary proposal/buy while EXECUTION_MODE=broker_demo_mt5", () => {
    expect(() => assertLegacyBinaryReachable(mt5Demo)).toThrow(/Legacy binary execution/);
  });

  it("allows CFD BUY/SELL path while EXECUTION_MODE=broker_demo_mt5", () => {
    expect(() => assertCfdExecutionReachable(mt5Demo)).not.toThrow();
  });

  it("broker_real_mt5 remains impossible on the CFD guard", () => {
    expect(() =>
      assertCfdExecutionReachable({
        EXECUTION_MODE: "broker_real_mt5",
        LEGACY_BINARY_ENABLED: false,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/REAL_MT5_EXECUTION_NOT_IMPLEMENTED/);
  });

  it("REAL_MONEY_ENABLED=true still does not create a funded path", () => {
    expect(() =>
      assertCfdExecutionReachable({
        ...mt5Demo,
        REAL_MONEY_ENABLED: true
      })
    ).toThrow(/REAL_MONEY_ENABLED/);
    expect(() =>
      resolveExecutionBackend({
        ...mt5Demo,
        REAL_MONEY_ENABLED: true
      })
    ).toThrow(/REAL_MONEY_ENABLED/);
  });

  it("legacy binary remains isolated to LEGACY_BINARY_ENABLED", () => {
    expect(() =>
      assertLegacyBinaryReachable({
        EXECUTION_MODE: "legacy_binary",
        LEGACY_BINARY_ENABLED: true,
        REAL_MONEY_ENABLED: false
      })
    ).not.toThrow();
    expect(() =>
      assertCfdExecutionReachable({
        EXECUTION_MODE: "legacy_binary",
        LEGACY_BINARY_ENABLED: true,
        REAL_MONEY_ENABLED: false
      })
    ).toThrow(/legacy_binary/);
  });
});
