import { addMoney, roundMoney, CFD_SIMULATOR_VERSION, type MarketRegime } from "@regimex/shared";
import { type PositionCloseReason } from "@regimex/shared";
import { type EquityPoint } from "./metrics.js";
import { type CfdTradeEntryFeatureSnapshot } from "../research/cfdTradeEntrySnapshot.js";

export type { EquityPoint };

export interface CfdSimulatedTrade {
  strategyId: string;
  strategyVersion: string;
  regime: MarketRegime;
  regimeConfidence: number;
  action: "BUY" | "SELL";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  exitTriggerPrice: number;
  volume: number;
  /** Initial risk used for sizing (loss at SL from filled entry). */
  riskAmount: number;
  initialRiskAmount: number;
  riskPercent: number;
  stopLoss: number;
  takeProfit: number;
  /** Settled P&L credited to equity (= netPnl). */
  profit: number;
  /** entryFill → exitTrigger (before exit fill costs). */
  grossPnl: number;
  /** entryFill → exitFill (after exit half-spread + slippage). */
  netPnl: number;
  grossR: number | null;
  /** Prefer for research / expectancyR / averageR. */
  netR: number | null;
  outcome: "WIN" | "LOSS" | "PUSH";
  closeReason: PositionCloseReason;
  barsHeld: number;
  /** @deprecated Alias of netR — prefer netR. */
  rMultiple: number | null;
  confidence: number;
  entryReason: string[];
  isOutOfSample: boolean;
  simulatorVersion: typeof CFD_SIMULATOR_VERSION;
  /** Decision-time feature context at entry (no future candles). */
  entryFeatures?: CfdTradeEntryFeatureSnapshot;
}

export interface CfdBacktestSummary {
  simulatorVersion: typeof CFD_SIMULATOR_VERSION;
  /** Research R metrics use netR (after exit fill costs). */
  rMetric: "netR";
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  pushTrades: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number | null;
  expectancy: number;
  /** Mean netR across trades. */
  expectancyR: number;
  /** Mean netR across trades with defined risk. */
  averageR: number | null;
  /** Mean grossR (diagnostic). */
  averageGrossR: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  longestWinStreak: number;
  longestLossStreak: number;
  averageHoldingMs: number;
  averageBarsHeld: number;
  /** Fraction of timeline bars with an open position (approx via barsHeld / total). */
  exposureBars: number;
  endingBalance: number;
  returnPercent: number;
  rejectedSignalCount: number;
  noTradeCount: number;
}

export function computeCfdSummary(
  trades: ReadonlyArray<CfdSimulatedTrade>,
  startingBalance: number,
  counters: { rejectedSignalCount?: number; noTradeCount?: number } = {}
): { summary: CfdBacktestSummary; equityCurve: EquityPoint[] } {
  let balance = startingBalance;
  let peak = startingBalance;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let holdingSum = 0;
  let barsHeldSum = 0;
  let netRSum = 0;
  let netRCount = 0;
  let grossRSum = 0;
  let grossRCount = 0;

  const equityCurve: EquityPoint[] = [];

  for (const t of trades) {
    balance = addMoney(balance, t.profit);
    holdingSum += t.exitTime - t.entryTime;
    barsHeldSum += t.barsHeld;
    if (t.netR !== null) {
      netRSum += t.netR;
      netRCount++;
    }
    if (t.grossR !== null) {
      grossRSum += t.grossR;
      grossRCount++;
    }

    if (t.outcome === "WIN") {
      wins++;
      grossProfit = addMoney(grossProfit, t.profit);
      winStreak++;
      lossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, winStreak);
    } else if (t.outcome === "LOSS") {
      losses++;
      grossLoss = addMoney(grossLoss, Math.abs(t.profit));
      lossStreak++;
      winStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, lossStreak);
    } else {
      pushes++;
      winStreak = 0;
      lossStreak = 0;
    }

    peak = Math.max(peak, balance);
    const ddAbs = roundMoney(peak - balance);
    const ddPct = peak > 0 ? ddAbs / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, ddAbs);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, ddPct);
    equityCurve.push({ time: t.exitTime, balance, equity: balance, drawdown: ddPct });
  }

  const total = trades.length;
  const netProfit = roundMoney(grossProfit - grossLoss);
  const expectancy = total > 0 ? Number((netProfit / total).toFixed(4)) : 0;
  const averageR = netRCount > 0 ? Number((netRSum / netRCount).toFixed(4)) : null;
  const averageGrossR = grossRCount > 0 ? Number((grossRSum / grossRCount).toFixed(4)) : null;
  const expectancyR = averageR ?? 0;

  return {
    summary: {
      simulatorVersion: CFD_SIMULATOR_VERSION,
      rMetric: "netR",
      totalTrades: total,
      winningTrades: wins,
      losingTrades: losses,
      pushTrades: pushes,
      winRate: total > 0 ? wins / total : 0,
      grossProfit,
      grossLoss,
      netProfit,
      averageWin: wins > 0 ? roundMoney(grossProfit / wins) : 0,
      averageLoss: losses > 0 ? roundMoney(grossLoss / losses) : 0,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : null,
      expectancy,
      expectancyR,
      averageR,
      averageGrossR,
      maxDrawdown,
      maxDrawdownPercent,
      longestWinStreak,
      longestLossStreak,
      averageHoldingMs: total > 0 ? holdingSum / total : 0,
      averageBarsHeld: total > 0 ? barsHeldSum / total : 0,
      exposureBars: barsHeldSum,
      endingBalance: balance,
      returnPercent: startingBalance > 0 ? ((balance - startingBalance) / startingBalance) * 100 : 0,
      rejectedSignalCount: counters.rejectedSignalCount ?? 0,
      noTradeCount: counters.noTradeCount ?? 0
    },
    equityCurve
  };
}
