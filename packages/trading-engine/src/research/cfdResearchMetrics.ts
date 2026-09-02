import { type MetricSegment } from "@regimex/shared";
import {
  computeCfdSummary,
  type CfdBacktestSummary,
  type CfdSimulatedTrade
} from "../backtest/cfdMetrics.js";

/** Separator between regime and direction in composite StrategyRegimeMetric.regime keys. */
export const CFD_REGIME_DIRECTION_SEPARATOR = "|";

export type CfdResearchBreakdownSegment = Extract<MetricSegment, "WALK_FORWARD" | "HOLDOUT">;

export interface CfdStrategyRegimeBreakdownRow {
  strategyId: string;
  regime: string;
  segment: CfdResearchBreakdownSegment;
  summary: CfdBacktestSummary;
}

function groupKey(strategyId: string, regimeKey: string): string {
  return `${strategyId}::${regimeKey}`;
}

function sortTradesChronologically(trades: ReadonlyArray<CfdSimulatedTrade>): CfdSimulatedTrade[] {
  return [...trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
}

/**
 * Aggregate CFD simulated trades into per-regime / per-direction breakdown rows.
 * Does not emit aggregate `ALL` rows — callers keep those from experiment summaries.
 */
export function buildCfdStrategyRegimeBreakdownMetrics(
  trades: ReadonlyArray<CfdSimulatedTrade>,
  segment: CfdResearchBreakdownSegment,
  startingBalance: number
): CfdStrategyRegimeBreakdownRow[] {
  const buckets = new Map<string, { strategyId: string; regime: string; trades: CfdSimulatedTrade[] }>();

  for (const trade of trades) {
    const breakdownKeys = [
      trade.regime,
      `${trade.regime}${CFD_REGIME_DIRECTION_SEPARATOR}${trade.action}`,
      `ALL${CFD_REGIME_DIRECTION_SEPARATOR}${trade.action}`
    ];

    for (const regime of breakdownKeys) {
      const key = groupKey(trade.strategyId, regime);
      const bucket = buckets.get(key);
      if (bucket) bucket.trades.push(trade);
      else buckets.set(key, { strategyId: trade.strategyId, regime, trades: [trade] });
    }
  }

  const rows: CfdStrategyRegimeBreakdownRow[] = [];
  for (const bucket of buckets.values()) {
    const ordered = sortTradesChronologically(bucket.trades);
    const { summary } = computeCfdSummary(ordered, startingBalance);
    rows.push({
      strategyId: bucket.strategyId,
      regime: bucket.regime,
      segment,
      summary
    });
  }

  rows.sort((a, b) => {
    const byStrategy = a.strategyId.localeCompare(b.strategyId);
    if (byStrategy !== 0) return byStrategy;
    return a.regime.localeCompare(b.regime);
  });

  return rows;
}

export function cfdSummaryToStrategyRegimeMetricFields(summary: CfdBacktestSummary) {
  return {
    totalTrades: summary.totalTrades,
    wins: summary.winningTrades,
    losses: summary.losingTrades,
    pushes: summary.pushTrades,
    winRate: summary.winRate,
    profitFactor: summary.profitFactor,
    expectancy: summary.expectancy,
    averageWin: summary.averageWin,
    averageLoss: summary.averageLoss,
    netProfit: summary.netProfit,
    returnPercent: summary.returnPercent,
    maxDrawdown: summary.maxDrawdown,
    maxDrawdownPercent: summary.maxDrawdownPercent,
    longestWinStreak: summary.longestWinStreak,
    longestLossStreak: summary.longestLossStreak,
    expectancyR: summary.expectancyR,
    averageR: summary.averageR,
    averageGrossR: summary.averageGrossR
  };
}
