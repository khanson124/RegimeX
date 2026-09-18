import { type RiskProfileUpdateInput } from "../schemas/engine.js";

/** Normalized risk profile fields used for merge + validation. */
export interface RiskProfileSnapshot {
  fixedStake: number;
  maxStakePerTrade: number;
  maxDailyLoss: number;
  maxDailyTrades: number;
  maxConsecutiveLosses: number;
  maxSimultaneousContracts: number;
  minCooldownSeconds: number;
  maxDrawdownPercent: number;
  minBalance: number;
  riskPerTradePercent: number | null;
  sessionStartHourUtc: number | null;
  sessionEndHourUtc: number | null;
  volumeOverrideLots: number | null;
  stopLossDistanceOverride: number | null;
  maxTotalOpenRiskPercent: number | null;
  maxConcurrentPositions: number | null;
  minRiskRewardRatio: number | null;
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a Prisma/Decimal risk profile row into a plain snapshot. */
export function snapshotRiskProfile(row: Record<string, unknown>): RiskProfileSnapshot {
  return {
    fixedStake: asNumber(row.fixedStake, 0.5),
    maxStakePerTrade: asNumber(row.maxStakePerTrade, 1),
    maxDailyLoss: asNumber(row.maxDailyLoss, 5),
    maxDailyTrades: asNumber(row.maxDailyTrades, 10),
    maxConsecutiveLosses: asNumber(row.maxConsecutiveLosses, 3),
    maxSimultaneousContracts: asNumber(row.maxSimultaneousContracts, 1),
    minCooldownSeconds: asNumber(row.minCooldownSeconds, 120),
    maxDrawdownPercent: asNumber(row.maxDrawdownPercent, 10),
    minBalance: asNumber(row.minBalance, 100),
    riskPerTradePercent: asNullableNumber(row.riskPerTradePercent),
    sessionStartHourUtc: asNullableNumber(row.sessionStartHourUtc),
    sessionEndHourUtc: asNullableNumber(row.sessionEndHourUtc),
    volumeOverrideLots: asNullableNumber(row.volumeOverrideLots),
    stopLossDistanceOverride: asNullableNumber(row.stopLossDistanceOverride),
    maxTotalOpenRiskPercent: asNullableNumber(row.maxTotalOpenRiskPercent),
    maxConcurrentPositions: asNullableNumber(row.maxConcurrentPositions),
    minRiskRewardRatio: asNullableNumber(row.minRiskRewardRatio)
  };
}

/**
 * Merge a partial risk update onto the existing profile.
 * - Omitted keys keep existing values (no silent defaults).
 * - Explicit `null` clears nullable fields only.
 */
export function mergeRiskProfileUpdate(
  existing: RiskProfileSnapshot,
  patch: RiskProfileUpdateInput
): RiskProfileSnapshot {
  const pick = <K extends keyof RiskProfileSnapshot>(
    key: K,
    patchValue: RiskProfileSnapshot[K] | undefined
  ): RiskProfileSnapshot[K] => (patchValue !== undefined ? patchValue : existing[key]);

  return {
    fixedStake: pick("fixedStake", patch.fixedStake),
    maxStakePerTrade: pick("maxStakePerTrade", patch.maxStakePerTrade),
    maxDailyLoss: pick("maxDailyLoss", patch.maxDailyLoss),
    maxDailyTrades: pick("maxDailyTrades", patch.maxDailyTrades),
    maxConsecutiveLosses: pick("maxConsecutiveLosses", patch.maxConsecutiveLosses),
    maxSimultaneousContracts: pick("maxSimultaneousContracts", patch.maxSimultaneousContracts),
    minCooldownSeconds: pick("minCooldownSeconds", patch.minCooldownSeconds),
    maxDrawdownPercent: pick("maxDrawdownPercent", patch.maxDrawdownPercent),
    minBalance: pick("minBalance", patch.minBalance),
    riskPerTradePercent: pick("riskPerTradePercent", patch.riskPerTradePercent),
    sessionStartHourUtc: pick("sessionStartHourUtc", patch.sessionStartHourUtc),
    sessionEndHourUtc: pick("sessionEndHourUtc", patch.sessionEndHourUtc),
    volumeOverrideLots: pick("volumeOverrideLots", patch.volumeOverrideLots),
    stopLossDistanceOverride: pick("stopLossDistanceOverride", patch.stopLossDistanceOverride),
    maxTotalOpenRiskPercent: pick("maxTotalOpenRiskPercent", patch.maxTotalOpenRiskPercent),
    maxConcurrentPositions: pick("maxConcurrentPositions", patch.maxConcurrentPositions),
    minRiskRewardRatio: pick("minRiskRewardRatio", patch.minRiskRewardRatio)
  };
}

export class RiskProfileMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskProfileMergeError";
  }
}

/** Cross-field + range validation after merge (mirrors prior PUT checks). */
export function assertMergedRiskProfile(merged: RiskProfileSnapshot): void {
  if (merged.maxStakePerTrade < merged.fixedStake) {
    throw new RiskProfileMergeError("maxStakePerTrade cannot be below fixedStake");
  }
  if (!(merged.fixedStake >= 0.35 && merged.fixedStake <= 100)) {
    throw new RiskProfileMergeError("fixedStake out of range");
  }
  if (!(merged.maxStakePerTrade >= 0.35 && merged.maxStakePerTrade <= 100)) {
    throw new RiskProfileMergeError("maxStakePerTrade out of range");
  }
  if (!(merged.maxDailyLoss >= 0.5 && merged.maxDailyLoss <= 1000)) {
    throw new RiskProfileMergeError("maxDailyLoss out of range");
  }
  if (!(merged.maxDailyTrades >= 1 && merged.maxDailyTrades <= 100)) {
    throw new RiskProfileMergeError("maxDailyTrades out of range");
  }
  if (!(merged.maxConsecutiveLosses >= 1 && merged.maxConsecutiveLosses <= 10)) {
    throw new RiskProfileMergeError("maxConsecutiveLosses out of range");
  }
  if (!(merged.maxSimultaneousContracts >= 1 && merged.maxSimultaneousContracts <= 5)) {
    throw new RiskProfileMergeError("maxSimultaneousContracts out of range");
  }
  if (!(merged.minCooldownSeconds >= 0 && merged.minCooldownSeconds <= 86_400)) {
    throw new RiskProfileMergeError("minCooldownSeconds out of range");
  }
  if (!(merged.maxDrawdownPercent >= 1 && merged.maxDrawdownPercent <= 50)) {
    throw new RiskProfileMergeError("maxDrawdownPercent out of range");
  }
  if (!(merged.minBalance >= 0 && merged.minBalance <= 1_000_000)) {
    throw new RiskProfileMergeError("minBalance out of range");
  }
  if (merged.riskPerTradePercent != null) {
    if (!(merged.riskPerTradePercent > 0 && merged.riskPerTradePercent <= 5)) {
      throw new RiskProfileMergeError("riskPerTradePercent out of range");
    }
  }
  if (merged.sessionStartHourUtc != null) {
    if (!(merged.sessionStartHourUtc >= 0 && merged.sessionStartHourUtc <= 23)) {
      throw new RiskProfileMergeError("sessionStartHourUtc out of range");
    }
  }
  if (merged.sessionEndHourUtc != null) {
    if (!(merged.sessionEndHourUtc >= 0 && merged.sessionEndHourUtc <= 24)) {
      throw new RiskProfileMergeError("sessionEndHourUtc out of range");
    }
  }
  if (merged.volumeOverrideLots != null && !(merged.volumeOverrideLots > 0 && merged.volumeOverrideLots <= 100)) {
    throw new RiskProfileMergeError("volumeOverrideLots out of range");
  }
  if (
    merged.stopLossDistanceOverride != null &&
    !(merged.stopLossDistanceOverride > 0 && merged.stopLossDistanceOverride <= 10_000)
  ) {
    throw new RiskProfileMergeError("stopLossDistanceOverride out of range");
  }
  if (
    merged.maxTotalOpenRiskPercent != null &&
    !(merged.maxTotalOpenRiskPercent > 0 && merged.maxTotalOpenRiskPercent <= 50)
  ) {
    throw new RiskProfileMergeError("maxTotalOpenRiskPercent out of range");
  }
  if (
    merged.maxConcurrentPositions != null &&
    !(merged.maxConcurrentPositions >= 1 && merged.maxConcurrentPositions <= 20)
  ) {
    throw new RiskProfileMergeError("maxConcurrentPositions out of range");
  }
  if (
    merged.minRiskRewardRatio != null &&
    !(merged.minRiskRewardRatio > 0 && merged.minRiskRewardRatio <= 20)
  ) {
    throw new RiskProfileMergeError("minRiskRewardRatio out of range");
  }
}

export function riskProfileWarnings(merged: RiskProfileSnapshot): string[] {
  const warnings: string[] = [];
  if (merged.fixedStake > 25) {
    warnings.push("Fixed stake above $25 — fine for demo, but confirm it matches what you intend per trade.");
  }
  if (merged.maxDailyLoss > 200) {
    warnings.push("Daily loss limit above $200 — consider whether that cap fits your demo experiment.");
  }
  if (merged.maxConsecutiveLosses > 10) {
    warnings.push("More than 10 consecutive losses allowed before the engine pauses trading.");
  }
  if (merged.maxDrawdownPercent > 40) {
    warnings.push("Drawdown limit above 40% — unusually loose for risk control.");
  }
  if (merged.riskPerTradePercent != null && merged.riskPerTradePercent > 2) {
    warnings.push("Risk per trade above 2% of equity is aggressive for CFD sizing.");
  }
  if (merged.volumeOverrideLots != null) {
    warnings.push("Fixed lot override is active — risk % no longer sizes volume for new entries.");
  }
  if (merged.stopLossDistanceOverride != null) {
    warnings.push("Stop-distance override is active — strategy stop loss is replaced for new entries.");
  }
  return warnings;
}
