import { type MarketRegime, type ResearchVerdict } from "@regimex/shared";
import { type StrategyPerformanceRecord } from "../selection/strategySelector.js";

/** DB/metric row shape used to build selection performance records. */
export interface CfdPerformanceMetricRow {
  strategyId: string;
  symbol: string;
  interval: string;
  regime: string;
  segment: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  expectancyR: number | null;
  averageR: number | null;
  averageGrossR: number | null;
  maxDrawdownPercent: number;
  researchConfidence: number | null;
  researchVerdict: string | null;
  degradationPercent: number | null;
  forwardTradeCount: number;
  recentForwardExpectancyR: number | null;
  executionModel: string;
  strategyVersion: string | null;
  configHash: string | null;
  parameterStabilityScore: number | null;
  updatedAt?: Date | number | null;
}

const SEGMENT_PRIORITY = ["HOLDOUT", "WALK_FORWARD", "PAPER_FORWARD", "TEST", "OVERALL", "TRAIN"];
// MT5_BROKER_DEMO_FORWARD is a separate evidence lane and is intentionally
// not in this list — do not merge it into validated selection.

/**
 * Pick the best research/paper metric row per strategy×regime for a symbol/interval,
 * scoped to cfd_v1. Does not merge incompatible symbols/intervals.
 */
export function buildCfdPerformanceRecords(input: {
  symbol: string;
  interval: string;
  regime: MarketRegime;
  rows: ReadonlyArray<CfdPerformanceMetricRow>;
}): StrategyPerformanceRecord[] {
  const scoped = input.rows.filter(
    (r) =>
      r.symbol === input.symbol &&
      r.interval === input.interval &&
      r.executionModel === "cfd_v1" &&
      r.regime === input.regime
  );

  const byStrategy = new Map<string, CfdPerformanceMetricRow[]>();
  for (const row of scoped) {
    const list = byStrategy.get(row.strategyId) ?? [];
    list.push(row);
    byStrategy.set(row.strategyId, list);
  }

  const records: StrategyPerformanceRecord[] = [];
  for (const [strategyId, list] of byStrategy) {
    list.sort((a, b) => {
      const pa = SEGMENT_PRIORITY.indexOf(a.segment);
      const pb = SEGMENT_PRIORITY.indexOf(b.segment);
      return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    });
    const primary = list[0]!;
    const paper = list.find((r) => r.segment === "PAPER_FORWARD");
    records.push({
      strategyId,
      regime: input.regime,
      trades: primary.totalTrades,
      profitFactor: primary.profitFactor,
      expectancy: primary.expectancy,
      outOfSampleExpectancy: primary.expectancyR ?? primary.expectancy,
      winRate: primary.winRate,
      maxDrawdownPercent: primary.maxDrawdownPercent,
      recentExpectancy: primary.recentForwardExpectancyR ?? primary.expectancyR,
      sharpeLike: null,
      stabilityScore: primary.parameterStabilityScore,
      symbol: input.symbol,
      interval: input.interval,
      executionModel: "cfd_v1",
      strategyVersion: primary.strategyVersion ?? undefined,
      configHash: primary.configHash,
      expectancyR: primary.expectancyR,
      averageR: primary.averageR,
      averageGrossR: primary.averageGrossR,
      researchVerdict: (primary.researchVerdict as ResearchVerdict | null) ?? null,
      confidenceScore: primary.researchConfidence,
      degradationPercent: primary.degradationPercent,
      forwardTradeCount: paper?.forwardTradeCount ?? primary.forwardTradeCount ?? 0,
      recentForwardExpectancyR:
        paper?.recentForwardExpectancyR ?? primary.recentForwardExpectancyR ?? null,
      updatedAt:
        primary.updatedAt instanceof Date
          ? primary.updatedAt.getTime()
          : typeof primary.updatedAt === "number"
            ? primary.updatedAt
            : undefined
    });
  }
  return records;
}
