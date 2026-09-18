import { describe, expect, it } from "vitest";
import {
  LIVE_POLICY_REJECTED,
  LIVE_TRADING_ARM_FAILED,
  LIVE_TRADING_DISABLED,
  LIVE_TRADING_DISARMED,
  assertLiveMt5Capable,
  evaluateLiveArmPreflight,
  evaluateLiveOrderPolicy,
  publicLiveCapabilitySnapshot,
  resolveLiveExecutionPolicy,
  resolveLiveTradingArmState,
  resolveLiveTradingCapability
} from "./liveMt5Policy.js";

const gatedOff = {
  REAL_MONEY_ENABLED: false,
  LIVE_MT5_ENABLED: false,
  MT5_BRIDGE_SECRET: "secret",
  MT5_BRIDGE_URL: "http://mt5-bridge:8765",
  LIVE_ALLOWED_SYMBOLS: "R_10"
};

const gatedOn = {
  REAL_MONEY_ENABLED: true,
  LIVE_MT5_ENABLED: true,
  MT5_BRIDGE_SECRET: "secret",
  MT5_BRIDGE_URL: "http://mt5-bridge:8765",
  MT5_EXPECTED_ENVIRONMENT: "live" as const,
  LIVE_ALLOWED_SYMBOLS: "R_10",
  LIVE_MAX_CONCURRENT_POSITIONS: 1,
  LIVE_MAX_RISK_PER_TRADE_PERCENT: 0.25,
  LIVE_MAX_DAILY_LOSS: 25,
  LIVE_MAX_LOT_SIZE: 0.01
};

describe("liveMt5Policy capability vs arm", () => {
  it("live disabled by default", () => {
    const cap = resolveLiveTradingCapability(gatedOff);
    expect(cap.liveTradingSupported).toBe(false);
    expect(resolveLiveTradingArmState(gatedOff, true).liveTradingArmed).toBe(false);
  });

  it("REAL_MONEY_ENABLED=false blocks support even if LIVE_MT5_ENABLED", () => {
    const cap = resolveLiveTradingCapability({
      ...gatedOn,
      REAL_MONEY_ENABLED: false
    });
    expect(cap.liveTradingSupported).toBe(false);
  });

  it("LIVE_MT5_ENABLED=false blocks support", () => {
    const cap = resolveLiveTradingCapability({
      ...gatedOn,
      LIVE_MT5_ENABLED: false
    });
    expect(cap.liveTradingSupported).toBe(false);
  });

  it("empty allowlist blocks support (valid live configuration)", () => {
    const cap = resolveLiveTradingCapability({
      ...gatedOn,
      LIVE_ALLOWED_SYMBOLS: ""
    });
    expect(cap.liveTradingSupported).toBe(false);
    expect(cap.configValid).toBe(false);
  });

  it("supported when gates+config pass; armed only when DB flag true", () => {
    const cap = resolveLiveTradingCapability(gatedOn);
    expect(cap.liveTradingSupported).toBe(true);
    expect(resolveLiveTradingArmState(gatedOn, false).liveTradingArmed).toBe(false);
    expect(resolveLiveTradingArmState(gatedOn, true).liveTradingArmed).toBe(true);
  });

  it("client cannot spoof supported — public snapshot ignores client claims", () => {
    const snap = publicLiveCapabilitySnapshot(gatedOff, true);
    expect(snap.liveTradingSupported).toBe(false);
    expect(snap.liveTradingArmed).toBe(false);
  });

  it("assertLiveMt5Capable throws when gated off", () => {
    expect(() => assertLiveMt5Capable(gatedOff)).toThrow(LIVE_TRADING_DISABLED);
  });
});

describe("live arm preflight", () => {
  it("cannot arm when REAL_MONEY_ENABLED=false", () => {
    const r = evaluateLiveArmPreflight({
      config: { ...gatedOn, REAL_MONEY_ENABLED: false },
      emergencyStop: false,
      accountValid: true
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(LIVE_TRADING_ARM_FAILED);
  });

  it("cannot arm when LIVE_MT5_ENABLED=false", () => {
    expect(
      evaluateLiveArmPreflight({
        config: { ...gatedOn, LIVE_MT5_ENABLED: false },
        emergencyStop: false,
        accountValid: true
      }).ok
    ).toBe(false);
  });

  it("cannot arm with demo account validation failure", () => {
    const r = evaluateLiveArmPreflight({
      config: gatedOn,
      emergencyStop: false,
      accountValid: false,
      accountReasons: ["MT5_ACCOUNT_IS_DEMO"]
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes("DEMO"))).toBe(true);
  });

  it("cannot arm with empty symbol allowlist", () => {
    expect(
      evaluateLiveArmPreflight({
        config: { ...gatedOn, LIVE_ALLOWED_SYMBOLS: "" },
        emergencyStop: false,
        accountValid: true
      }).ok
    ).toBe(false);
  });

  it("cannot arm when emergency stop active", () => {
    expect(
      evaluateLiveArmPreflight({
        config: gatedOn,
        emergencyStop: true,
        accountValid: true
      }).ok
    ).toBe(false);
  });

  it("can arm when all server gates pass", () => {
    expect(
      evaluateLiveArmPreflight({
        config: gatedOn,
        emergencyStop: false,
        accountValid: true
      }).ok
    ).toBe(true);
  });
});

describe("live order policy armed check", () => {
  it("disarm blocks new live entries with LIVE_TRADING_DISARMED", () => {
    const policy = resolveLiveExecutionPolicy(gatedOn);
    const r = evaluateLiveOrderPolicy(policy, {
      symbol: "R_10",
      volume: 0.01,
      openLivePositions: 0,
      equity: 1000,
      balance: 1000,
      liveTradingSupported: true,
      liveTradingArmed: false
    });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(LIVE_TRADING_DISARMED);
  });

  it("armed path still enforces risk / allowlist", () => {
    const policy = resolveLiveExecutionPolicy(gatedOn);
    expect(
      evaluateLiveOrderPolicy(policy, {
        symbol: "XAUUSD",
        volume: 0.01,
        openLivePositions: 0,
        equity: 1000,
        balance: 1000,
        liveTradingSupported: true,
        liveTradingArmed: true
      }).code
    ).toBe(LIVE_POLICY_REJECTED);

    expect(
      evaluateLiveOrderPolicy(policy, {
        symbol: "R_10",
        volume: 0.01,
        riskPercent: 0.2,
        openLivePositions: 0,
        equity: 1000,
        balance: 1000,
        liveTradingSupported: true,
        liveTradingArmed: true
      }).allowed
    ).toBe(true);
  });
});
