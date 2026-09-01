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
