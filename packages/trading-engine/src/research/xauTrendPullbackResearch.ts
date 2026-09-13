/**
 * Research runner for xau-trend-pullback-v1 (no enablement / no DEMO auto-promotion).
 *
 * Timestamp alignment:
 * - Strategy evaluates on 1m candles; entries only on completed contiguous M15 closes.
 * - H4 bias uses session-aware completed 4h buckets with closeTime <= as-of 1m close.
 * - No forming H4/M15 bars; no future data in ATR percentile or bias.
 *
 * Warm-up: H4 EMA50 needs ~55 completed 4h bars. Research runs use a long context
 * window on chronological development/holdout slices (not isolated week-only bars).
 */
import { type Candle } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import {
  XauTrendPullbackStrategy,
  XAU_TREND_PULLBACK_DEFAULTS,
  XAU_TREND_PULLBACK_SENSITIVITY_RANGES,
  type XauTrendPullbackParams
} from "../strategies/xauTrendPullback.js";
import { summarizeTrades, type SplitMetrics } from "./benchmarkMetrics.js";
import { assertNoHoldoutLeakage, splitHoldoutByTimestamp } from "./holdoutSplit.js";
import {
  aggregateWeeklyResults,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  hourOfDayBreakdown,
  inventoryXauUsdWeeklySegments,
  sessionBucketBreakdown,
  utcWeekStartMs,
  weekDominanceShare,
  type PooledWeekAggregate,
  type WeeklyStrategyResult,
  type XauUsdCostProfile,
  type XauUsdCostProfileId,
  type XauUsdWeeklySegment,
  xauUsdResearchInstrument
} from "./xauUsdWeeklyRobustness.js";
import { buildBreakoutDirectionalDiagnostics } from "./breakoutFamilyResearch.js";

export type XauTrendPullbackResearchClass =
  | "PROMISING_FOR_FORWARD_DEMO_RESEARCH"
  | "NO_EDGE"
  | "UNSTABLE"
  | "TOO_SPARSE"
  | "COST_SENSITIVE"
  | "OVERFIT"
  | "DATA_QUALITY_BLOCKED";

/** DEMO-candidate gates (research only — never auto-deploy). */
export const XAU_TREND_PULLBACK_DEMO_CANDIDATE_GATES = {
  minHoldoutExpectancyR: 0,
  minHoldoutProfitFactor: 1.2,
  minHoldoutTrades: 30,
  minPooledTrades: 50,
  minPositiveWeekPct: 0.45,
  minWfPositivePct: 0.4,
  requireSurviveAssumedSlip025: true,
  maxDominanceShare: 0.6
} as const;

/** Context large enough for H4 EMA50 warm-up on session-aware 4h bars. */
export const XAU_TREND_PULLBACK_RESEARCH_CONTEXT_WINDOW = 16_000;
/** ~16 M15 bars expressed in 1m steps. */
export const XAU_TREND_PULLBACK_RESEARCH_MAX_HOLD_BARS = 240;

export async function runXauTrendPullbackOnCandles(
  candles: ReadonlyArray<Candle>,
  params: Partial<XauTrendPullbackParams>,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const strategy = new XauTrendPullbackStrategy();
  const parameters = strategy.validateParameters({
    ...XAU_TREND_PULLBACK_DEFAULTS,
    ...params
  });
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: XAU_TREND_PULLBACK_RESEARCH_MAX_HOLD_BARS,
    contextWindowSize: XAU_TREND_PULLBACK_RESEARCH_CONTEXT_WINDOW,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy, parameters }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

/** Attribute trades into weekly rows for pooled multi-week metrics. */
export function attributeTradesToWeeklyResults(
  trades: ReadonlyArray<CfdSimulatedTrade>,
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  strategyId: string,
  costProfileId: XauUsdCostProfileId
): WeeklyStrategyResult[] {
  const usable = weeks.filter((w) => w.usable);
  return usable.map((week) => {
    const scoped = trades.filter(
      (t) => t.entryTime >= week.startOpenTime && t.entryTime <= week.endOpenTime + 60_000
    );
    return {
      segmentId: week.segmentId,
      weekStartIso: week.weekStartIso,
      strategyId,
      costProfileId,
      metrics: summarizeTrades(scoped)
    };
  });
}

export function atrPercentileBucketBreakdown(
  trades: ReadonlyArray<CfdSimulatedTrade>
): Array<{ bucket: string; trades: number; expectancyR: number; netR: number }> {
  // Uses 1m feature volatilityPercentile captured at entry (related vol regime).
  // Strategy entry filter itself uses M15 ATR percentile (not stored on CFD trade snapshot).
  const buckets = new Map<string, { n: number; netR: number }>();
  for (const t of trades) {
    const p = t.entryFeatures?.volatilityPercentile ?? null;
    let bucket = "UNKNOWN";
    if (p != null && Number.isFinite(p)) {
      if (p < 0.2) bucket = "p0_20";
      else if (p < 0.4) bucket = "p20_40";
      else if (p < 0.6) bucket = "p40_60";
      else if (p < 0.85) bucket = "p60_85";
      else bucket = "p85_100";
    }
    const cur = buckets.get(bucket) ?? { n: 0, netR: 0 };
    cur.n++;
    cur.netR += t.netR ?? 0;
    buckets.set(bucket, cur);
  }
  return [...buckets.entries()].map(([bucket, v]) => ({
    bucket,
    trades: v.n,
    expectancyR: v.n > 0 ? v.netR / v.n : 0,
    netR: v.netR
  }));
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function consecutiveStreaks(trades: ReadonlyArray<CfdSimulatedTrade>): {
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
} {
  let maxW = 0;
  let maxL = 0;
  let w = 0;
  let l = 0;
  for (const t of trades) {
    if (t.outcome === "WIN") {
      w++;
      l = 0;
      maxW = Math.max(maxW, w);
    } else if (t.outcome === "LOSS") {
      l++;
      w = 0;
      maxL = Math.max(maxL, l);
    } else {
      w = 0;
      l = 0;
    }
  }
  return { maxConsecutiveWins: maxW, maxConsecutiveLosses: maxL };
}

function averageStopDistanceAtr(trades: ReadonlyArray<CfdSimulatedTrade>): number | null {
  const vals: number[] = [];
  for (const t of trades) {
    const atr =
      typeof t.entryFeatures?.atr === "number"
        ? t.entryFeatures.atr
        : null;
    if (atr == null || atr <= 0) continue;
    const stopDist = Math.abs(t.entryPrice - t.stopLoss);
    vals.push(stopDist / atr);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function classifyXauTrendPullbackResearch(input: {
  pooledObserved: PooledWeekAggregate;
  zeroExpectancyR: number;
  holdoutTrades: number;
  holdoutExpectancyR: number;
  holdoutProfitFactor: number | null;
  positiveWeekPct: number;
  wfPositivePct: number;
  survivesAssumedSlip025: boolean;
  singleWeekDominates: boolean;
  maxDrawdownPercent: number | null;
}): {
  classification: XauTrendPullbackResearchClass;
  reasons: string[];
  passesDemoCandidate: boolean;
} {
  const g = XAU_TREND_PULLBACK_DEMO_CANDIDATE_GATES;
  const reasons: string[] = [];
  const trades = input.pooledObserved.totalTrades;
  const adequate = trades >= g.minPooledTrades || input.holdoutTrades >= g.minHoldoutTrades;

  if (!adequate && trades < 20 && input.holdoutTrades < 20) {
    return {
      classification: "TOO_SPARSE",
      reasons: [`Sparse sample pooled=${trades} holdout=${input.holdoutTrades}`],
      passesDemoCandidate: false
    };
  }
  if (input.zeroExpectancyR > 0 && input.pooledObserved.expectancyR <= 0 && adequate) {
    return {
      classification: "COST_SENSITIVE",
      reasons: ["Zero-cost positive; observed/assumed costs kill edge"],
      passesDemoCandidate: false
    };
  }
  if (input.pooledObserved.expectancyR <= 0 && adequate) {
    return {
      classification: "NO_EDGE",
      reasons: ["Observed-spread pooled expectancy ≤ 0"],
      passesDemoCandidate: false
    };
  }

  const passesDemoCandidate =
    input.holdoutExpectancyR > g.minHoldoutExpectancyR &&
    (input.holdoutProfitFactor ?? 0) > g.minHoldoutProfitFactor &&
    input.holdoutTrades >= g.minHoldoutTrades &&
    input.pooledObserved.expectancyR > 0 &&
    (input.pooledObserved.profitFactor ?? 0) > 1 &&
    input.positiveWeekPct >= g.minPositiveWeekPct &&
    input.pooledObserved.positiveWeekCount >= 2 &&
    input.wfPositivePct >= g.minWfPositivePct &&
    (!g.requireSurviveAssumedSlip025 || input.survivesAssumedSlip025) &&
    !input.singleWeekDominates &&
    adequate;

  if (passesDemoCandidate) {
    if (input.holdoutTrades < 50) reasons.push("Holdout <50 trades (preferred ≥50)");
    return {
      classification: "PROMISING_FOR_FORWARD_DEMO_RESEARCH",
      reasons: [...reasons, "Cleared DEMO-candidate research gates (no auto deploy)"],
      passesDemoCandidate: true
    };
  }
  if (
    input.pooledObserved.expectancyR > 0 &&
    (input.positiveWeekPct < 0.4 || input.wfPositivePct < 0.35)
  ) {
    return {
      classification: "UNSTABLE",
      reasons: ["Pooled positive but week/WF unstable"],
      passesDemoCandidate: false
    };
  }
  if (!adequate) {
    return {
      classification: "TOO_SPARSE",
      reasons: [`Sample sparse pooled=${trades} holdout=${input.holdoutTrades}`],
      passesDemoCandidate: false
    };
  }
  if (!input.survivesAssumedSlip025 && input.pooledObserved.expectancyR > 0) {
    return {
      classification: "COST_SENSITIVE",
      reasons: ["Fails ASSUMED_SLIP_0_25 (modeled slip — not empirical)"],
      passesDemoCandidate: false
    };
  }
  if (input.singleWeekDominates) {
    return {
      classification: "UNSTABLE",
      reasons: ["Single week dominates positive netR"],
      passesDemoCandidate: false
    };
  }
  if ((input.holdoutProfitFactor ?? 0) <= g.minHoldoutProfitFactor && input.holdoutTrades > 0) {
    reasons.push(
      `Holdout PF ${(input.holdoutProfitFactor ?? 0).toFixed(2)} ≤ ${g.minHoldoutProfitFactor}`
    );
  }
  return {
    classification: "UNSTABLE",
    reasons: reasons.length ? reasons : ["Did not clear DEMO-candidate gates"],
    passesDemoCandidate: false
  };
}

function enrichTradeMetrics(trades: ReadonlyArray<CfdSimulatedTrade>, metrics: SplitMetrics) {
  const rs = trades.map((t) => t.netR).filter((x): x is number => x != null);
  const streaks = consecutiveStreaks(trades);
  return {
    ...metrics,
    averageR: metrics.expectancyR,
    medianR: median(rs),
    averageStopDistanceAtr: averageStopDistanceAtr(trades),
    ...streaks,
    sessionBreakdown: sessionBucketBreakdown(trades),
    hourBreakdown: hourOfDayBreakdown(trades),
    atrPercentileBuckets: atrPercentileBucketBreakdown(trades),
    directionalDiagnostics: buildBreakoutDirectionalDiagnostics(trades)
  };
}

export async function runXauTrendPullbackResearch(input: {
  candles1m: ReadonlyArray<Candle>;
  usableWeeks: ReadonlyArray<XauUsdWeeklySegment>;
  observedSpreadBps: number;
  spreadStatus: string;
  params?: Partial<XauTrendPullbackParams>;
}): Promise<Record<string, unknown>> {
  const strategyId = "xau-trend-pullback-v1";
  const params = { ...XAU_TREND_PULLBACK_DEFAULTS, ...input.params };
  const profiles = buildXauUsdCostProfiles(input.observedSpreadBps);
  const { developmentWeeks, holdoutWeeks, holdoutStartOpenTime } = chronologicalWeekSplit(
    input.usableWeeks,
    0.3
  );

  if (holdoutStartOpenTime == null) {
    return {
      generatedAt: new Date().toISOString(),
      strategyId,
      classification: "DATA_QUALITY_BLOCKED",
      passesDemoCandidate: false,
      classificationReasons: ["No chronological holdout weeks"],
      safety: {
        noStrategyEnabled: true,
        notOnMt5Allowlist: true,
        r10SqueezeForwardTrialUntouched: true,
        nothingDeployed: true
      }
    };
  }

  const split = splitHoldoutByTimestamp(input.candles1m, holdoutStartOpenTime);
  assertNoHoldoutLeakage(split.development, holdoutStartOpenTime);

  const costRuns: Record<
    string,
    { development: Awaited<ReturnType<typeof runXauTrendPullbackOnCandles>>; holdout: Awaited<
      ReturnType<typeof runXauTrendPullbackOnCandles>
    > }
  > = {};

  for (const profile of profiles) {
    const [development, holdout] = await Promise.all([
      runXauTrendPullbackOnCandles(
        split.development,
        params,
        profile.spreadBps,
        profile.slippageBps
      ),
      runXauTrendPullbackOnCandles(split.holdout, params, profile.spreadBps, profile.slippageBps)
    ]);
    costRuns[profile.id] = { development, holdout };
  }

  const observedId: XauUsdCostProfileId = "OBSERVED_SPREAD_ONLY";
  const zeroId: XauUsdCostProfileId = "ZERO";
  const slip025Id: XauUsdCostProfileId = "ASSUMED_SLIP_0_25";
  const slip050Id: XauUsdCostProfileId = "ASSUMED_SLIP_0_50";

  const devObs = costRuns[observedId]!.development;
  const holdObs = costRuns[observedId]!.holdout;
  const devZero = costRuns[zeroId]!.development;
  const holdSlip025 = costRuns[slip025Id]!.holdout;
  const holdSlip050 = costRuns[slip050Id]!.holdout;

  const weeklyDevObs = attributeTradesToWeeklyResults(
    devObs.trades,
    developmentWeeks,
    strategyId,
    observedId
  );
  const weeklyHoldObs = attributeTradesToWeeklyResults(
    holdObs.trades,
    holdoutWeeks,
    strategyId,
    observedId
  );
  const pooledObs = aggregateWeeklyResults(weeklyDevObs, strategyId, observedId);
  const pooledHold = aggregateWeeklyResults(weeklyHoldObs, strategyId, observedId);
  const weeklyDevZero = attributeTradesToWeeklyResults(
    devZero.trades,
    developmentWeeks,
    strategyId,
    zeroId
  );
  const pooledZero = aggregateWeeklyResults(weeklyDevZero, strategyId, zeroId);

  const dominanceShare = weekDominanceShare(weeklyDevObs, strategyId, observedId);
  const positiveWeekPct = pooledObs.positiveWeekPct;
  // Walk-forward proxy: first 70% of development weeks vs last 30% of development weeks
  const wfCut = Math.max(1, Math.floor(developmentWeeks.length * 0.7));
  const wfTrainWeeks = developmentWeeks.slice(0, wfCut);
  const wfValWeeks = developmentWeeks.slice(wfCut);
  const wfValRows = attributeTradesToWeeklyResults(
    devObs.trades,
    wfValWeeks,
    strategyId,
    observedId
  );
  const wfValAgg = aggregateWeeklyResults(wfValRows, strategyId, observedId);
  const wfPositivePct = wfValAgg.positiveWeekPct;

  const verdict = classifyXauTrendPullbackResearch({
    pooledObserved: pooledObs,
    zeroExpectancyR: pooledZero.expectancyR,
    holdoutTrades: holdObs.metrics.trades,
    holdoutExpectancyR: holdObs.metrics.expectancyR,
    holdoutProfitFactor: holdObs.metrics.profitFactor,
    positiveWeekPct,
    wfPositivePct,
    survivesAssumedSlip025: holdSlip025.metrics.expectancyR > 0,
    singleWeekDominates: dominanceShare > XAU_TREND_PULLBACK_DEMO_CANDIDATE_GATES.maxDominanceShare,
    maxDrawdownPercent: holdObs.metrics.maxDrawdownPercent
  });

  // Target R sensitivity on development only (does not change base signal)
  const targetSensitivity: Array<Record<string, unknown>> = [];
  for (const r of XAU_TREND_PULLBACK_SENSITIVITY_RANGES.targetRMultiple) {
    const run = await runXauTrendPullbackOnCandles(
      split.development,
      { ...params, targetRMultiple: r },
      input.observedSpreadBps,
      0
    );
    targetSensitivity.push({
      targetRMultiple: r,
      trades: run.metrics.trades,
      expectancyR: run.metrics.expectancyR,
      profitFactor: run.metrics.profitFactor,
      netR: run.metrics.netR,
      note: "Development-only sensitivity; signal logic unchanged for base report"
    });
  }

  const costSensitivity = profiles.map((p) => {
    const d = costRuns[p.id]!.development;
    const h = costRuns[p.id]!.holdout;
    return {
      id: p.id,
      label: p.label,
      spreadBps: p.spreadBps,
      slippageBps: p.slippageBps,
      costKind:
        p.label === "ASSUMED"
          ? "MODELED_HYPOTHETICAL_SLIPPAGE_NOT_EMPIRICAL"
          : p.label === "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST"
            ? "EMPIRICAL_OBSERVED_SPREAD_ONLY"
            : "ZERO_COST",
      development: {
        trades: d.metrics.trades,
        expectancyR: d.metrics.expectancyR,
        profitFactor: d.metrics.profitFactor,
        netR: d.metrics.netR
      },
      holdout: {
        trades: h.metrics.trades,
        expectancyR: h.metrics.expectancyR,
        profitFactor: h.metrics.profitFactor,
        netR: h.metrics.netR,
        maxDrawdownPercent: h.metrics.maxDrawdownPercent
      }
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    strategyId,
    defaults: params,
    timestampAlignment: {
      entryBar: "Completed contiguous M15 close only (closesCompletedHtfBucket 15m)",
      h4Bias:
        "Session-aware completed 4h buckets with closeTime <= as-of 1m close; minFillRatio default 0.25",
      noLookahead: true,
      atrPercentile: "Current ATR vs prior lookback window inclusive of current bar only"
    },
    costAssumptions: {
      observedSpreadBps: input.observedSpreadBps,
      spreadStatus: input.spreadStatus,
      note: "ASSUMED_SLIP_* slippage is modeled/hypothetical — never label as empirical"
    },
    splits: {
      developmentWeeks: developmentWeeks.map((w) => w.segmentId),
      holdoutWeeks: holdoutWeeks.map((w) => w.segmentId),
      holdoutStartOpenTime,
      holdoutStartIso: new Date(holdoutStartOpenTime).toISOString(),
      developmentBars: split.development.length,
      holdoutBars: split.holdout.length,
      holdoutUntouchedForParamSelection: true
    },
    development: {
      pooledObservedSpread: pooledObs,
      pooledZero,
      weekDominanceShare: dominanceShare,
      walkForwardValidationWeeks: wfValWeeks.map((w) => w.segmentId),
      walkForwardValidation: wfValAgg,
      metrics: enrichTradeMetrics(devObs.trades, devObs.metrics),
      trainWeekIds: wfTrainWeeks.map((w) => w.segmentId)
    },
    holdout: enrichTradeMetrics(holdObs.trades, holdObs.metrics),
    holdoutWeeklyPooled: pooledHold,
    costSensitivity,
    targetRSensitivityDevelopmentOnly: targetSensitivity,
    classification: verdict.classification,
    passesDemoCandidate: verdict.passesDemoCandidate,
    classificationReasons: verdict.reasons,
    demoCandidateGates: XAU_TREND_PULLBACK_DEMO_CANDIDATE_GATES,
    safety: {
      noStrategyEnabled: true,
      notOnMt5Allowlist: true,
      r10SqueezeForwardTrialUntouched: true,
      nothingDeployed: true,
      realMoneyDisabled: true,
      globalRiskCapsUnchanged: true
    }
  };
}

export {
  inventoryXauUsdWeeklySegments,
  chronologicalWeekSplit,
  buildXauUsdCostProfiles,
  utcWeekStartMs
};

export type { XauUsdCostProfile, XauUsdWeeklySegment };
