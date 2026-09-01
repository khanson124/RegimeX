import { describe, expect, it } from "vitest";
import { DEFAULT_CFD_RISK_LIMITS } from "@regimex/shared";
import {
  computeConsecutiveLossStreak,
  consecutiveLossCooldownMsFromMinutes,
  evaluateConsecutiveLossCooldown
} from "./consecutiveLossStreak.js";

describe("computeConsecutiveLossStreak", () => {
  it("counts trailing losses and captures the newest loss timestamp", () => {
    const streak = computeConsecutiveLossStreak([
      { realizedPnl: -1, closedAt: new Date("2026-01-02T12:00:00Z") },
      { realizedPnl: -2, closedAt: new Date("2026-01-02T11:00:00Z") },
      { realizedPnl: 3, closedAt: new Date("2026-01-02T10:00:00Z") }
    ]);
    expect(streak.consecutiveLosses).toBe(2);
    expect(streak.lastLossClosedAt).toBe(Date.parse("2026-01-02T12:00:00Z"));
  });

  it("stops counting at the first non-loss", () => {
    const streak = computeConsecutiveLossStreak([
      { realizedPnl: -1, closedAt: new Date("2026-01-02T12:00:00Z") },
      { realizedPnl: 1, closedAt: new Date("2026-01-02T11:00:00Z") },
      { realizedPnl: -5, closedAt: new Date("2026-01-02T10:00:00Z") }
    ]);
    expect(streak.consecutiveLosses).toBe(1);
  });
});

describe("evaluateConsecutiveLossCooldown", () => {
  const cooldownMs = consecutiveLossCooldownMsFromMinutes(60);
  const lastLossClosedAt = Date.parse("2026-01-02T12:00:00Z");

  it("allows trading below the streak threshold", () => {
    expect(
      evaluateConsecutiveLossCooldown({
        consecutiveLosses: 2,
        maxConsecutiveLosses: 3,
        lastLossClosedAt,
        consecutiveLossCooldownMs: cooldownMs,
        now: lastLossClosedAt + 5 * 60_000
      }).blocked
    ).toBe(false);
  });

  it("blocks during the cooldown window", () => {
    const gate = evaluateConsecutiveLossCooldown({
      consecutiveLosses: 3,
      maxConsecutiveLosses: 3,
      lastLossClosedAt,
      consecutiveLossCooldownMs: cooldownMs,
      now: lastLossClosedAt + 59 * 60_000
    });
    expect(gate.blocked).toBe(true);
    expect(gate.decisionCode).toBe("CONSECUTIVE_LOSS_COOLDOWN");
    expect(gate.cooldownRemainingMs).toBe(60_000);
  });

  it("allows trading after the cooldown expires without resetting the streak count", () => {
    const gate = evaluateConsecutiveLossCooldown({
      consecutiveLosses: 5,
      maxConsecutiveLosses: 3,
      lastLossClosedAt,
      consecutiveLossCooldownMs: cooldownMs,
      now: lastLossClosedAt + 61 * 60_000
    });
    expect(gate.blocked).toBe(false);
    expect(gate.cooldownRemainingMs).toBe(0);
  });
});
