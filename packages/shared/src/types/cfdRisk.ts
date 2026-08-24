import { type CfdRiskLimits, DEFAULT_CFD_RISK_LIMITS } from "./execution.js";

/** Optional CFD fields on RiskProfile — legacy stake fields remain for binary history. */
export interface CfdRiskProfileExtension {
  riskPerTradePercent: number | null;
  maxTotalOpenRiskPercent: number | null;
  maxConcurrentPositions: number | null;
  minRiskRewardRatio: number | null;
}

export function resolveCfdRiskLimits(profile: Partial<CfdRiskProfileExtension>): CfdRiskLimits {
  return {
    riskPerTradePercent: profile.riskPerTradePercent ?? DEFAULT_CFD_RISK_LIMITS.riskPerTradePercent,
    maxTotalOpenRiskPercent:
      profile.maxTotalOpenRiskPercent ?? DEFAULT_CFD_RISK_LIMITS.maxTotalOpenRiskPercent,
    maxConcurrentPositions:
      profile.maxConcurrentPositions ?? DEFAULT_CFD_RISK_LIMITS.maxConcurrentPositions,
    minRiskRewardRatio: profile.minRiskRewardRatio ?? DEFAULT_CFD_RISK_LIMITS.minRiskRewardRatio
  };
}
