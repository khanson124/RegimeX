import { describe, expect, it } from "vitest";
import {
  evaluateLiveArmPreflight,
  evaluateLiveOrderPolicy,
  LIVE_TRADING_DISARMED,
  resolveLiveExecutionPolicy
} from "./liveMt5Policy.js";

/**
 * Arm/disarm semantics for order path:
 * - disarm rejects NEW opens
 * - modify/close are not gated by evaluateLiveOrderPolicy (adapter path separate)
 */
describe("disarm vs modify/close semantics", () => {
  const gatedOn = {
    REAL_MONEY_ENABLED: true,
    LIVE_MT5_ENABLED: true,
    MT5_BRIDGE_SECRET: "secret",
    MT5_BRIDGE_URL: "http://mt5-bridge:8765",
    MT5_EXPECTED_ENVIRONMENT: "live" as const,
    LIVE_ALLOWED_SYMBOLS: "R_10",
    LIVE_MAX_LOT_SIZE: 0.01,
    LIVE_MAX_RISK_PER_TRADE_PERCENT: 0.25,
    LIVE_MAX_DAILY_LOSS: 25
  };

  it("disarmed order policy rejects opens", () => {
    const policy = resolveLiveExecutionPolicy(gatedOn);
    const open = evaluateLiveOrderPolicy(policy, {
      symbol: "R_10",
      volume: 0.01,
      openLivePositions: 0,
      equity: 1_000,
      balance: 1_000,
      liveTradingSupported: true,
      liveTradingArmed: false
    });
    expect(open.allowed).toBe(false);
    expect(open.code).toBe(LIVE_TRADING_DISARMED);
  });

  it("arm preflight does not require LIVE_TRADING_ENABLED env", () => {
    expect(
      evaluateLiveArmPreflight({
        config: { ...gatedOn, LIVE_TRADING_ENABLED: false },
        emergencyStop: false,
        accountValid: true
      }).ok
    ).toBe(true);
  });
});
