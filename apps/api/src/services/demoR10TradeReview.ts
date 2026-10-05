export const DEMO_R10_REVIEW_LIMIT = 1000;
export interface ReviewTrade {
  id: string; symbol: string; interval: string | null; origin: string; status: string;
  strategyId: string; strategyVersion: string | null; closeReason: string | null;
  realizedPnl: number | null; initialRiskAmount: number | null;
  closedAt: Date | null; metadata: unknown; correlationId: string | null;
  direction?: string; openedAt?: Date | null;
}
export interface ReviewSelection {
  correlationId: string; strategyId: string | null; featureSummary: unknown;
}
function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function isDemoR10ReviewTrade(t: ReviewTrade): boolean {
  return t.symbol === "R_10" && t.interval === "1m" && t.origin === "ENGINE" && t.status === "CLOSED" &&
    record(t.metadata).executionModel === "broker_demo_mt5";
}
function exitGroup(t: ReviewTrade): string {
  if (t.closeReason === "MANUAL") return "MANUAL";
  if (["STOP_LOSS", "TAKE_PROFIT", "STRATEGY_EXIT", "TRAILING_STOP", "BREAK_EVEN_STOP", "MAX_HOLD_TIME"].includes(t.closeReason ?? "")) return "AUTOMATIC";
  if (t.closeReason === "RISK_SHUTDOWN") return "SAFETY";
  return "UNKNOWN";
}
export function measureReviewTrades(trades: readonly ReviewTrade[]) {
  const valued = trades.filter(t => t.realizedPnl != null && Number.isFinite(t.realizedPnl));
  const wins = valued.filter(t => t.realizedPnl! > 0);
  const losses = valued.filter(t => t.realizedPnl! < 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const grossLoss = -losses.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const netPnl = grossProfit - grossLoss;
  const riskValued = valued.filter(t => t.initialRiskAmount != null && Number.isFinite(t.initialRiskAmount) && t.initialRiskAmount > 0);
  return { trades: trades.length, valuedTrades: valued.length, missingPnl: trades.length - valued.length,
    wins: wins.length, losses: losses.length, pushes: valued.length - wins.length - losses.length,
    netPnl: valued.length ? netPnl : null, grossProfit: valued.length ? grossProfit : null, grossLoss: valued.length ? grossLoss : null,
    winRate: valued.length ? wins.length / valued.length : null, expectancy: valued.length ? netPnl / valued.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    riskValuedTrades: riskValued.length,
    expectancyR: riskValued.length ? riskValued.reduce((sum, t) => sum + t.realizedPnl! / t.initialRiskAmount!, 0) / riskValued.length : null };
}
function selectionGroup(trade: ReviewTrade, selections: ReadonlyMap<string, ReviewSelection[]>): string {
  if (!trade.correlationId) return "UNKNOWN";
  const rows = selections.get(trade.correlationId) ?? [];
  if (rows.length !== 1) return "UNKNOWN";
  const s = rows[0]!; const features = record(s.featureSummary);
  if (features.symbol !== "R_10" || features.interval !== "1m" || !s.strategyId) return "UNKNOWN";
  if (features.engineSelectionMode === "AUTO") return s.strategyId === trade.strategyId ? "AUTO_ORIGINAL" : "AUTO_FALLBACK";
  if (features.engineSelectionMode === "SINGLE" && s.strategyId === trade.strategyId) return "SINGLE";
  if (features.engineSelectionMode === "ENSEMBLE") return "ENSEMBLE";
  return "UNKNOWN";
}
function tagGroup(trade: ReviewTrade, key: string, flag: string): string {
  const value = record(record(trade.metadata)[key])[flag];
  return value === true ? "ENABLED" : value === false ? "DISABLED" : "UNRECORDED";
}
/** Reporting only. Classify recorded outcomes without rewriting evidence or inventing counterfactual exits. */
export function buildDemoR10TradeReview(input: readonly ReviewTrade[], selections: readonly ReviewSelection[] = [], hasMore = false) {
  const trades = input.filter(isDemoR10ReviewTrade);
  const selectionIndex = new Map<string, ReviewSelection[]>();
  for (const selection of selections) {
    const rows = selectionIndex.get(selection.correlationId) ?? [];
    rows.push(selection); selectionIndex.set(selection.correlationId, rows);
  }
  function groups(classify: (t: ReviewTrade) => string, keys?: string[]) {
    return (keys ?? [...new Set(trades.map(classify))].sort()).map(key => {
      const rows = trades.filter(t => classify(t) === key);
      return { key, ...measureReviewTrades(rows), exits: ["MANUAL", "AUTOMATIC", "SAFETY", "UNKNOWN"].map(exit => ({ key: exit, ...measureReviewTrades(rows.filter(t => exitGroup(t) === exit)) })) };
    });
  }
  const times = trades.map(t => t.closedAt?.getTime()).filter((n): n is number => n != null && Number.isFinite(n));
  return { scope: "R_10 / 1m / MT5 DEMO / ENGINE" as const, limit: DEMO_R10_REVIEW_LIMIT, hasMore,
    sampledClosedTrades: trades.length, firstCloseAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastCloseAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    overall: measureReviewTrades(trades), exits: groups(exitGroup, ["MANUAL", "AUTOMATIC", "SAFETY", "UNKNOWN"]),
    strategies: groups(t => JSON.stringify([t.strategyId, t.strategyVersion])).map(g => {
      const [strategyId, strategyVersion] = JSON.parse(g.key) as [string, string | null];
      return { ...g, strategyId, strategyVersion };
    }),
    lossBypass: groups(t => tagGroup(t, "demoLossBypass", "enabled"), ["ENABLED", "DISABLED", "UNRECORDED"]),
    tradeExperiment: groups(t => tagGroup(t, "demoTradeExperiment", "active"), ["ENABLED", "DISABLED", "UNRECORDED"]),
    selection: groups(t => selectionGroup(t, selectionIndex), ["AUTO_ORIGINAL", "AUTO_FALLBACK", "SINGLE", "ENSEMBLE", "UNKNOWN"]),
    pnlBasis: "Stored realized P&L; no additional cost estimate. Missing values are excluded, not zero-filled.",
    interpretation: "Recorded exit groups describe outcomes, not what the same trades would have earned without manual intervention. Stops/targets may have been edited; missing experiment/selection metadata stays unclassified." };
}
