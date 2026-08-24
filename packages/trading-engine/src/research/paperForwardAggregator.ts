import { type MarketRegime } from "@regimex/shared";
import { computeCfdSummary, type CfdBacktestSummary, type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";

/**
 * Closed paper CFD positions that may count as forward-validation evidence.
 * Only ENGINE-originated trades should be passed in (manual/admin excluded).
 */
export interface PaperForwardPositionRow {
  strategyId: string;
  strategyVersion?: string | null;
  symbol: string;
  interval?: string | null;
  regime: string | null;
  direction: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  volume: number;
  realizedPnl: number;
  riskAmount: number;
  openedAt: number;
  closedAt: number;
  origin: "ENGINE" | "MANUAL" | "ADMIN" | string;
  closeReason?: string | null;
  netR?: number | null;
  grossR?: number | null;
  /** Keep paper / MT5 DEMO / cTrader DEMO lanes separate. Default PAPER. */
  executionVenue?: "PAPER" | "MT5_DEMO" | "CTRADER_DEMO" | string;
}

export interface PaperForwardBucket {
  strategyId: string;
  symbol: string;
  interval: string;
  regime: string;
  summary: CfdBacktestSummary;
  tradeCount: number;
}

function isEngineOrigin(row: PaperForwardPositionRow): boolean {
  if (row.origin === "MANUAL" || row.origin === "ADMIN" || row.origin === "TEST") return false;
  if (row.strategyId === "manual" || row.strategyId.startsWith("admin:") || row.strategyId === "manual-test")
    return false;
  return row.origin === "ENGINE" || row.origin === "engine" || !row.origin;
}

function isPaperVenue(row: PaperForwardPositionRow): boolean {
  const venue = String(row.executionVenue ?? "PAPER").toUpperCase();
  if (venue === "MT5_DEMO" || venue === "BROKER_DEMO_MT5") return false;
  if (venue === "CTRADER_DEMO" || venue === "BROKER_DEMO_CFD") return false;
  return true;
}

/**
 * Aggregate CLOSED paper CFD positions into per strategy×symbol×interval×regime
 * CFD summaries for validated selection forward evidence.
 * Does not include MT5 broker-demo or cTrader broker-demo fills.
 */
export function aggregatePaperForwardPerformance(
  rows: ReadonlyArray<PaperForwardPositionRow>,
  startingBalance = 10_000
): PaperForwardBucket[] {
  const engineRows = rows.filter((row) => isEngineOrigin(row) && isPaperVenue(row));
  const groups = new Map<string, PaperForwardPositionRow[]>();

  for (const row of engineRows) {
    const regime = row.regime ?? "UNKNOWN";
    const interval = row.interval ?? "1m";
    const key = `${row.strategyId}|${row.symbol}|${interval}|${regime}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const buckets: PaperForwardBucket[] = [];
  for (const [key, list] of groups) {
    const [strategyId, symbol, interval, regime] = key.split("|") as [string, string, string, string];
    const trades: CfdSimulatedTrade[] = list.map((row) => {
      const risk = row.riskAmount > 0 ? row.riskAmount : 1;
      const netR =
        row.netR ?? (risk > 0 ? Number((row.realizedPnl / risk).toFixed(4)) : null);
      return {
        strategyId: row.strategyId,
        strategyVersion: row.strategyVersion ?? "paper",
        regime: regime as MarketRegime,
        regimeConfidence: 0,
        action: row.direction,
        entryTime: row.openedAt,
        exitTime: row.closedAt,
        entryPrice: row.entryPrice,
        exitPrice: row.exitPrice,
        exitTriggerPrice: row.exitPrice,
        volume: row.volume,
        riskAmount: risk,
        initialRiskAmount: risk,
        riskPercent: 0,
        stopLoss: row.entryPrice,
        takeProfit: row.exitPrice,
        profit: row.realizedPnl,
        grossPnl: row.realizedPnl,
        netPnl: row.realizedPnl,
        grossR: row.grossR ?? netR,
        netR,
        outcome: row.realizedPnl > 0 ? "WIN" : row.realizedPnl < 0 ? "LOSS" : "PUSH",
        closeReason: "STRATEGY_EXIT",
        barsHeld: 1,
        rMultiple: netR,
        confidence: 0,
        entryReason: ["paper_forward"],
        isOutOfSample: true,
        simulatorVersion: "cfd_v1"
      };
    });

    const { summary } = computeCfdSummary(trades, startingBalance);
    buckets.push({
      strategyId,
      symbol,
      interval,
      regime,
      summary,
      tradeCount: trades.length
    });
  }

  return buckets;
}
