import { type CfdBacktestSummary } from "../backtest/cfdMetrics.js";

export interface CfdWindowMetricSnapshot {
  windowIndex: number;
  expectancyR: number;
  netProfit: number;
  netRSum: number;
  trades: number;
  profitFactor: number | null;
  maxDrawdownPercent: number;
  endingBalance: number;
}

/**
 * Aggregate OOS metrics across validation windows.
 * Deliberately exposes distributional stats — not just averages —
 * so one huge winning window cannot hide multiple losers.
 */
export interface CfdWalkForwardAggregate {
  windowCount: number;
  totalValidationTrades: number;
  combinedNetProfit: number;
  combinedNetR: number;
  /** Trade-count weighted expectancyR. */
  weightedExpectancyR: number;
  medianExpectancyR: number;
  meanExpectancyR: number;
  profitFactor: number | null;
  maxDrawdownPercent: number;
  percentProfitableWindows: number;
  percentPositiveExpectancyWindows: number;
  bestWindow: CfdWindowMetricSnapshot | null;
  worstWindow: CfdWindowMetricSnapshot | null;
  /** Std-dev of per-window expectancyR (0 if <2 windows). */
  expectancyRVariability: number;
  /** Fraction of windows with train→validation expectancy degradation > 50%. */
  severeDegradationWindowFraction: number;
  windowExpectancyRs: number[];
}

export function aggregateCfdWalkForwardWindows(
  windows: ReadonlyArray<{
    windowIndex: number;
    validation: CfdBacktestSummary;
    train?: CfdBacktestSummary | null;
    /** Sum of netR across validation trades when available. */
    validationNetRSum?: number;
  }>
): CfdWalkForwardAggregate {
  if (windows.length === 0) {
    return {
      windowCount: 0,
      totalValidationTrades: 0,
      combinedNetProfit: 0,
      combinedNetR: 0,
      weightedExpectancyR: 0,
      medianExpectancyR: 0,
      meanExpectancyR: 0,
      profitFactor: null,
      maxDrawdownPercent: 0,
      percentProfitableWindows: 0,
      percentPositiveExpectancyWindows: 0,
      bestWindow: null,
      worstWindow: null,
      expectancyRVariability: 0,
      severeDegradationWindowFraction: 0,
      windowExpectancyRs: []
    };
  }

  const snaps: CfdWindowMetricSnapshot[] = windows.map((w) => {
    const netRSum =
      w.validationNetRSum ??
      w.validation.expectancyR * Math.max(w.validation.totalTrades, 0);
    return {
      windowIndex: w.windowIndex,
      expectancyR: w.validation.expectancyR,
      netProfit: w.validation.netProfit,
      netRSum,
      trades: w.validation.totalTrades,
      profitFactor: w.validation.profitFactor,
      maxDrawdownPercent: w.validation.maxDrawdownPercent,
      endingBalance: w.validation.endingBalance
    };
  });

  const totalTrades = snaps.reduce((a, s) => a + s.trades, 0);
  const combinedNetProfit = snaps.reduce((a, s) => a + s.netProfit, 0);
  const combinedNetR = snaps.reduce((a, s) => a + s.netRSum, 0);
  const weightedExpectancyR =
    totalTrades > 0
      ? snaps.reduce((a, s) => a + s.expectancyR * s.trades, 0) / totalTrades
      : 0;

  const ers = snaps.map((s) => s.expectancyR).sort((a, b) => a - b);
  const medianExpectancyR =
    ers.length % 2 === 1
      ? ers[Math.floor(ers.length / 2)]!
      : (ers[ers.length / 2 - 1]! + ers[ers.length / 2]!) / 2;
  const meanExpectancyR = ers.reduce((a, b) => a + b, 0) / ers.length;

  let variance = 0;
  if (ers.length >= 2) {
    variance = ers.reduce((a, e) => a + (e - meanExpectancyR) ** 2, 0) / ers.length;
  }

  const grossProfit = windows.reduce((a, w) => a + w.validation.grossProfit, 0);
  const grossLoss = windows.reduce((a, w) => a + Math.abs(w.validation.grossLoss), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null;

  const profitable = snaps.filter((s) => s.netProfit > 0).length;
  const positiveEr = snaps.filter((s) => s.expectancyR > 0).length;

  let best = snaps[0]!;
  let worst = snaps[0]!;
  for (const s of snaps) {
    if (s.expectancyR > best.expectancyR) best = s;
    if (s.expectancyR < worst.expectancyR) worst = s;
  }

  let severeDeg = 0;
  for (const w of windows) {
    if (!w.train || w.train.expectancyR <= 0) continue;
    if (w.validation.expectancyR < w.train.expectancyR * 0.5) severeDeg++;
  }

  return {
    windowCount: windows.length,
    totalValidationTrades: totalTrades,
    combinedNetProfit: Number(combinedNetProfit.toFixed(2)),
    combinedNetR: Number(combinedNetR.toFixed(4)),
    weightedExpectancyR: Number(weightedExpectancyR.toFixed(4)),
    medianExpectancyR: Number(medianExpectancyR.toFixed(4)),
    meanExpectancyR: Number(meanExpectancyR.toFixed(4)),
    profitFactor:
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : profitFactor,
    maxDrawdownPercent: Math.max(...snaps.map((s) => s.maxDrawdownPercent)),
    percentProfitableWindows: Number((profitable / snaps.length).toFixed(4)),
    percentPositiveExpectancyWindows: Number((positiveEr / snaps.length).toFixed(4)),
    bestWindow: best,
    worstWindow: worst,
    expectancyRVariability: Number(Math.sqrt(variance).toFixed(4)),
    severeDegradationWindowFraction: Number((severeDeg / snaps.length).toFixed(4)),
    windowExpectancyRs: ers.map((e) => Number(e.toFixed(4)))
  };
}

/**
 * Detect "one window dominates" — a single strong validation window while
 * the majority of windows are weak/negative (average would look healthier than reality).
 */
export function isSingleWindowDominated(agg: CfdWalkForwardAggregate, share = 0.7): boolean {
  if (agg.windowCount < 3 || !agg.bestWindow) return false;
  const majorityNegative = agg.percentPositiveExpectancyWindows < 0.5;
  if (!majorityNegative) return false;
  if (agg.bestWindow.expectancyR <= 0) return false;

  const positiveWindowCount = agg.windowExpectancyRs.filter((e) => e > 0).length;
  if (positiveWindowCount <= 1) return true;

  if (agg.combinedNetR > 0) {
    const bestShare = agg.bestWindow.netRSum / agg.combinedNetR;
    return bestShare >= share;
  }

  // Combined netR non-positive but one large positive outlier exists
  return (
    agg.bestWindow.expectancyR >= Math.abs(agg.medianExpectancyR) * 2 &&
    agg.bestWindow.expectancyR > 0
  );
}
