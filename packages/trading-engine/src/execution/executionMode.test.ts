import { describe, expect, it } from "vitest";
import {
  assertLegacyBinaryReachable,
  isPaperCfdExecution,
  resolveExecutionBackend
} from "./executionMode.js";

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
});
