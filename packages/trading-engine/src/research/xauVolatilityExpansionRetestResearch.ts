/**
 * Research runner for xau-volatility-expansion-retest-v1 (no enablement).
 */
import { type Candle } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import {
  XauVolatilityExpansionRetestStrategy,
  XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS,
  XAU_VOLATILITY_EXPANSION_RETEST_SENSITIVITY_RANGES,
  type XauVolatilityExpansionRetestParams
} from "../strategies/xauVolatilityExpansionRetest.js";
import {
  SqueezeBreakoutStrategy,
  SQUEEZE_BREAKOUT_DEFAULTS
} from "../strategies/squeezeBreakout.js";
import {
  BreakoutMomentumStrategy,
  BREAKOUT_MOMENTUM_DEFAULTS
} from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import {
  XauMtfStructureMomentumStrategy,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS
} from "../strategies/xauMtfStructureMomentum.js";
import { completedHtfBarsAsOf } from "../strategies/mtfResampleAsOf.js";
import {
  countVolatilityFunnel,
  type VolatilityStateParams
} from "../strategies/volatilityExpansionState.js";
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
  type XauUsdWeeklySegment,
  xauUsdResearchInstrument
} from "./xauUsdWeeklyRobustness.js";
import { detectSensitivityCollapse } from "./xauMtfStructureMomentumResearch.js";

export type XauVolExpansionResearchClass =
  | "PROMISING_FOR_FORWARD_DEMO_RESEARCH"
  | "NO_EDGE"
  | "UNSTABLE"
  | "TOO_SPARSE"
  | "COST_SENSITIVE"
  | "OVERFIT"
  | "DATA_QUALITY_BLOCKED";

function toStateParams(p: Partial<XauVolatilityExpansionRetestParams>): VolatilityStateParams {
  const d = { ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS, ...p };
  return {
    compressionLookback: d.compressionLookback,
    maxNormalizedRange: d.maxNormalizedRange,
    minCompressionBars: d.minCompressionBars,
    minExpansionRangeAtr: d.minExpansionRangeAtr,
    minBreakoutBodyAtr: d.minBreakoutBodyAtr,
    minCloseLocation: d.minCloseLocation,
    retestZoneWidthAtr: d.retestZoneWidthAtr,
    maxRetestDelayBars: d.maxRetestDelayBars,
    maxChaseExtensionAtr: d.maxChaseExtensionAtr,
    minAcceptanceCloseBeyondAtr: d.minAcceptanceCloseBeyondAtr,
    exhaustionExtensionAtr: d.exhaustionExtensionAtr
  };
}

export async function runVolExpansionOnCandles(
  candles: ReadonlyArray<Candle>,
  params: Partial<XauVolatilityExpansionRetestParams>,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const strategy = new XauVolatilityExpansionRetestStrategy();
  const parameters = strategy.validateParameters({
    ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS,
    ...params
  });
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: params.executionTimeframe === "1m" ? 90 : 60,
    contextWindowSize: 1200,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy, parameters }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

export async function runVolExpansionBaseline(
  candles: ReadonlyArray<Candle>,
  strategyId:
    | "squeeze-breakout-v1"
    | "breakout-momentum-v1"
    | "ema-pullback-v1"
    | "xau-mtf-structure-momentum-v1",
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  let strategy;
  let parameters: Record<string, number | boolean | string>;
  if (strategyId === "squeeze-breakout-v1") {
    strategy = new SqueezeBreakoutStrategy();
    parameters = { ...SQUEEZE_BREAKOUT_DEFAULTS };
  } else if (strategyId === "breakout-momentum-v1") {
    strategy = new BreakoutMomentumStrategy();
    parameters = { ...BREAKOUT_MOMENTUM_DEFAULTS };
  } else if (strategyId === "ema-pullback-v1") {
    strategy = new EmaPullbackStrategy();
    parameters = { ...EMA_PULLBACK_DEFAULTS };
  } else {
    strategy = new XauMtfStructureMomentumStrategy();
    parameters = { ...XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS };
  }
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: 60,
    contextWindowSize: strategyId.startsWith("xau-") ? 1200 : 200,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy, parameters }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

export async function runWeeklyVolExpansionMatrix(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  params: Partial<XauVolatilityExpansionRetestParams>,
  profiles: ReadonlyArray<XauUsdCostProfile>,
  strategyKey = "xau-volatility-expansion-retest-v1"
): Promise<WeeklyStrategyResult[]> {
  const out: WeeklyStrategyResult[] = [];
  for (const week of weeks.filter((w) => w.usable)) {
    for (const profile of profiles) {
      const { metrics } = await runVolExpansionOnCandles(
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

export async function runWeeksPooledVolExpansion(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  params: Partial<XauVolatilityExpansionRetestParams>,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const all: CfdSimulatedTrade[] = [];
  for (const w of weeks) {
    const { trades } = await runVolExpansionOnCandles(w.candles, params, spreadBps, slippageBps);
    all.push(...trades);
  }
  return { metrics: summarizeTrades(all), trades: all };
}

export function funnelAcrossWeeks(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  params: Partial<XauVolatilityExpansionRetestParams>
) {
  const stateParams = toStateParams(params);
  const total = {
    compressionDetected: 0,
    expansionDetected: 0,
    retestObserved: 0,
    accepted: 0,
    failed: 0,
    exhausted: 0,
    expired: 0
  };
  for (const w of weeks.filter((x) => x.usable)) {
    const five = completedHtfBarsAsOf(w.candles, w.candles.length - 1, "5m");
    const f = countVolatilityFunnel(five, stateParams);
    total.compressionDetected += f.compressionDetected;
    total.expansionDetected += f.expansionDetected;
    total.retestObserved += f.retestObserved;
    total.accepted += f.accepted;
    total.failed += f.failed;
    total.exhausted += f.exhausted;
    total.expired += f.expired;
  }
  return total;
}

export function classifyVolExpansionResearch(input: {
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
}): { classification: XauVolExpansionResearchClass; reasons: string[] } {
  const reasons: string[] = [];
  const trades = input.pooledObserved.totalTrades;
  const adequate = trades >= 50 || input.holdoutTrades >= 50;

  if (input.sensitivityCollapse) {
    return { classification: "OVERFIT", reasons: ["Neighboring params collapse"] };
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
    return { classification: "NO_EDGE", reasons: ["Observed-spread pooled expectancy ≤ 0"] };
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
    return { classification: "UNSTABLE", reasons: ["Single week dominates"] };
  }
  return {
    classification: "UNSTABLE",
    reasons: reasons.length ? reasons : ["Did not clear PROMISING gates"]
  };
}

export async function runVolExpansionSensitivity(
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
  const ranges = XAU_VOLATILITY_EXPANSION_RETEST_SENSITIVITY_RANGES;

  for (const v of ranges.executionTimeframe) {
    const r = await runWeeksPooledVolExpansion(
      developmentWeeks,
      { executionTimeframe: v },
      observedSpreadBps,
      0
    );
    out.push({
      dimension: "executionTimeframe",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  for (const v of ranges.minExpansionRangeAtr) {
    const r = await runWeeksPooledVolExpansion(
      developmentWeeks,
      { executionTimeframe: "5m", minExpansionRangeAtr: v },
      observedSpreadBps,
      0
    );
    out.push({
      dimension: "minExpansionRangeAtr",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  for (const v of ranges.retestZoneWidthAtr) {
    const r = await runWeeksPooledVolExpansion(
      developmentWeeks,
      { executionTimeframe: "5m", retestZoneWidthAtr: v },
      observedSpreadBps,
      0
    );
    out.push({
      dimension: "retestZoneWidthAtr",
      value: v,
      trades: r.metrics.trades,
      expectancyR: r.metrics.expectancyR,
      profitFactor: r.metrics.profitFactor
    });
  }
  // maxRetestDelayBars left for unit/default; omit from default sensitivity to keep grid small
  return out;
}

export function htf15ContextBreakdown(
  trades: ReadonlyArray<CfdSimulatedTrade>
): Array<{ context: string; trades: number; expectancyR: number }> {
  const map = new Map<string, { n: number; netR: number }>();
  for (const t of trades) {
    const line = t.entryReason.find((r) => r.startsWith("VOL "));
    const ctx = line?.includes("BUY")
      ? "BREAKOUT_BUY"
      : line?.includes("SELL")
        ? "BREAKOUT_SELL"
        : "UNKNOWN";
    const cur = map.get(ctx) ?? { n: 0, netR: 0 };
    cur.n++;
    cur.netR += t.netR ?? 0;
    map.set(ctx, cur);
  }
  return [...map.entries()].map(([context, v]) => ({
    context,
    trades: v.n,
    expectancyR: v.n > 0 ? v.netR / v.n : 0
  }));
}

export {
  aggregateWeeklyResults,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  detectSensitivityCollapse,
  hourOfDayBreakdown,
  inventoryXauUsdWeeklySegments,
  sessionBucketBreakdown,
  weekDominanceShare,
  XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS
};
