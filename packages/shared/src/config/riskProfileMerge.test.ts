import { describe, expect, it } from "vitest";
import { riskProfileUpdateSchema } from "../schemas/engine.js";
import {
  assertMergedRiskProfile,
  mergeRiskProfileUpdate,
  RiskProfileMergeError,
  snapshotRiskProfile,
  type RiskProfileSnapshot
} from "./riskProfileMerge.js";

const BASE: RiskProfileSnapshot = {
  fixedStake: 0.5,
  maxStakePerTrade: 1,
  maxDailyLoss: 5,
  maxDailyTrades: 10,
  maxConsecutiveLosses: 3,
  maxSimultaneousContracts: 1,
  minCooldownSeconds: 120,
  maxDrawdownPercent: 10,
  minBalance: 100,
  riskPerTradePercent: 0.5,
  sessionStartHourUtc: 8,
  sessionEndHourUtc: 20,
  volumeOverrideLots: 0.2,
  stopLossDistanceOverride: 1.5,
  maxTotalOpenRiskPercent: 2,
  maxConcurrentPositions: 3,
  minRiskRewardRatio: 1.5
};

describe("mergeRiskProfileUpdate", () => {
  it("changing only riskPerTradePercent preserves all other fields", () => {
    const merged = mergeRiskProfileUpdate(BASE, { riskPerTradePercent: 0.75 });
    expect(merged.riskPerTradePercent).toBe(0.75);
    expect(merged.fixedStake).toBe(BASE.fixedStake);
    expect(merged.maxDailyLoss).toBe(BASE.maxDailyLoss);
    expect(merged.maxConcurrentPositions).toBe(BASE.maxConcurrentPositions);
    expect(merged.sessionStartHourUtc).toBe(8);
    expect(merged.volumeOverrideLots).toBe(0.2);
  });

  it("changing only maxConcurrentPositions preserves core stake/limit fields", () => {
    const merged = mergeRiskProfileUpdate(BASE, { maxConcurrentPositions: 5 });
    expect(merged.maxConcurrentPositions).toBe(5);
    expect(merged.fixedStake).toBe(0.5);
    expect(merged.maxStakePerTrade).toBe(1);
    expect(merged.maxDailyTrades).toBe(10);
    expect(merged.minCooldownSeconds).toBe(120);
    expect(merged.riskPerTradePercent).toBe(0.5);
  });

  it("changing only session hours preserves CFD caps", () => {
    const merged = mergeRiskProfileUpdate(BASE, {
      sessionStartHourUtc: 10,
      sessionEndHourUtc: 18
    });
    expect(merged.sessionStartHourUtc).toBe(10);
    expect(merged.sessionEndHourUtc).toBe(18);
    expect(merged.maxTotalOpenRiskPercent).toBe(2);
    expect(merged.maxConcurrentPositions).toBe(3);
    expect(merged.minRiskRewardRatio).toBe(1.5);
    expect(merged.volumeOverrideLots).toBe(0.2);
  });

  it("omitted fields are unchanged", () => {
    const merged = mergeRiskProfileUpdate(BASE, { maxDailyLoss: 7 });
    for (const key of Object.keys(BASE) as Array<keyof RiskProfileSnapshot>) {
      if (key === "maxDailyLoss") continue;
      expect(merged[key]).toEqual(BASE[key]);
    }
  });

  it("explicit null only clears nullable fields", () => {
    const merged = mergeRiskProfileUpdate(BASE, {
      sessionStartHourUtc: null,
      sessionEndHourUtc: null,
      volumeOverrideLots: null,
      maxConcurrentPositions: null
    });
    expect(merged.sessionStartHourUtc).toBeNull();
    expect(merged.sessionEndHourUtc).toBeNull();
    expect(merged.volumeOverrideLots).toBeNull();
    expect(merged.maxConcurrentPositions).toBeNull();
    expect(merged.fixedStake).toBe(0.5);
    expect(merged.riskPerTradePercent).toBe(0.5);
  });

  it("stale/incomplete payloads cannot wipe unrelated settings", () => {
    // Old client style that only knew about stake fields would previously overwrite
    // session/CFD caps if it sent nulls. With merge + omit, only sent keys change.
    const patch = riskProfileUpdateSchema.parse({
      fixedStake: 0.6,
      maxStakePerTrade: 1.2
    });
    const merged = mergeRiskProfileUpdate(BASE, patch);
    expect(merged.fixedStake).toBe(0.6);
    expect(merged.maxStakePerTrade).toBe(1.2);
    expect(merged.sessionStartHourUtc).toBe(8);
    expect(merged.maxConcurrentPositions).toBe(3);
    expect(merged.minRiskRewardRatio).toBe(1.5);
    expect(merged.stopLossDistanceOverride).toBe(1.5);
  });

  it("empty body is rejected by schema", () => {
    expect(() => riskProfileUpdateSchema.parse({})).toThrow();
  });

  it("assertMergedRiskProfile rejects maxStake below fixedStake", () => {
    expect(() =>
      assertMergedRiskProfile(
        mergeRiskProfileUpdate(BASE, { fixedStake: 2, maxStakePerTrade: 1 })
      )
    ).toThrow(RiskProfileMergeError);
  });

  it("snapshotRiskProfile coerces Decimal-like values", () => {
    const snap = snapshotRiskProfile({
      fixedStake: "0.5",
      maxStakePerTrade: "1",
      maxDailyLoss: "5",
      maxDailyTrades: 10,
      maxConsecutiveLosses: 3,
      maxSimultaneousContracts: 1,
      minCooldownSeconds: 120,
      maxDrawdownPercent: "10",
      minBalance: "100",
      riskPerTradePercent: "0.5",
      sessionStartHourUtc: 8,
      sessionEndHourUtc: null,
      volumeOverrideLots: null,
      stopLossDistanceOverride: null,
      maxTotalOpenRiskPercent: "2",
      maxConcurrentPositions: 3,
      minRiskRewardRatio: "1.5"
    });
    expect(snap.riskPerTradePercent).toBe(0.5);
    expect(snap.maxTotalOpenRiskPercent).toBe(2);
    expect(snap.sessionEndHourUtc).toBeNull();
  });
});
