/**
 * Research runner for xau-mtf-structure-momentum-v1 (no enablement).
 */
import { type Candle } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import {
  XauMtfStructureMomentumStrategy,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS,
  XAU_MTF_STRUCTURE_MOMENTUM_SENSITIVITY_RANGES,
  type XauMtfStructureMomentumParams
} from "../strategies/xauMtfStructureMomentum.js";
import {
  SqueezeBreakoutStrategy,
  SQUEEZE_BREAKOUT_DEFAULTS
} from "../strategies/squeezeBreakout.js";
import {
  BreakoutMomentumStrategy,
  BREAKOUT_MOMENTUM_DEFAULTS
} from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { summarizeTrades, type SplitMetrics } from "./benchmarkMetrics.js";
import {
  aggregateWeeklyResults,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  hourOfDayBreakdown,
  inventoryXauUsdWeeklySegments,
  sessionBucketBreakdown,
  weekDominanceShare,
  type PooledWeekAggregate,
  type WeeklyStrategyResult,
  type XauUsdCostProfile,
  type XauUsdCostProfileId,
  type XauUsdWeeklySegment,
  xauUsdResearchInstrument
} from "./xauUsdWeeklyRobustness.js";

export type XauMtfResearchClass =
  | "PROMISING_FOR_FORWARD_DEMO_RESEARCH"
  | "NO_EDGE"
  | "UNSTABLE"
  | "TOO_SPARSE"
  | "COST_SENSITIVE"
  | "OVERFIT"
  | "DATA_QUALITY_BLOCKED";

export async function runXauMtfOnCandles(
  candles: ReadonlyArray<Candle>,
  params: Partial<XauMtfStructureMomentumParams>,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const strategy = new XauMtfStructureMomentumStrategy();
  const parameters = strategy.validateParameters({
    ...XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS,
    ...params
  });
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: params.executionTimeframe === "1m" ? 90 : 60,
    /** Must cover strategy.minimumHistory so MTF context fits in the window. */
    contextWindowSize: 1200,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy, parameters }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

export async function runBaselineOnCandles(
  candles: ReadonlyArray<Candle>,
  strategyId: "squeeze-breakout-v1" | "breakout-momentum-v1" | "ema-pullback-v1",
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const strategy =
    strategyId === "squeeze-breakout-v1"
      ? new SqueezeBreakoutStrategy()
      : strategyId === "breakout-momentum-v1"
        ? new BreakoutMomentumStrategy()
        : new EmaPullbackStrategy();
  const parameters =
    strategyId === "squeeze-breakout-v1"
      ? { ...SQUEEZE_BREAKOUT_DEFAULTS }
      : strategyId === "breakout-momentum-v1"
        ? { ...BREAKOUT_MOMENTUM_DEFAULTS }
        : { ...EMA_PULLBACK_DEFAULTS };
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: 60,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy, parameters }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

export async function runWeeklyXauMtfMatrix(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  params: Partial<XauMtfStructureMomentumParams>,
  profiles: ReadonlyArray<XauUsdCostProfile>,
  strategyKey = "xau-mtf-structure-momentum-v1"
): Promise<WeeklyStrategyResult[]> {
  const usable = weeks.filter((w) => w.usable);
  const out: WeeklyStrategyResult[] = [];
  for (const week of usable) {
    for (const profile of profiles) {
      const { metrics } = await runXauMtfOnCandles(
        week.candles,
        params,
        profile.spreadBps,
        profile.slippageBps
      );
      out.push({
        segmentId: week.segmentId,
        weekStartIso: week.weekStartIso,
        strategyId: strategyKey,
        costProfileId: profile.id,
        metrics
      });
    }
  }
  return out;
}

export async function runWeeksPooledXauMtf(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  params: Partial<XauMtfStructureMomentumParams>,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const all: CfdSimulatedTrade[] = [];
  for (const w of weeks) {
    const { trades } = await runXauMtfOnCandles(w.candles, params, spreadBps, slippageBps);
    all.push(...trades);
  }
  return { metrics: summarizeTrades(all), trades: all };
}

export function classifyXauMtfResearch(input: {
  pooledObserved: PooledWeekAggregate;
  zeroExpectancyR: number;
  holdoutTrades: number;
  holdoutExpectancyR: number;
  holdoutProfitFactor: number | null;
  positiveWeekPct: number;
  wfPositivePct: number;
  survivesAssumedSlip025: boolean;
  singleWeekDominates: boolean;
  sensitivityCollapse: boolean;
}): { classification: XauMtfResearchClass; reasons: string[] } {
  const reasons: string[] = [];
  const trades = input.pooledObserved.totalTrades;
  const adequate = trades >= 50 || input.holdoutTrades >= 50;

  if (input.sensitivityCollapse) {
    return { classification: "OVERFIT", reasons: ["Neighboring params collapse — overfitting risk"] };
  }
  if (!adequate && trades < 20 && input.holdoutTrades < 20) {
    return {
      classification: "TOO_SPARSE",
      reasons: [`Sparse sample pooled=${trades} holdout=${input.holdoutTrades}`]
    };
  }
  if (input.zeroExpectancyR > 0 && input.pooledObserved.expectancyR <= 0 && adequate) {
    return {
      classification: "COST_SENSITIVE",
      reasons: ["Zero-cost positive; observed/assumed costs kill edge"]
    };
  }
  if (input.pooledObserved.expectancyR <= 0 && adequate) {
    return {
      classification: "NO_EDGE",
      reasons: ["Observed-spread pooled expectancy ≤ 0"]
    };
  }
  if (
    input.pooledObserved.expectancyR > 0 &&
    (input.pooledObserved.profitFactor ?? 0) > 1 &&
    input.holdoutExpectancyR > 0 &&
    (input.holdoutProfitFactor ?? 0) > 1 &&
    input.positiveWeekPct >= 0.45 &&
    input.pooledObserved.positiveWeekCount >= 2 &&
    input.wfPositivePct >= 0.4 &&
    input.survivesAssumedSlip025 &&
    !input.singleWeekDominates &&
    adequate
  ) {
    if (input.holdoutTrades < 50) reasons.push("Holdout <50 trades (preferred ≥50)");
    return {
      classification: "PROMISING_FOR_FORWARD_DEMO_RESEARCH",
      reasons: [...reasons, "Cleared promotion bar (research only — no auto DEMO)"]
    };
  }
  if (input.pooledObserved.expectancyR > 0 && (input.positiveWeekPct < 0.4 || input.wfPositivePct < 0.35)) {
    return { classification: "UNSTABLE", reasons: ["Pooled positive but week/WF unstable"] };
  }
  if (!adequate) {
    return {
      classification: "TOO_SPARSE",
      reasons: [`Sample sparse pooled=${trades} holdout=${input.holdoutTrades}`]
    };
  }
  if (!input.survivesAssumedSlip025 && input.pooledObserved.expectancyR > 0) {
    return { classification: "COST_SENSITIVE", reasons: ["Fails ASSUMED_SLIP_0_25"] };
  }
  if (input.singleWeekDominates) {
    return { classification: "UNSTABLE", reasons: ["Single week dominates positive netR"] };
  }
  return {
    classification: "UNSTABLE",
    reasons: reasons.length ? reasons : ["Did not clear PROMISING gates"]
  };
}

/** Small development sensitivity: vary one dimension at a time from defaults. */
export async function runOneAtATimeSensitivity(
  developmentWeeks: ReadonlyArray<XauUsdWeeklySegment>,
  observedSpreadBps: number
): Promise<
  Array<{
    dimension: string;
    value: string | number;
    trades: number;
    expectancyR: number;
    profitFactor: number | null;
  }>
> {
  const out: Array<{
    dimension: string;
    value: string | number;
    trades: number;
    expectancyR: number;
    profitFactor: number | null;
  }> = [];
  const ranges = XAU_MTF_STRUCTURE_MOMENTUM_SENSITIVITY_RANGES;

  for (const v of ranges.executionTimeframe) {
    const r = await runWeeksPooledXauMtf(developmentWeeks, { executionTimeframe: v }, observedSpreadBps, 0);
    out.push({
      dimension: "executionTimeframe",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  for (const v of ranges.minPullbackDepthAtr) {
    const r = await runWeeksPooledXauMtf(
      developmentWeeks,
      { executionTimeframe: "5m", minPullbackDepthAtr: v },
      observedSpreadBps,
      0
    );
    out.push({
      dimension: "minPullbackDepthAtr",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  for (const v of ranges.maxImpulseDistanceAtr) {
    const r = await runWeeksPooledXauMtf(
      developmentWeeks,
      { executionTimeframe: "5m", maxImpulseDistanceAtr: v },
      observedSpreadBps,
      0
    );
    out.push({
      dimension: "maxImpulseDistanceAtr",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  for (const v of ranges.minEntryQualityScore) {
    const r = await runWeeksPooledXauMtf(
      developmentWeeks,
      { executionTimeframe: "5m", minEntryQualityScore: v },
      observedSpreadBps,
      0
    );
    out.push({
      dimension: "minEntryQualityScore",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  return out;
}

/** Flag overfitting when neighboring values flip sign with large magnitude swing. */
export function detectSensitivityCollapse(
  rows: ReadonlyArray<{ dimension: string; value: string | number; expectancyR: number; trades: number }>
): boolean {
  const byDim = new Map<
    string,
    Array<{ dimension: string; value: string | number; expectancyR: number; trades: number }>
  >();
  for (const r of rows) {
    const list = byDim.get(r.dimension) ?? [];
    list.push(r);
    byDim.set(r.dimension, list);
  }
  for (const [, list] of byDim) {
    const numeric = list.filter((r) => typeof r.value === "number" && r.trades >= 10);
    for (let i = 1; i < numeric.length; i++) {
      const a = numeric[i - 1]!;
      const b = numeric[i]!;
      if (a.expectancyR > 0.05 && b.expectancyR < -0.05) return true;
      if (a.expectancyR < -0.05 && b.expectancyR > 0.05) return true;
    }
  }
  return false;
}

export function structureStateBreakdown(
  trades: ReadonlyArray<CfdSimulatedTrade>
): Array<{ state: string; trades: number; expectancyR: number }> {
  const map = new Map<string, { n: number; netR: number }>();
  for (const t of trades) {
    const htfLine = t.entryReason.find((r) => r.startsWith("HTF "));
    const state = htfLine?.split(/\s+/)[1] ?? "UNKNOWN";
    const cur = map.get(state) ?? { n: 0, netR: 0 };
    cur.n++;
    cur.netR += t.netR ?? 0;
    map.set(state, cur);
  }
  return [...map.entries()].map(([state, v]) => ({
    state,
    trades: v.n,
    expectancyR: v.n > 0 ? v.netR / v.n : 0
  }));
}

export {
  aggregateWeeklyResults,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  hourOfDayBreakdown,
  inventoryXauUsdWeeklySegments,
  sessionBucketBreakdown,
  weekDominanceShare,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS
};
