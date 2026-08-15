import { addMoney, roundMoney, type MarketRegime } from "@regimex/shared";
import { type ContractOutcome } from "./contractSimulator.js";

export interface SimulatedTrade {
  strategyId: string;
  strategyVersion: string;
  regime: MarketRegime;
  regimeConfidence: number;
  action: "BUY" | "SELL";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stake: number;
  payout: number;
  profit: number;
  outcome: ContractOutcome;
  confidence: number;
  entryReason: string[];
  isOutOfSample: boolean;
}

export interface EquityPoint {
  time: number;
  balance: number;
  equity: number;
  /** Fractional drawdown from the running peak (0.05 = 5%). */
  drawdown: number;
}

export interface BacktestSummary {
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
  expectancy: number;
  profitFactor: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Average holding time in milliseconds. */
  averageHoldingMs: number;
  endingBalance: number;
  returnPercent: number;
  rejectedSignalCount: number;
  noTradeCount: number;
}

/**
 * Compute summary metrics from settled trades in chronological order.
 * All monetary aggregation uses cent-exact arithmetic.
 */
export function computeSummary(
  trades: ReadonlyArray<SimulatedTrade>,
  startingBalance: number,
  counters: { rejectedSignalCount: number; noTradeCount: number } = {
    rejectedSignalCount: 0,
    noTradeCount: 0
  }
): { summary: BacktestSummary; equityCurve: EquityPoint[] } {
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

  const equityCurve: EquityPoint[] = [];

  for (const t of trades) {
    balance = addMoney(balance, t.profit);
    holdingSum += t.exitTime - t.entryTime;

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
  // Expectancy keeps 4 decimals — cent rounding is too coarse per-trade.
  const expectancy = total > 0 ? Number((netProfit / total).toFixed(4)) : 0;

  const summary: BacktestSummary = {
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
    expectancy,
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : total > 0 && grossProfit > 0 ? null : null,
    maxDrawdown,
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(6)),
    longestWinStreak,
    longestLossStreak,
    averageHoldingMs: total > 0 ? holdingSum / total : 0,
    endingBalance: balance,
    returnPercent: startingBalance > 0 ? Number((((balance - startingBalance) / startingBalance) * 100).toFixed(4)) : 0,
    rejectedSignalCount: counters.rejectedSignalCount,
    noTradeCount: counters.noTradeCount
  };

  return { summary, equityCurve };
}

export interface GroupedPerformance {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number | null;
  expectancy: number;
}

export function groupPerformance(
  trades: ReadonlyArray<SimulatedTrade>,
  keyFn: (t: SimulatedTrade) => string
): GroupedPerformance[] {
  const map = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const key = keyFn(t);
    const bucket = map.get(key);
    if (bucket) bucket.push(t);
    else map.set(key, [t]);
  }
  return [...map.entries()].map(([key, group]) => {
    let gp = 0;
    let gl = 0;
    let wins = 0;
    let losses = 0;
    let net = 0;
    for (const t of group) {
      net = addMoney(net, t.profit);
      if (t.outcome === "WIN") {
        wins++;
        gp = addMoney(gp, t.profit);
      } else if (t.outcome === "LOSS") {
        losses++;
        gl = addMoney(gl, Math.abs(t.profit));
      }
    }
    return {
      key,
      trades: group.length,
      wins,
      losses,
      winRate: group.length > 0 ? wins / group.length : 0,
      netProfit: net,
      profitFactor: gl > 0 ? Number((gp / gl).toFixed(4)) : null,
      expectancy: group.length > 0 ? roundMoney(net / group.length) : 0
    };
  });
}
