import { describe, expect, it } from "vitest";
import { DEFAULT_CFD_RISK_LIMITS } from "@regimex/shared";
import { CfdRiskManager, type CfdRiskEvaluationInput } from "./cfdRiskManager.js";
import { consecutiveLossCooldownMsFromMinutes } from "./consecutiveLossStreak.js";

const COOLDOWN_MS = consecutiveLossCooldownMsFromMinutes(60);
const MAX_CONSECUTIVE = 3;
const BASE_NOW = Date.parse("2026-01-02T13:00:00Z");

function baseInput(
  overrides: Partial<CfdRiskEvaluationInput> = {}
): CfdRiskEvaluationInput {
  return {
    limits: DEFAULT_CFD_RISK_LIMITS,
    emergencyStop: false,
    tradingEnabled: true,
    marketDataFresh: true,
    instrument: {
      symbol: "R_10",
      enabled: true,
      verified: true,
      contractSize: 1,
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: 10,
      tickSize: 0.01,
      tickValue: 1,
      marginRate: 0.01,
      spreadBps: 10,
      slippageBps: 5,
      pricePrecision: 2,
      currency: "USD"
    },
    equity: 10_000,
    openPositionCount: 0,
    totalOpenRiskAmount: 0,
    dailyRealizedLoss: 0,
    consecutiveLosses: 0,
    lastLossClosedAt: null,
    lastTradeAt: null,
    minCooldownSeconds: 0,
    maxDailyLoss: 100,
    maxDailyTrades: 10,
    dailyTradeCount: 0,
    maxConsecutiveLosses: MAX_CONSECUTIVE,
    consecutiveLossCooldownMs: COOLDOWN_MS,
    idempotencyKeyExists: false,
    stopLossPresent: true,
    riskRewardRatio: 2,
    volume: 0.01,
    now: BASE_NOW,
    ...overrides
  };
}

const rm = new CfdRiskManager();

describe("CfdRiskManager consecutive-loss cooldown", () => {
  it("A: blocks when 3 consecutive losses and last loss was 5 minutes ago", () => {
    const lastLossClosedAt = BASE_NOW - 5 * 60_000;
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.rejectionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
    expect(decision.consecutiveLossDetail?.cooldownRemainingMs).toBe(55 * 60_000);
    expect(decision.consecutiveLossDetail?.decisionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
  });

  it("B: blocks when 3 consecutive losses and last loss was 59 minutes ago", () => {
    const lastLossClosedAt = BASE_NOW - 59 * 60_000;
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.rejectionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
    expect(decision.consecutiveLossDetail?.cooldownRemainingMs).toBe(60_000);
  });

  it("C: allows trading when 3 consecutive losses and last loss was more than 60 minutes ago", () => {
    const lastLossClosedAt = BASE_NOW - 61 * 60_000;
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(true);
    expect(decision.rejectionCode).toBeNull();
    expect(decision.consecutiveLossDetail?.cooldownRemainingMs).toBe(0);
  });

  it("D: does not permanently block a 5-loss streak from several hours ago", () => {
    const lastLossClosedAt = BASE_NOW - 5 * 60 * 60_000;
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 5,
        lastLossClosedAt,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(true);
    expect(decision.consecutiveLossDetail?.consecutiveLosses).toBe(5);
  });

  it("E: remains blocked after a simulated worker restart during cooldown", () => {
    const lastLossClosedAt = BASE_NOW - 20 * 60_000;
    const first = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        now: BASE_NOW - 10 * 60_000
      })
    );
    const second = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        now: BASE_NOW
      })
    );
    expect(first.approved).toBe(false);
    expect(second.approved).toBe(false);
    expect(second.rejectionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
  });

  it("F: resets normally when a winning trade breaks the streak before the threshold", () => {
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 2,
        lastLossClosedAt: BASE_NOW - 5 * 60_000,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(true);
    expect(decision.consecutiveLossDetail).toBeNull();
  });

  it("G: daily loss limit still blocks after consecutive-loss cooldown expires", () => {
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt: BASE_NOW - 2 * 60 * 60_000,
        dailyRealizedLoss: -100,
        maxDailyLoss: 100,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.rejectionCode).toBe("DAILY_LOSS_LIMIT");
  });

  it("H: max daily trades still blocks regardless of consecutive-loss cooldown", () => {
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt: BASE_NOW - 2 * 60 * 60_000,
        dailyTradeCount: 10,
        maxDailyTrades: 10,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.rejectionCode).toBe("DAILY_TRADE_LIMIT");
  });

  it("defaults to a 60-minute cooldown when config is omitted", () => {
    const lastLossClosedAt = BASE_NOW - 30 * 60_000;
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        consecutiveLossCooldownMs: undefined,
        now: BASE_NOW
      })
    );
    expect(decision.approved).toBe(false);
    expect(decision.consecutiveLossDetail?.cooldownMinutes).toBe(60);
  });

  it("logs observability fields on cooldown rejection", () => {
    const lastLossClosedAt = BASE_NOW - 10 * 60_000;
    const decision = rm.evaluate(
      baseInput({
        consecutiveLosses: 3,
        lastLossClosedAt,
        now: BASE_NOW
      })
    );
    expect(decision.consecutiveLossDetail).toEqual({
      consecutiveLosses: 3,
      maxConsecutiveLosses: MAX_CONSECUTIVE,
      lastLossClosedAt,
      cooldownMinutes: 60,
      cooldownRemainingMs: 50 * 60_000,
      decisionCode: "CONSECUTIVE_LOSS_COOLDOWN"
    });
  });
});

describe("temporary DEMO loss bypass risk isolation", () => {
  const demoLossBypass = { executionMode: "broker_demo_mt5", sessionMode: "DEMO_TRADING",
    symbol: "R_10", strategyId: "ema-pullback-v1", expiresAtMs: BASE_NOW + 1000 };
  const withLosses = (override: Partial<CfdRiskEvaluationInput> = {}) => baseInput({
    consecutiveLosses: 9, lastLossClosedAt: BASE_NOW - 60_000, demoLossBypass, ...override
  });
  it("bypasses only the loss streak while retaining observed losses and thresholds", () => {
    const input = withLosses();
    expect(rm.evaluate(input).approved).toBe(true);
    expect(input.consecutiveLosses).toBe(9);
    expect(input.maxConsecutiveLosses).toBe(3);
  });
  it.each([
    { executionMode: "broker_real_mt5" }, { sessionMode: "LIVE_TRADING" },
    { symbol: "XAUUSD" }, { expiresAtMs: BASE_NOW }, { expiresAtMs: null }
  ])("does not bypass outside DEMO R_10 or after expiry: %s", (override) => {
    expect(rm.evaluate(withLosses({ demoLossBypass: { ...demoLossBypass, ...override } }))
      .rejectionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
  });
  it("missing switch retains the existing block", () => {
    expect(rm.evaluate(withLosses({ demoLossBypass: undefined })).rejectionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
  });
  it.each([
    [{ emergencyStop: true }, "EMERGENCY_STOP"],
    [{ dailyRealizedLoss: -100 }, "DAILY_LOSS_LIMIT"],
    [{ dailyTradeCount: 10 }, "DAILY_TRADE_LIMIT"],
    [{ marketDataFresh: false }, "MARKET_DATA_STALE"],
    [{ stopLossPresent: false }, "STOP_LOSS_REQUIRED"],
    [{ minCooldownSeconds: 120, lastTradeAt: BASE_NOW - 1000 }, "COOLDOWN_ACTIVE"]
  ] as const)("preserves other risk rejection %s", (override, code) => {
    expect(rm.evaluate(withLosses(override)).rejectionCode).toBe(code);
  });
});

describe("temporary DEMO daily cap preserves the remaining risk checks", () => {
  it("allows the 30th qualifying trade and blocks the 31st", () => {
    expect(rm.evaluate(baseInput({ maxDailyTrades: 30, dailyTradeCount: 29 })).approved).toBe(true);
    expect(rm.evaluate(baseInput({ maxDailyTrades: 30, dailyTradeCount: 30 })).rejectionCode).toBe("DAILY_TRADE_LIMIT");
    expect(rm.evaluate(baseInput({ maxDailyTrades: 10, dailyTradeCount: 10 })).rejectionCode).toBe("DAILY_TRADE_LIMIT");
  });
  it("still blocks daily loss, loss streaks, ordinary cooldown and emergency stop", () => {
    for (const overrides of [
      { dailyRealizedLoss: -101 },
      { consecutiveLosses: 3, lastLossClosedAt: BASE_NOW - 1000 },
      { lastTradeAt: BASE_NOW - 1000, minCooldownSeconds: 120 },
      { emergencyStop: true }
    ]) {
      expect(rm.evaluate(baseInput({ maxDailyTrades: 30, dailyTradeCount: 10, ...overrides })).approved).toBe(false);
    }
  });
});

const goldScope = { executionMode: "broker_demo_mt5", sessionMode: "DEMO_TRADING", symbol: "XAUUSD",
 interval: "15m", strategyId: "xau-trend-pullback-v1", verifiedDemoAccount: true, expiresAt: "2026-01-03T13:00:00Z" };
describe("Gold DEMO risk test", () => {
 const blocked = { totalOpenRiskAmount: 10000, dailyRealizedLoss: -200, dailyTradeCount: 20,
  consecutiveLosses: 10, lastLossClosedAt: BASE_NOW - 1000 };
 it("allows exact DEMO Gold despite shared monetary/loss counters without rewriting them", () => {
  const input = baseInput({ ...blocked, demoGoldRiskTest: goldScope });
  expect(rm.evaluate(input).approved).toBe(true); expect(input.dailyRealizedLoss).toBe(-200);
 });
 it.each([{ executionMode: "broker_real_mt5" }, { sessionMode: "REAL_TRADING" }, { symbol: "R_10" },
  { interval: "1m" }, { strategyId: "xau-trend-breakout-v2" }, { verifiedDemoAccount: false },
  { expiresAt: undefined }, { expiresAt: "invalid" }, { expiresAt: "2026-01-02T13:00:00Z" }])("fails closed outside scope: %j", other => {
  expect(rm.evaluate(baseInput({ ...blocked, demoGoldRiskTest: { ...goldScope, ...other } })).approved).toBe(false);
 });
 it.each([
  [{ emergencyStop: true }, "EMERGENCY_STOP"], [{ tradingEnabled: false }, "TRADING_DISABLED"],
  [{ marketDataFresh: false }, "MARKET_DATA_STALE"], [{ stopLossPresent: false }, "STOP_LOSS_REQUIRED"],
  [{ idempotencyKeyExists: true }, "DUPLICATE_TRADE"], [{ equity: 0 }, "ACCOUNT_INVALID"],
  [{ openPositionCount: 100 }, "MAX_OPEN_POSITIONS"], [{ riskRewardRatio: .1 }, "MIN_RISK_REWARD"],
  [{ lastTradeAt: BASE_NOW - 1000, minCooldownSeconds: 120 }, "COOLDOWN_ACTIVE"]
 ] as [Partial<CfdRiskEvaluationInput>, string][])("keeps operational controls: %j", (other, code) => {
  expect(rm.evaluate(baseInput({ ...blocked, demoGoldRiskTest: goldScope, ...other })).rejectionCode).toBe(code);
 });
});
