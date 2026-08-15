import { type HypotheticalOutcome } from "@regimex/shared";

export interface RiskRuleAnalyticsRow {
  rejectionCode: string;
  rejectedCandidates: number;
  hypotheticalWinners: number;
  hypotheticalLosers: number;
  hypotheticalPushes: number;
  pending: number;
  avoidedLossRate: number | null;
  missedWinRate: number | null;
}

export interface RiskRuleCandidateRow {
  rejectionCode: string | null;
  hypotheticalOutcome: HypotheticalOutcome | null;
}

/**
 * Analyze whether risk (or other) rejection codes correlate with avoided losses.
 * Research-only — does not modify RiskManager behavior.
 */
export function computeRiskRuleEffectiveness(
  rows: ReadonlyArray<RiskRuleCandidateRow>
): RiskRuleAnalyticsRow[] {
  const byCode = new Map<string, RiskRuleAnalyticsRow>();

  for (const row of rows) {
    const code = row.rejectionCode ?? "UNKNOWN";
    let agg = byCode.get(code);
    if (!agg) {
      agg = {
        rejectionCode: code,
        rejectedCandidates: 0,
        hypotheticalWinners: 0,
        hypotheticalLosers: 0,
        hypotheticalPushes: 0,
        pending: 0,
        avoidedLossRate: null,
        missedWinRate: null
      };
      byCode.set(code, agg);
    }
    agg.rejectedCandidates++;
    switch (row.hypotheticalOutcome) {
      case "WIN":
        agg.hypotheticalWinners++;
        break;
      case "LOSS":
        agg.hypotheticalLosers++;
        break;
      case "PUSH":
        agg.hypotheticalPushes++;
        break;
      default:
        agg.pending++;
    }
  }

  for (const agg of byCode.values()) {
    const resolved = agg.hypotheticalWinners + agg.hypotheticalLosers;
    if (resolved > 0) {
      agg.avoidedLossRate = agg.hypotheticalLosers / resolved;
      agg.missedWinRate = agg.hypotheticalWinners / resolved;
    }
  }

  return [...byCode.values()].sort((a, b) => b.rejectedCandidates - a.rejectedCandidates);
}
