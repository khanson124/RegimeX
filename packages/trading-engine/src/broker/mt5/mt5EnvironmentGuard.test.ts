import { describe, expect, it } from "vitest";
import { validateMt5ExecutionEnvironment, assertMt5LiveAccount } from "./mt5EnvironmentGuard.js";
import type { Mt5AccountInfo } from "./types.js";

function account(overrides: Partial<Mt5AccountInfo> = {}): Mt5AccountInfo {
  return {
    login: "123456",
    tradeMode: "DEMO",
    marginMode: "HEDGING",
    company: "Deriv Limited",
    server: "Deriv-Demo",
    currency: "USD",
    leverage: 100,
    balance: 10_000,
    equity: 10_000,
    margin: 0,
    freeMargin: 10_000,
    floatingPnl: 0,
    ...overrides
  };
}

describe("validateMt5ExecutionEnvironment", () => {
  it("demo mode accepts demo account", () => {
    const result = validateMt5ExecutionEnvironment({
      account: account(),
      expectedEnvironment: "demo",
      expectedBroker: "Deriv",
      expectedServer: "Deriv-Demo"
    });
    expect(result.ok).toBe(true);
    expect(result.environment).toBe("demo");
  });

  it("demo mode rejects real account", () => {
    const result = validateMt5ExecutionEnvironment({
      account: account({ tradeMode: "REAL", server: "Deriv-Server" }),
      expectedEnvironment: "demo",
      expectedBroker: "Deriv"
    });
    expect(result.ok).toBe(false);
    expect(result.isReal).toBe(true);
  });

  it("live mode accepts valid real account", () => {
    const result = validateMt5ExecutionEnvironment({
      account: account({
        tradeMode: "REAL",
        company: "Deriv Limited",
        server: "Deriv-Server",
        login: "999888"
      }),
      expectedEnvironment: "live",
      expectedBroker: "Deriv",
      expectedServer: "Deriv-Server",
      expectedLogin: "999888"
    });
    expect(result.ok).toBe(true);
    expect(result.isReal).toBe(true);
  });

  it("live mode rejects demo account", () => {
    const result = validateMt5ExecutionEnvironment({
      account: account({ tradeMode: "DEMO" }),
      expectedEnvironment: "live",
      expectedBroker: "Deriv"
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("MT5_ACCOUNT_IS_DEMO"))).toBe(true);
  });

  it("wrong server/login/broker rejected for live", () => {
    const base = account({
      tradeMode: "REAL",
      company: "Deriv Limited",
      server: "Deriv-Server",
      login: "111"
    });
    expect(
      assertMt5LiveAccount({
        account: base,
        expectedBroker: "OtherBroker",
        expectedEnvironment: "live"
      }).ok
    ).toBe(false);
    expect(
      assertMt5LiveAccount({
        account: base,
        expectedBroker: "Deriv",
        expectedServer: "Wrong",
        expectedEnvironment: "live"
      }).ok
    ).toBe(false);
    expect(
      assertMt5LiveAccount({
        account: base,
        expectedBroker: "Deriv",
        expectedServer: "Deriv-Server",
        expectedLogin: "222",
        expectedEnvironment: "live"
      }).ok
    ).toBe(false);
  });
});
