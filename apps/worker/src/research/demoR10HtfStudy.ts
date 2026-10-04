import type { HtfShadowAssessment } from "../engine/demoR10HtfShadow.js";

export interface StudyTrade {
  id: string; symbol: string; interval: string | null; origin: string; direction: string;
  strategyId: string; strategyVersion: string | null; signalId: string | null;
  status: string; realizedPnl: number | null; closeReason: string | null;
  metadata: unknown;
}
export function isDemoR10StudyTrade(trade: StudyTrade): boolean {
  const metadata = trade.metadata as { executionModel?: unknown } | null;
  return trade.symbol === "R_10" && trade.interval === "1m" && trade.origin === "ENGINE" &&
    (trade.direction === "BUY" || trade.direction === "SELL") && trade.signalId != null &&
    (trade.status === "OPEN" || trade.status === "CLOSED") && metadata?.executionModel === "broker_demo_mt5";
}
export interface StudyObservation {
  positionId: string; strategyVersion: string | null; assessedAt: string;
  demoLossBypass: unknown; demoTradeExperiment: unknown; assessment: HtfShadowAssessment;
}
export function summarizeHtfStudy(trades: readonly StudyTrade[], observations: readonly StudyObservation[]) {
  const matched = trades.filter(isDemoR10StudyTrade).map(trade => ({ trade,
    observation: observations.find(o => o.positionId === trade.id) })).filter(row => row.observation != null);
  const closed = matched.filter(({ trade }) => trade.status === "CLOSED" && trade.realizedPnl != null && Number.isFinite(trade.realizedPnl));
  function metrics(rows: typeof closed) {
    const wins = rows.filter(r => r.trade.realizedPnl! > 0);
    const losses = rows.filter(r => r.trade.realizedPnl! < 0);
    const grossProfit = wins.reduce((sum, r) => sum + r.trade.realizedPnl!, 0);
    const grossLoss = -losses.reduce((sum, r) => sum + r.trade.realizedPnl!, 0);
    const netPnl = grossProfit - grossLoss;
    return { closedTrades: rows.length, wins: wins.length, losses: losses.length,
      pushes: rows.length - wins.length - losses.length, netPnl, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      expectancy: rows.length ? netPnl / rows.length : null, winRate: rows.length ? wins.length / rows.length : null };
  }
  function cohorts(rows: typeof closed) {
    return { baseline: metrics(rows), comparisons: ["15m", "4h"].map(interval => {
      const pass = (row: typeof closed[number]) => row.observation!.assessment.comparisons.find(c => c.interval === interval)?.wouldPassTrendFilter;
      const covered = rows.filter(r => typeof pass(r) === "boolean");
      return { interval, coveredClosedTrades: covered.length, indeterminateClosedTrades: rows.length - covered.length,
        // Same covered baseline avoids treating missing history as a rejected challenger entry.
        coveredBaseline: metrics(covered), aligned: metrics(covered.filter(r => pass(r) === true)),
        opposedOrNeutral: metrics(covered.filter(r => pass(r) === false)) };
    }) };
  }
  return { observationalOnly: true, assessedPositions: matched.length, openPositions: matched.filter(r => r.trade.status === "OPEN").length,
    closedPositions: closed.length, closedWithoutPnl: matched.filter(r => r.trade.status === "CLOSED" && (r.trade.realizedPnl == null || !Number.isFinite(r.trade.realizedPnl))).length,
    ...cohorts(closed), byStrategyVersion: [...new Set(closed.map(r => `${r.trade.strategyId}@${r.trade.strategyVersion ?? "unknown"}`))].map(key => ({ key,
      ...cohorts(closed.filter(r => `${r.trade.strategyId}@${r.trade.strategyVersion ?? "unknown"}` === key)) })),
    closeReasons: [...new Set(closed.map(r => r.trade.closeReason ?? "UNKNOWN"))].map(reason => ({ reason,
      ...cohorts(closed.filter(r => (r.trade.closeReason ?? "UNKNOWN") === reason)) })),
    limitations: ["Price history is shared across MT5 environments, not account-tagged.",
      "Stored PnL may omit costs or manual-exit provenance; verify broker deals before an effectiveness decision.",
      "Aligned subsets are counterfactual exclusions, not a replay of portfolio capacity, sizing or later entries.",
      "Missing history and small samples cannot establish improvement; no automatic trading switch."] };
}
