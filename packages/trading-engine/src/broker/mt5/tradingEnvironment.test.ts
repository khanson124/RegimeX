import { describe, expect, it } from "vitest";
import {
  accountKindFromBrokerStatus,
  assertAccountMatchesEnvironment,
  assertMt5ModeBackendConsistency,
  evaluateTradingEnvironmentSwitchGate,
  isUsableMt5QuotePrice,
  planTradingEnvironmentSwitch,
  resolveMt5BridgeUrlForEnvironment,
  TRADING_ENV_ACCOUNT_MISMATCH,
  TRADING_ENV_AMBIGUOUS_INTENTS,
  TRADING_ENV_BACKEND_MISMATCH,
  tradingEnvironmentToBackend
} from "./tradingEnvironment.js";

describe("tradingEnvironment", () => {
  it("maps DEMO/LIVE to MT5 backends", () => {
    expect(tradingEnvironmentToBackend("DEMO")).toBe("broker_demo_mt5");
    expect(tradingEnvironmentToBackend("LIVE")).toBe("broker_real_mt5");
  });

  it("rejects DEMO_TRADING on broker_real_mt5 (legacy fallthrough class)", () => {
    const r = assertMt5ModeBackendConsistency({
      sessionMode: "DEMO_TRADING",
      executionBackend: "broker_real_mt5"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(TRADING_ENV_BACKEND_MISMATCH);
  });

  it("allows DEMO_TRADING on broker_demo_mt5 and LIVE_TRADING on broker_real_mt5", () => {
    expect(
      assertMt5ModeBackendConsistency({
        sessionMode: "DEMO_TRADING",
        executionBackend: "broker_demo_mt5"
      }).ok
    ).toBe(true);
    expect(
      assertMt5ModeBackendConsistency({
        sessionMode: "LIVE_TRADING",
        executionBackend: "broker_real_mt5"
      }).ok
    ).toBe(true);
  });

  it("classifies account kind from broker status (not engine labels)", () => {
    expect(accountKindFromBrokerStatus({ isDemo: true, tradeMode: "DEMO" })).toBe("demo");
    expect(accountKindFromBrokerStatus({ isDemo: false, tradeMode: "REAL" })).toBe("live");
    expect(accountKindFromBrokerStatus({ isDemo: true, tradeMode: "REAL" })).toBe("unknown");
  });

  it("DEMO↔LIVE switch always disarms and requires target account kind", () => {
    const plan = planTradingEnvironmentSwitch({ from: "DEMO", to: "LIVE" });
    expect(plan.mustDisarmLive).toBe(true);
    expect(plan.requireTargetAccountKind).toBe("live");
    expect(plan.targetBackend).toBe("broker_real_mt5");
  });

  it("blocks switch on account mismatch, ambiguous intents, unavailable target", () => {
    const blocked = evaluateTradingEnvironmentSwitchGate({
      submissionsBlocked: false,
      switchInProgress: false,
      ambiguousOpenIntents: true,
      targetAvailable: false,
      targetAccountKind: "demo",
      to: "LIVE"
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain(TRADING_ENV_AMBIGUOUS_INTENTS);
    expect(blocked.reasons.some((r) => r.includes(TRADING_ENV_ACCOUNT_MISMATCH))).toBe(true);

    const ok = evaluateTradingEnvironmentSwitchGate({
      submissionsBlocked: false,
      switchInProgress: false,
      ambiguousOpenIntents: false,
      targetAvailable: true,
      targetAccountKind: "live",
      to: "LIVE"
    });
    expect(ok.allowed).toBe(true);
  });

  it("rejects LIVE environment when connected account is DEMO", () => {
    const r = assertAccountMatchesEnvironment({ environment: "LIVE", accountKind: "demo" });
    expect(r.ok).toBe(false);
  });

  it("resolves isolated DEMO/LIVE bridge URLs with legacy fallback", () => {
    expect(
      resolveMt5BridgeUrlForEnvironment(
        {
          MT5_DEMO_BRIDGE_URL: "http://mt5-bridge:8765",
          MT5_LIVE_BRIDGE_URL: "http://mt5-bridge-live:8765"
        },
        "LIVE"
      )
    ).toBe("http://mt5-bridge-live:8765");
    expect(
      resolveMt5BridgeUrlForEnvironment({ MT5_BRIDGE_URL: "http://mt5-bridge:8765" }, "DEMO")
    ).toBe("http://mt5-bridge:8765");
  });
});
