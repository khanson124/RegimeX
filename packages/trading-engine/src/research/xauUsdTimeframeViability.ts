/**
 * XAUUSD timeframe viability research (1m / 5m / research-only 15m).
 * No strategy mutation, no production interval changes, no enablement.
 */
import { type Candle } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { extractFeatures } from "../features/featureExtractor.js";
import { listBenchmarkStrategies } from "./crossStrategyBenchmark.js";
import {
  aggregateContiguousResearchCandles
} from "./candleResample.js";
import {
  aggregateCostToMove,
  computeTradeCostToMove
} from "./costToMove.js";
import {
  sampleSizeFlag,
  summarizeTrades,
  type SplitMetrics
} from "./benchmarkMetrics.js";
import {
  type ResearchCandleInterval,
  researchIntervalMs,
  assertProductionIntervalsUnchanged
} from "./researchCandleInterval.js";
import {
  aggregateWeeklyResults,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  hourOfDayBreakdown,
  inventoryXauUsdWeeklySegments,
  sessionBucketBreakdown,
  type PooledWeekAggregate,
  type WeeklyStrategyResult,
  type XauUsdCostProfile,
  type XauUsdCostProfileId,
  type XauUsdWeeklySegment,
  xauUsdResearchInstrument
} from "./xauUsdWeeklyRobustness.js";

export type TimeframeViabilityClass =
  | "PROMISING_FOR_DEEPER_RESEARCH"
  | "RAW_EDGE_COST_SENSITIVE"
  | "NO_EDGE"
  | "TOO_SPARSE"
  | "UNSTABLE";

const MIN_ADEQUATE_TRADES = 50;
const MIN_HOLDOUT_IDEAL = 50;

export function candlesForResearchTimeframe(
  source1m: ReadonlyArray<Candle>,
  timeframe: ResearchCandleInterval
): Candle[] {
  if (timeframe === "1m") return [...source1m];
  return aggregateContiguousResearchCandles(source1m, timeframe).validBars;
}

async function runStrategyOnCandles(
  candles: ReadonlyArray<Candle>,
  strategyId: string,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const spec = listBenchmarkStrategies([strategyId])[0];
  if (!spec) throw new Error(`Unknown strategy ${strategyId}`);
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: 60,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy: spec.strategy, parameters: { ...spec.parameters } }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

export async function runWeeklyStrategyMatrixOnTimeframe(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  timeframe: ResearchCandleInterval,
  strategyIds: ReadonlyArray<string>,
  profiles: ReadonlyArray<XauUsdCostProfile>
): Promise<WeeklyStrategyResult[]> {
  const usable = weeks.filter((w) => w.usable);
  const out: WeeklyStrategyResult[] = [];
  for (const week of usable) {
    const tfCandles = candlesForResearchTimeframe(week.candles, timeframe);
    for (const strategyId of strategyIds) {
      for (const profile of profiles) {
        const { metrics } = await runStrategyOnCandles(
          tfCandles,
          strategyId,
          profile.spreadBps,
          profile.slippageBps
        );
        out.push({
          segmentId: week.segmentId,
          weekStartIso: week.weekStartIso,
          strategyId,
          costProfileId: profile.id,
          metrics
        });
      }
    }
  }
  return out;
}

export async function runWeeksPooledOnTimeframe(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  timeframe: ResearchCandleInterval,
  strategyId: string,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const allTrades: CfdSimulatedTrade[] = [];
  for (const w of weeks) {
    const tfCandles = candlesForResearchTimeframe(w.candles, timeframe);
    const { trades } = await runStrategyOnCandles(tfCandles, strategyId, spreadBps, slippageBps);
    allTrades.push(...trades);
  }
  return { metrics: summarizeTrades(allTrades), trades: allTrades };
}

export interface CostToMoveTimeframeSummary {
  timeframe: ResearchCandleInterval;
  usableBars: number;
  medianAtr: number | null;
  /** One-way half-spread in price at reference mid (median close). */
  oneWaySpreadPrice: number | null;
  spreadOverAtr: number | null;
  medianStopOverAtr: number | null;
  medianTargetOverAtr: number | null;
  medianSpreadAsPctOfStop: number | null;
  medianCostDragR: number | null;
  averageBarsHeld: number | null;
  averageHoldingMs: number | null;
  tradesUsed: number;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** Dataset-level ATR + trade-level cost-to-move for a timeframe. */
export function summarizeCostToMoveForTimeframe(input: {
  timeframe: ResearchCandleInterval;
  candles: ReadonlyArray<Candle>;
  trades: ReadonlyArray<CfdSimulatedTrade>;
  observedSpreadBps: number;
}): CostToMoveTimeframeSummary {
  const features = extractFeatures([...input.candles]);
  const atrs = features.map((f) => f.atr).filter((a): a is number => a != null && a > 0);
  const medianAtr = median(atrs);
  const mid = median(input.candles.map((c) => c.close)) ?? null;
  const oneWaySpreadPrice =
    mid != null && mid > 0 ? (mid * input.observedSpreadBps) / 20_000 : null;
  const spreadOverAtr =
    oneWaySpreadPrice != null && medianAtr != null && medianAtr > 0
      ? oneWaySpreadPrice / medianAtr
      : null;

  const tradeRows = input.trades.map((t) =>
    computeTradeCostToMove(t, input.observedSpreadBps, 0)
  );
  const agg = aggregateCostToMove(tradeRows);
  const metrics = summarizeTrades(input.trades);
  const barsHeld = input.trades.map((t) => t.barsHeld).filter((n) => Number.isFinite(n));
  const holdingMs = input.trades
    .map((t) => (t.exitTime != null ? t.exitTime - t.entryTime : null))
    .filter((n): n is number => n != null && Number.isFinite(n));
  const barMs = researchIntervalMs(input.timeframe);

  return {
    timeframe: input.timeframe,
    usableBars: input.candles.length,
    medianAtr,
    oneWaySpreadPrice,
    spreadOverAtr,
    medianStopOverAtr: agg.medianStopAtr,
    medianTargetOverAtr: agg.medianTargetAtr,
    medianSpreadAsPctOfStop: agg.medianCostAsPctOfStop,
    medianCostDragR: agg.medianCostDragR,
    averageBarsHeld:
      barsHeld.length > 0
        ? barsHeld.reduce((a, b) => a + b, 0) / barsHeld.length
        : metrics.averageBarsHeld,
    averageHoldingMs:
      holdingMs.length > 0
        ? holdingMs.reduce((a, b) => a + b, 0) / holdingMs.length
        : barsHeld.length > 0
          ? (barsHeld.reduce((a, b) => a + b, 0) / barsHeld.length) * barMs
          : metrics.averageHoldingMs,
    tradesUsed: input.trades.length
  };
}

export function classifyTimeframeViability(input: {
  pooledObserved: PooledWeekAggregate;
  zeroExpectancyR: number;
  holdoutTrades: number;
  holdoutExpectancyR: number;
  holdoutProfitFactor: number | null;
  positiveWeekPct: number;
  wfPositivePct: number;
  survivesAssumedSlip010: boolean;
}): { classification: TimeframeViabilityClass; reasons: string[] } {
  const reasons: string[] = [];
  const pooledTrades = input.pooledObserved.totalTrades;
  const adequate = pooledTrades >= MIN_ADEQUATE_TRADES || input.holdoutTrades >= MIN_HOLDOUT_IDEAL;

  if (!adequate && pooledTrades < 20 && input.holdoutTrades < 20) {
    return {
      classification: "TOO_SPARSE",
      reasons: [
        `Insufficient trades (pooled=${pooledTrades}, holdout=${input.holdoutTrades})`
      ]
    };
  }

  const observedExp = input.pooledObserved.expectancyR;
  const observedPf = input.pooledObserved.profitFactor ?? 0;
  const holdoutPf = input.holdoutProfitFactor ?? 0;

  if (input.zeroExpectancyR > 0 && observedExp <= 0 && adequate) {
    return {
      classification: "RAW_EDGE_COST_SENSITIVE",
      reasons: ["Zero-cost positive; observed/assumed spread kills edge"]
    };
  }

  if (observedExp <= 0 && adequate) {
    return {
      classification: "NO_EDGE",
      reasons: ["Observed-spread pooled expectancy ≤ 0 with adequate sample"]
    };
  }

  if (
    input.holdoutExpectancyR > 0 &&
    holdoutPf > 1 &&
    observedExp > 0 &&
    observedPf > 1 &&
    input.positiveWeekPct >= 0.4 &&
    input.pooledObserved.positiveWeekCount >= 2 &&
    input.wfPositivePct >= 0.4 &&
    input.survivesAssumedSlip010 &&
    adequate
  ) {
    if (input.holdoutTrades < MIN_HOLDOUT_IDEAL) {
      reasons.push(`Holdout trades ${input.holdoutTrades} < ${MIN_HOLDOUT_IDEAL} ideal`);
    }
    return {
      classification: "PROMISING_FOR_DEEPER_RESEARCH",
      reasons: [
        ...reasons,
        "Holdout+ observed-spread positive, PF>1, multi-week support, modest assumed slip survived"
      ]
    };
  }

  if (observedExp > 0 && (input.positiveWeekPct < 0.4 || input.wfPositivePct < 0.35)) {
    return {
      classification: "UNSTABLE",
      reasons: ["Pooled positive but week/WF stability poor"]
    };
  }

  if (!adequate) {
    return {
      classification: "TOO_SPARSE",
      reasons: [`Sample still sparse (pooled=${pooledTrades}, holdout=${input.holdoutTrades})`]
    };
  }

  return {
    classification: "UNSTABLE",
    reasons: reasons.length ? reasons : ["Did not meet PROMISING_FOR_DEEPER_RESEARCH gates"]
  };
}

export interface CrossTimeframeComparisonRow {
  strategyId: string;
  timeframe: ResearchCandleInterval;
  trades: number;
  observedExpectancyR: number;
  observedProfitFactor: number | null;
  holdoutExpectancyR: number;
  holdoutProfitFactor: number | null;
  holdoutTrades: number;
  positiveWeekPct: number;
  wfPositivePct: number;
  medianSpreadOverAtr: number | null;
  classification: TimeframeViabilityClass;
  buyExpectancyR: number | null;
  sellExpectancyR: number | null;
}

export interface StrategyTimeframeBundle {
  strategyId: string;
  timeframe: ResearchCandleInterval;
  weeklyObserved: WeeklyStrategyResult[];
  pooled: Record<XauUsdCostProfileId, PooledWeekAggregate>;
  holdout: SplitMetrics;
  development: SplitMetrics;
  wfPositivePct: number;
  classification: TimeframeViabilityClass;
  classificationReasons: string[];
  buySell: {
    buyTrades: number;
    sellTrades: number;
    buyExpectancyR: number | null;
    sellExpectancyR: number | null;
  };
  sessions: ReturnType<typeof sessionBucketBreakdown>;
  hours: ReturnType<typeof hourOfDayBreakdown>;
  costSensitivity: Array<{
    profileId: XauUsdCostProfileId;
    expectancyR: number;
    profitFactor: number | null;
    totalTrades: number;
    positiveWeekPct: number;
  }>;
}

export async function evaluateStrategyTimeframe(input: {
  weeks: ReadonlyArray<XauUsdWeeklySegment>;
  timeframe: ResearchCandleInterval;
  strategyId: string;
  profiles: ReadonlyArray<XauUsdCostProfile>;
  weeklyRows: ReadonlyArray<WeeklyStrategyResult>;
  observedSpreadBps: number;
}): Promise<StrategyTimeframeBundle> {
  const observedId: XauUsdCostProfileId = "OBSERVED_SPREAD_ONLY";
  const weeklyObserved = input.weeklyRows.filter(
    (r) => r.strategyId === input.strategyId && r.costProfileId === observedId
  );
  const pooled: Record<string, PooledWeekAggregate> = {};
  for (const p of input.profiles) {
    pooled[p.id] = aggregateWeeklyResults(input.weeklyRows, input.strategyId, p.id);
  }
  const pooledObserved = pooled[observedId]!;
  const pooledZero = pooled.ZERO!;

  const chrono = chronologicalWeekSplit(input.weeks, 0.3);
  const [dev, hold] = await Promise.all([
    runWeeksPooledOnTimeframe(
      chrono.developmentWeeks,
      input.timeframe,
      input.strategyId,
      input.observedSpreadBps,
      0
    ),
    runWeeksPooledOnTimeframe(
      chrono.holdoutWeeks,
      input.timeframe,
      input.strategyId,
      input.observedSpreadBps,
      0
    )
  ]);

  const wfWeeks = weeklyObserved.filter((r) =>
    chrono.developmentWeeks.some((w) => w.segmentId === r.segmentId)
  );
  const wfPositivePct =
    wfWeeks.length > 0
      ? wfWeeks.filter((w) => w.metrics.expectancyR > 0 && w.metrics.trades > 0).length /
        wfWeeks.length
      : 0;

  const slip010 = pooled.ASSUMED_SLIP_0_10?.expectancyR ?? -1;
  const cls = classifyTimeframeViability({
    pooledObserved,
    zeroExpectancyR: pooledZero.expectancyR,
    holdoutTrades: hold.metrics.trades,
    holdoutExpectancyR: hold.metrics.expectancyR,
    holdoutProfitFactor: hold.metrics.profitFactor,
    positiveWeekPct: pooledObserved.positiveWeekPct,
    wfPositivePct,
    survivesAssumedSlip010: slip010 > 0
  });

  return {
    strategyId: input.strategyId,
    timeframe: input.timeframe,
    weeklyObserved,
    pooled: pooled as Record<XauUsdCostProfileId, PooledWeekAggregate>,
    holdout: hold.metrics,
    development: dev.metrics,
    wfPositivePct,
    classification: cls.classification,
    classificationReasons: cls.reasons,
    buySell: {
      buyTrades: pooledObserved.buyTrades,
      sellTrades: pooledObserved.sellTrades,
      buyExpectancyR: pooledObserved.buyExpectancyR,
      sellExpectancyR: pooledObserved.sellExpectancyR
    },
    sessions: sessionBucketBreakdown(hold.trades.length ? hold.trades : dev.trades),
    hours: hourOfDayBreakdown(hold.trades.length ? hold.trades : dev.trades),
    costSensitivity: input.profiles.map((p) => {
      const a = pooled[p.id]!;
      return {
        profileId: p.id,
        expectancyR: a.expectancyR,
        profitFactor: a.profitFactor,
        totalTrades: a.totalTrades,
        positiveWeekPct: a.positiveWeekPct
      };
    })
  };
}

export interface TimeframeBarInventory {
  timeframe: ResearchCandleInterval;
  usableBars: number;
  intervalMs: number;
  researchOnly: boolean;
}

export function inventoryUsableBarsByTimeframe(
  usableWeeks: ReadonlyArray<XauUsdWeeklySegment>
): TimeframeBarInventory[] {
  const bars1m = usableWeeks.reduce((a, w) => a + w.bars1m, 0);
  const bars5m = usableWeeks.reduce((a, w) => a + w.bars5m, 0);
  const bars15m = usableWeeks.reduce((a, w) => a + w.bars15m, 0);
  return [
    { timeframe: "1m", usableBars: bars1m, intervalMs: researchIntervalMs("1m"), researchOnly: false },
    { timeframe: "5m", usableBars: bars5m, intervalMs: researchIntervalMs("5m"), researchOnly: false },
    {
      timeframe: "15m",
      usableBars: bars15m,
      intervalMs: researchIntervalMs("15m"),
      researchOnly: true
    }
  ];
}

export function assertNoStrategyParameterMutation(): void {
  const specs = listBenchmarkStrategies();
  for (const s of specs) {
    const again = listBenchmarkStrategies([s.strategyId])[0]!;
    expectDeepEqualParams(s.parameters, again.parameters, s.strategyId);
  }
}

function expectDeepEqualParams(
  a: Record<string, number | boolean | string>,
  b: Record<string, number | boolean | string>,
  id: string
): void {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) {
      throw new Error(`Strategy parameter mutation detected for ${id}.${k}`);
    }
  }
}

export function buildCrossTimeframeTable(
  bundles: ReadonlyArray<StrategyTimeframeBundle>,
  costByTf: ReadonlyArray<CostToMoveTimeframeSummary>
): CrossTimeframeComparisonRow[] {
  const spreadByTf = new Map(costByTf.map((c) => [c.timeframe, c.spreadOverAtr]));
  return bundles.map((b) => ({
    strategyId: b.strategyId,
    timeframe: b.timeframe,
    trades: b.pooled.OBSERVED_SPREAD_ONLY.totalTrades,
    observedExpectancyR: b.pooled.OBSERVED_SPREAD_ONLY.expectancyR,
    observedProfitFactor: b.pooled.OBSERVED_SPREAD_ONLY.profitFactor,
    holdoutExpectancyR: b.holdout.expectancyR,
    holdoutProfitFactor: b.holdout.profitFactor,
    holdoutTrades: b.holdout.trades,
    positiveWeekPct: b.pooled.OBSERVED_SPREAD_ONLY.positiveWeekPct,
    wfPositivePct: b.wfPositivePct,
    medianSpreadOverAtr: spreadByTf.get(b.timeframe) ?? null,
    classification: b.classification,
    buyExpectancyR: b.buySell.buyExpectancyR,
    sellExpectancyR: b.buySell.sellExpectancyR
  }));
}

export {
  assertProductionIntervalsUnchanged,
  buildXauUsdCostProfiles,
  inventoryXauUsdWeeklySegments,
  listBenchmarkStrategies,
  sampleSizeFlag
};
