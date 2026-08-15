import { type MarketRegime } from "@regimex/shared";
import { type SimulatedTrade } from "../backtest/metrics.js";
import { buildStrategyRegimeMetrics, type StrategyRegimeMetricRow } from "./researchMetrics.js";

export interface DemoTradeRow {
  strategyId: string;
  regime: string;
  direction: string;
  stake: number;
  profit: number | null;
  status: string;
  openedAt: Date | null;
  settledAt: Date | null;
  signal?: { interval: string } | null;
}

export interface DemoForwardAggregateInput {
  trades: ReadonlyArray<DemoTradeRow>;
  symbol: string;
  interval: string;
  startingBalance: number;
}

/** Map settled demo trades to SimulatedTrade rows using the same metric pipeline as backtests. */
export function demoTradesToSimulated(trades: ReadonlyArray<DemoTradeRow>): SimulatedTrade[] {
  const rows: SimulatedTrade[] = [];
  for (const t of trades) {
    if (t.status !== "WON" && t.status !== "LOST") continue;
    if (t.profit === null || t.openedAt === null) continue;
    const outcome = t.status === "WON" ? "WIN" : "LOSS";
    rows.push({
      strategyId: t.strategyId,
      strategyVersion: "demo",
      regime: t.regime as MarketRegime,
      regimeConfidence: 0,
      action: t.direction === "PUT" ? "SELL" : "BUY",
      entryTime: t.openedAt.getTime(),
      exitTime: t.settledAt?.getTime() ?? t.openedAt.getTime(),
      entryPrice: 0,
      exitPrice: 0,
      stake: t.stake,
      payout: t.profit > 0 ? t.profit + t.stake : 0,
      profit: t.profit,
      outcome,
      confidence: 0,
      entryReason: ["Demo forward"],
      isOutOfSample: true
    });
  }
  return rows.sort((a, b) => a.entryTime - b.entryTime);
}

export function aggregateDemoForwardMetrics(input: DemoForwardAggregateInput): StrategyRegimeMetricRow[] {
  const simulated = demoTradesToSimulated(input.trades);
  return buildStrategyRegimeMetrics(
    simulated,
    input.symbol,
    input.interval,
    "DEMO_FORWARD",
    input.startingBalance
  );
}
