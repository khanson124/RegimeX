import { describe, expect, it } from "vitest";
import {
  canClosePositionStatus,
  canOpenPositionStatus,
  canRejectPendingPositionStatus,
  canTransitionExecutionIntentState,
  countCapacityFromStatuses,
  decideCapacityReservation,
  mt5CapacityAdvisoryLockKey,
  MT5_CAPACITY_BLOCKED,
  positionStatusConsumesCapacity,
  resolveMt5EffectiveMaxConcurrentPositions
} from "./mt5Capacity.js";

describe("mt5Capacity", () => {
  it("N. REJECTED/CLOSED do not consume capacity; PENDING/OPEN do", () => {
    expect(positionStatusConsumesCapacity("PENDING")).toBe(true);
    expect(positionStatusConsumesCapacity("OPEN")).toBe(true);
    expect(positionStatusConsumesCapacity("REJECTED")).toBe(false);
    expect(positionStatusConsumesCapacity("CLOSED")).toBe(false);
    expect(countCapacityFromStatuses(["OPEN", "OPEN", "PENDING", "REJECTED", "CLOSED"])).toBe(3);
  });

  it("A/B. capacity reservation at 4/5 and 5/5", () => {
    expect(decideCapacityReservation({ consumedBefore: 4, maxConcurrent: 5 }).allowed).toBe(true);
    expect(decideCapacityReservation({ consumedBefore: 5, maxConcurrent: 5 }).allowed).toBe(false);
    expect(decideCapacityReservation({ consumedBefore: 5, maxConcurrent: 5 }).reason).toBe(MT5_CAPACITY_BLOCKED);
  });

  it("C. sixth of five blocked", () => {
    const decisions = Array.from({ length: 6 }, (_, i) =>
      decideCapacityReservation({ consumedBefore: i, maxConcurrent: 5 })
    );
    expect(decisions.filter((d) => d.allowed).length).toBe(5);
    expect(decisions[5]?.allowed).toBe(false);
  });

  it("intent transitions are monotonic", () => {
    expect(canTransitionExecutionIntentState("CREATED", "SUBMITTED")).toBe(true);
    expect(canTransitionExecutionIntentState("SUBMITTED", "AMBIGUOUS")).toBe(true);
    expect(canTransitionExecutionIntentState("AMBIGUOUS", "REJECTED")).toBe(true);
    expect(canTransitionExecutionIntentState("PERSISTED", "SUBMITTED")).toBe(false);
    expect(canTransitionExecutionIntentState("REJECTED", "SUBMITTED")).toBe(false);
    expect(canTransitionExecutionIntentState("CLOSED" as string, "OPEN")).toBe(false);
  });

  it("position close/open guards", () => {
    expect(canClosePositionStatus("OPEN")).toBe(true);
    expect(canClosePositionStatus("CLOSED")).toBe(false);
    expect(canOpenPositionStatus("PENDING")).toBe(true);
    expect(canOpenPositionStatus("CLOSED")).toBe(false);
    expect(canRejectPendingPositionStatus("PENDING")).toBe(true);
    expect(canRejectPendingPositionStatus("OPEN")).toBe(false);
  });

  it("advisory lock key is stable per user", () => {
    expect(mt5CapacityAdvisoryLockKey("u1")).toBe(mt5CapacityAdvisoryLockKey("u1"));
    expect(mt5CapacityAdvisoryLockKey("u1")).not.toBe(mt5CapacityAdvisoryLockKey("u2"));
  });

  describe("resolveMt5EffectiveMaxConcurrentPositions", () => {
    it("A. null profile + env 5 => effective 5", () => {
      expect(resolveMt5EffectiveMaxConcurrentPositions(null, 5)).toBe(5);
      expect(resolveMt5EffectiveMaxConcurrentPositions(undefined, 5)).toBe(5);
    });

    it("B. profile 3 + env 5 => effective 3", () => {
      expect(resolveMt5EffectiveMaxConcurrentPositions(3, 5)).toBe(3);
    });

    it("C. profile 5 + env 5 => effective 5", () => {
      expect(resolveMt5EffectiveMaxConcurrentPositions(5, 5)).toBe(5);
    });

    it("D. profile above env is capped at env", () => {
      expect(resolveMt5EffectiveMaxConcurrentPositions(10, 5)).toBe(5);
    });
  });
});
