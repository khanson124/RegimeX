import { type CfdBacktestSummary, type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";

export type SampleSizeFlag = "VERY_LOW_SAMPLE" | "LOW_SAMPLE" | "INFORMATIVE";

export type CostEdgeCase =
  | "RAW_EDGE_KILLED_BY_COSTS"
  | "NO_EDGE_EVEN_BEFORE_COSTS"
  | "PROMISING"
  | "TOO_SPARSE_INCONCLUSIVE";

export type ResearchVerdict =
  | "PROMISING_FOR_MORE_RESEARCH"
  | "RAW_EDGE_BUT_COST_SENSITIVE"
  | "TOO_SPARSE"
  | "UNSTABLE"
  | "FAILED"
  | "NO_EDGE";

export type StrategyFamily = "trend_pullback" | "mean_reversion" | "breakout_momentum";

export function classifyStrategyFamily(strategyId: string): StrategyFamily {
  if (strategyId.includes("bollinger") || strategyId.includes("reversion")) return "mean_reversion";
  if (strategyId.includes("breakout") || strategyId.includes("squeeze")) return "breakout_momentum";
  return "trend_pullback";
}

export function sampleSizeFlag(trades: number): SampleSizeFlag {
  if (trades < 20) return "VERY_LOW_SAMPLE";
  if (trades < 50) return "LOW_SAMPLE";
  return "INFORMATIVE";
}

export interface SplitMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  expectancyR: number;
  averageWinR: number | null;
  averageLossR: number | null;
  netR: number;
  netPnl: number;
  maxDrawdown: number | null;
  maxDrawdownPercent: number | null;
  longestLossStreak: number | null;
  averageBarsHeld: number | null;
  averageHoldingMs: number | null;
  buyTrades: number;
  sellTrades: number;
  buyExpectancyR: number | null;
  sellExpectancyR: number | null;
  buyWinRate: number | null;
  sellWinRate: number | null;
  byRegime: Record<string, { trades: number; winRate: number; expectancyR: number }>;
  sampleSize: SampleSizeFlag;
}

export function summarizeTrades(
  trades: ReadonlyArray<CfdSimulatedTrade>,
  summary?: CfdBacktestSummary | null
): SplitMetrics {
  const wins = trades.filter((t) => t.outcome === "WIN");
  const losses = trades.filter((t) => t.outcome === "LOSS");
  const n = trades.length;
  const netR = trades.reduce((a, t) => a + (t.netR ?? 0), 0);
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;

  const winRs = wins.map((t) => t.netR).filter((x): x is number => x != null);
  const lossRs = losses.map((t) => t.netR).filter((x): x is number => x != null);

  const buy = trades.filter((t) => t.action === "BUY");
  const sell = trades.filter((t) => t.action === "SELL");

  const byRegime = new Map<string, { n: number; netR: number; wins: number }>();
  for (const t of trades) {
    const cur = byRegime.get(t.regime) ?? { n: 0, netR: 0, wins: 0 };
    cur.n += 1;
    cur.netR += t.netR ?? 0;
    if (t.outcome === "WIN") cur.wins += 1;
    byRegime.set(t.regime, cur);
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n > 0 ? Number((wins.length / n).toFixed(4)) : 0,
    profitFactor: pf == null || !Number.isFinite(pf) ? pf : Number(pf.toFixed(4)),
    expectancyR: n > 0 ? Number((netR / n).toFixed(4)) : 0,
    averageWinR:
      winRs.length > 0
        ? Number((winRs.reduce((a, b) => a + b, 0) / winRs.length).toFixed(4))
        : null,
    averageLossR:
      lossRs.length > 0
        ? Number((lossRs.reduce((a, b) => a + b, 0) / lossRs.length).toFixed(4))
        : null,
    netR: Number(netR.toFixed(4)),
    netPnl: Number(netPnl.toFixed(4)),
    maxDrawdown: summary?.maxDrawdown ?? null,
    maxDrawdownPercent: summary?.maxDrawdownPercent ?? null,
    longestLossStreak: summary?.longestLossStreak ?? null,
    averageBarsHeld: summary?.averageBarsHeld ?? null,
    averageHoldingMs: summary?.averageHoldingMs ?? null,
    buyTrades: buy.length,
    sellTrades: sell.length,
    buyExpectancyR:
      buy.length > 0
        ? Number((buy.reduce((a, t) => a + (t.netR ?? 0), 0) / buy.length).toFixed(4))
        : null,
    sellExpectancyR:
      sell.length > 0
        ? Number((sell.reduce((a, t) => a + (t.netR ?? 0), 0) / sell.length).toFixed(4))
        : null,
    buyWinRate:
      buy.length > 0
        ? Number((buy.filter((t) => t.outcome === "WIN").length / buy.length).toFixed(4))
        : null,
    sellWinRate:
      sell.length > 0
        ? Number((sell.filter((t) => t.outcome === "WIN").length / sell.length).toFixed(4))
        : null,
    byRegime: Object.fromEntries(
      [...byRegime.entries()].map(([k, v]) => [
        k,
        {
          trades: v.n,
          winRate: Number((v.wins / v.n).toFixed(4)),
          expectancyR: Number((v.netR / v.n).toFixed(4))
        }
      ])
    ),
    sampleSize: sampleSizeFlag(n)
  };
}

export function costDragExpectancyR(zeroCostExpR: number, realisticExpR: number): number {
  return Number((zeroCostExpR - realisticExpR).toFixed(4));
}

export interface WalkForwardStability {
  windows: number;
  percentPositiveExpectancy: number;
  percentProfitFactorAboveOne: number;
  medianExpectancyR: number;
  worstExpectancyR: number;
  bestExpectancyR: number;
  totalOosTrades: number;
  singleWindowDominated: boolean;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function computeWalkForwardStability(
  windows: ReadonlyArray<{ expectancyR: number; profitFactor: number | null; trades: number; netR: number }>
): WalkForwardStability {
  const withTrades = windows.filter((w) => w.trades > 0);
  const exps = withTrades.map((w) => w.expectancyR);
  const positive = withTrades.filter((w) => w.expectancyR > 0).length;
  const pfAbove = withTrades.filter(
    (w) => w.profitFactor != null && Number.isFinite(w.profitFactor) && w.profitFactor > 1
  ).length;
  const totalOosTrades = withTrades.reduce((a, w) => a + w.trades, 0);
  const absNets = withTrades.map((w) => Math.abs(w.netR));
  const maxAbs = absNets.length ? Math.max(...absNets) : 0;
  const sumAbs = absNets.reduce((a, b) => a + b, 0);
  const singleWindowDominated = sumAbs > 0 && maxAbs / sumAbs >= 0.55;

  return {
    windows: withTrades.length,
    percentPositiveExpectancy:
      withTrades.length > 0 ? Number((positive / withTrades.length).toFixed(4)) : 0,
    percentProfitFactorAboveOne:
      withTrades.length > 0 ? Number((pfAbove / withTrades.length).toFixed(4)) : 0,
    medianExpectancyR: Number(median(exps).toFixed(4)),
    worstExpectancyR: exps.length ? Number(Math.min(...exps).toFixed(4)) : 0,
    bestExpectancyR: exps.length ? Number(Math.max(...exps).toFixed(4)) : 0,
    totalOosTrades,
    singleWindowDominated
  };
}

export function classifyCostEdgeCase(input: {
  holdoutTradesRealistic: number;
  holdoutTradesZero: number;
  zeroCostHoldoutExpR: number;
  realisticHoldoutExpR: number;
}): CostEdgeCase {
  const n = Math.max(input.holdoutTradesRealistic, input.holdoutTradesZero);
  if (n < 20) return "TOO_SPARSE_INCONCLUSIVE";
  const z = input.zeroCostHoldoutExpR;
  const r = input.realisticHoldoutExpR;
  if (z > 0 && r > 0) return "PROMISING";
  if (z > 0 && r <= 0) return "RAW_EDGE_KILLED_BY_COSTS";
  return "NO_EDGE_EVEN_BEFORE_COSTS";
}

/**
 * Explicit qualitative verdict. Formula is transparent:
 * - sparse holdout → TOO_SPARSE
 * - zero-cost holdout ≤ 0 → NO_EDGE / FAILED
 * - zero+ / cost− → RAW_EDGE_BUT_COST_SENSITIVE
 * - both+ but unstable WF → UNSTABLE
 * - both+ and WF ≥50% positive windows → PROMISING_FOR_MORE_RESEARCH
 */
export function researchVerdict(input: {
  costCase: CostEdgeCase;
  wf: WalkForwardStability;
  holdoutTrades: number;
}): ResearchVerdict {
  if (input.costCase === "TOO_SPARSE_INCONCLUSIVE" || input.holdoutTrades < 20) {
    return "TOO_SPARSE";
  }
  if (input.costCase === "NO_EDGE_EVEN_BEFORE_COSTS") {
    return input.wf.medianExpectancyR > 0 ? "UNSTABLE" : "NO_EDGE";
  }
  if (input.costCase === "RAW_EDGE_KILLED_BY_COSTS") {
    return "RAW_EDGE_BUT_COST_SENSITIVE";
  }
  // PROMISING cost case
  if (input.wf.singleWindowDominated || input.wf.percentPositiveExpectancy < 0.5) {
    return "UNSTABLE";
  }
  if (input.wf.medianExpectancyR <= 0) return "FAILED";
  return "PROMISING_FOR_MORE_RESEARCH";
}
