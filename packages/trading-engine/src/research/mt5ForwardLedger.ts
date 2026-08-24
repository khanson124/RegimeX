import { type CfdBacktestSummary } from "../backtest/cfdMetrics.js";
import {
  aggregateMt5BrokerDemoForwardPerformance,
  type Mt5BrokerDemoForwardBucket
} from "./mt5BrokerDemoForwardAggregator.js";
import { type PaperForwardPositionRow } from "./paperForwardAggregator.js";

export interface Mt5ForwardLedgerStats {
  strategyId: string;
  symbol: string;
  interval: string;
  regime: string;
  trades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  netRealizedPnl: number;
  averageWin: number;
  averageLoss: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  expectancyR: number;
  cumulativeR: number;
  averageRealizedR: number | null;
  maxDrawdownPercent: number;
  consecutiveLosses: number;
  sampleSize: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  averageEntrySlippageBps: number | null;
  averageExitSlippageBps: number | null;
  summary: CfdBacktestSummary;
}

function consecutiveLossesFromRows(rows: PaperForwardPositionRow[]): number {
  const ordered = [...rows].sort((a, b) => b.closedAt - a.closedAt);
  let n = 0;
  for (const row of ordered) {
    if (row.realizedPnl < 0) n += 1;
    else break;
  }
  return n;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildMt5ForwardLedger(
  rows: ReadonlyArray<PaperForwardPositionRow>,
  startingBalance = 10_000
): Mt5ForwardLedgerStats[] {
  const buckets: Mt5BrokerDemoForwardBucket[] = aggregateMt5BrokerDemoForwardPerformance(
    rows,
    startingBalance
  );
  return buckets.map((bucket) => {
    const group = rows.filter(
      (r) =>
        r.strategyId === bucket.strategyId &&
        r.symbol === bucket.symbol &&
        (r.interval ?? "1m") === bucket.interval &&
        (r.regime ?? "UNKNOWN") === bucket.regime
    );
    const times = group.map((r) => r.closedAt);
    const rValues = group
      .map((r) => {
        const risk = r.riskAmount > 0 ? r.riskAmount : 0;
        return risk > 0 ? r.realizedPnl / risk : null;
      })
      .filter((v): v is number => v != null);
    const s = bucket.summary;
    return {
      strategyId: bucket.strategyId,
      symbol: bucket.symbol,
      interval: bucket.interval,
      regime: bucket.regime,
      trades: s.totalTrades,
      wins: s.winningTrades,
      losses: s.losingTrades,
      grossProfit: s.grossProfit,
      grossLoss: s.grossLoss,
      netRealizedPnl: s.netProfit,
      averageWin: s.averageWin,
      averageLoss: s.averageLoss,
      winRate: s.winRate,
      profitFactor: s.profitFactor,
      expectancy: s.expectancy,
      expectancyR: s.expectancyR,
      cumulativeR: Number(rValues.reduce((a, b) => a + b, 0).toFixed(4)),
      averageRealizedR: mean(rValues),
      maxDrawdownPercent: s.maxDrawdownPercent,
      consecutiveLosses: consecutiveLossesFromRows(group),
      sampleSize: s.totalTrades,
      firstTradeAt: times.length ? Math.min(...times) : null,
      lastTradeAt: times.length ? Math.max(...times) : null,
      averageEntrySlippageBps: null,
      averageExitSlippageBps: null,
      summary: s
    };
  });
}

export function ledgerFromPositions(
  positions: Array<{
    strategyId: string;
    strategyVersion?: string | null;
    symbol: string;
    interval?: string | null;
    regime: string | null;
    direction: "BUY" | "SELL" | string;
    entryPrice: number | null;
    closePrice: number | null;
    volume: number;
    realizedPnl: number | null;
    riskAmount: number | null;
    initialRiskAmount?: number | null;
    openedAt: number | Date | null;
    closedAt: number | Date | null;
    origin: string;
    closeReason?: string | null;
    metadata?: { executionModel?: string } | null;
    appliedEntrySlippageBps?: number | null;
    appliedExitSlippageBps?: number | null;
  }>
): Mt5ForwardLedgerStats[] {
  const rows: PaperForwardPositionRow[] = positions.map((p) => ({
    strategyId: p.strategyId,
    strategyVersion: p.strategyVersion,
    symbol: p.symbol,
    interval: p.interval ?? "1m",
    regime: p.regime,
    direction: p.direction === "SELL" ? "SELL" : "BUY",
    entryPrice: p.entryPrice ?? 0,
    exitPrice: p.closePrice ?? 0,
    volume: p.volume,
    realizedPnl: p.realizedPnl ?? 0,
    riskAmount: p.riskAmount ?? p.initialRiskAmount ?? 0,
    openedAt: toMs(p.openedAt),
    closedAt: toMs(p.closedAt),
    origin: p.origin,
    closeReason: p.closeReason,
    executionVenue: "MT5_DEMO"
  }));
  const stats = buildMt5ForwardLedger(rows);
  return stats.map((s) => {
    const group = positions.filter(
      (p) =>
        p.strategyId === s.strategyId &&
        p.symbol === s.symbol &&
        (p.interval ?? "1m") === s.interval &&
        (p.regime ?? "UNKNOWN") === s.regime
    );
    const entrySlip = group
      .map((p) => p.appliedEntrySlippageBps)
      .filter((v): v is number => v != null);
    const exitSlip = group
      .map((p) => p.appliedExitSlippageBps)
      .filter((v): v is number => v != null);
    return {
      ...s,
      averageEntrySlippageBps: mean(entrySlip),
      averageExitSlippageBps: mean(exitSlip)
    };
  });
}

function toMs(v: number | Date | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "number" ? v : v.getTime();
}
