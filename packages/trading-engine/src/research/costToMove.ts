import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { applyExecutableFill, applyExitFill } from "../execution/cfdMath.js";

export interface CostToMoveTradeMetrics {
  atr: number | null;
  stopDistance: number;
  targetDistance: number;
  stopDistanceAtr: number | null;
  targetDistanceAtr: number | null;
  /** One-way adverse fill distance from mid (half-spread + slippage) in price. */
  oneWayCostPrice: number;
  /** Round-trip approximate (entry + exit) cost in price. */
  roundTripCostPrice: number;
  oneWayCostAtr: number | null;
  roundTripCostAtr: number | null;
  costAsPctOfStop: number | null;
  grossR: number | null;
  netR: number | null;
  costDragR: number | null;
}

export interface CostToMoveAggregate {
  trades: number;
  withAtr: number;
  medianCostAtr: number | null;
  medianRoundTripCostAtr: number | null;
  medianStopAtr: number | null;
  medianTargetAtr: number | null;
  medianCostDragR: number | null;
  medianCostAsPctOfStop: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Per-trade cost-to-move diagnostics from simulated trades + instrument costs.
 * Uses entryFeatures.atr when present; does not alter strategy behavior.
 *
 * entryPrice on CfdSimulatedTrade is the executable fill. Mid is recovered from
 * the known fill model so cost/ATR is consistent with research costs.
 */
export function midFromFillPrice(
  action: "BUY" | "SELL",
  fillPrice: number,
  spreadBps: number,
  slippageBps: number
): number {
  const frac = spreadBps / 20_000 + slippageBps / 10_000;
  if (frac <= 0) return fillPrice;
  return action === "BUY" ? fillPrice / (1 + frac) : fillPrice / (1 - frac);
}

export function computeTradeCostToMove(
  trade: CfdSimulatedTrade,
  spreadBps: number,
  slippageBps: number
): CostToMoveTradeMetrics {
  const atr = trade.entryFeatures?.atr ?? null;
  const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const targetDistance = Math.abs(trade.takeProfit - trade.entryPrice);
  const mid = midFromFillPrice(trade.action, trade.entryPrice, spreadBps, slippageBps);
  const entryFill = applyExecutableFill(trade.action, mid, spreadBps, slippageBps);
  const oneWayCostPrice = Math.abs(entryFill.fillPrice - mid);
  const exitFill = applyExitFill(trade.action, mid, spreadBps, slippageBps);
  const exitOneWay = Math.abs(exitFill.fillPrice - mid);
  const roundTripCostPrice = oneWayCostPrice + exitOneWay;

  const grossR = trade.grossR;
  const netR = trade.netR;
  const costDragR =
    grossR != null && netR != null ? Number((grossR - netR).toFixed(6)) : null;

  return {
    atr,
    stopDistance,
    targetDistance,
    stopDistanceAtr: atr != null && atr > 0 ? Number((stopDistance / atr).toFixed(6)) : null,
    targetDistanceAtr: atr != null && atr > 0 ? Number((targetDistance / atr).toFixed(6)) : null,
    oneWayCostPrice: Number(oneWayCostPrice.toFixed(8)),
    roundTripCostPrice: Number(roundTripCostPrice.toFixed(8)),
    oneWayCostAtr: atr != null && atr > 0 ? Number((oneWayCostPrice / atr).toFixed(6)) : null,
    roundTripCostAtr:
      atr != null && atr > 0 ? Number((roundTripCostPrice / atr).toFixed(6)) : null,
    costAsPctOfStop: stopDistance > 0 ? Number((roundTripCostPrice / stopDistance).toFixed(6)) : null,
    grossR,
    netR,
    costDragR
  };
}

export function aggregateCostToMove(
  rows: ReadonlyArray<CostToMoveTradeMetrics>
): CostToMoveAggregate {
  const withAtr = rows.filter((r) => r.atr != null && r.atr > 0);
  return {
    trades: rows.length,
    withAtr: withAtr.length,
    medianCostAtr: median(withAtr.map((r) => r.oneWayCostAtr!).filter((x) => x != null)),
    medianRoundTripCostAtr: median(
      withAtr.map((r) => r.roundTripCostAtr!).filter((x) => x != null)
    ),
    medianStopAtr: median(withAtr.map((r) => r.stopDistanceAtr!).filter((x) => x != null)),
    medianTargetAtr: median(withAtr.map((r) => r.targetDistanceAtr!).filter((x) => x != null)),
    medianCostDragR: median(
      rows.map((r) => r.costDragR).filter((x): x is number => x != null)
    ),
    medianCostAsPctOfStop: median(
      rows.map((r) => r.costAsPctOfStop).filter((x): x is number => x != null)
    )
  };
}

export interface CostSweepPoint {
  spreadBps: number;
  slippageBps: number;
  trades: number;
  expectancyR: number;
  profitFactor: number | null;
  netR: number;
}

/**
 * Find nearest tested cost level where expectancy crosses from + to − (or stays +).
 * Returns null if never positive in the sweep.
 */
export function estimateBreakEvenCost(points: ReadonlyArray<CostSweepPoint>): {
  maximumCostForPositiveExpectancy: { spreadBps: number; slippageBps: number } | null;
  crossedBetween: [CostSweepPoint, CostSweepPoint] | null;
  note: string;
} {
  const ordered = [...points].sort(
    (a, b) => a.spreadBps + a.slippageBps - (b.spreadBps + b.slippageBps)
  );
  let lastPositive: CostSweepPoint | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i]!;
    if (p.expectancyR > 0) {
      lastPositive = p;
      continue;
    }
    if (lastPositive) {
      return {
        maximumCostForPositiveExpectancy: {
          spreadBps: lastPositive.spreadBps,
          slippageBps: lastPositive.slippageBps
        },
        crossedBetween: [lastPositive, p],
        note: "Expectancy crossed from positive to non-positive between these tested cost levels"
      };
    }
  }
  if (lastPositive) {
    return {
      maximumCostForPositiveExpectancy: {
        spreadBps: lastPositive.spreadBps,
        slippageBps: lastPositive.slippageBps
      },
      crossedBetween: null,
      note: "Expectancy remained positive through highest tested cost level"
    };
  }
  return {
    maximumCostForPositiveExpectancy: null,
    crossedBetween: null,
    note: "No tested cost level produced positive expectancy"
  };
}
