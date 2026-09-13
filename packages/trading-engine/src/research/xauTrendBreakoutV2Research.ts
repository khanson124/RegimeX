/**
 * Research runner for xau-trend-breakout-v2 (development only; no holdout selection / no deploy).
 */
import { type Candle } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { extractFeatures } from "../features/featureExtractor.js";
import { completedHtfBarsAsOf, closesCompletedHtfBucket } from "../strategies/mtfResampleAsOf.js";
import {
  atrPercentileAtEnd,
  classifyH4TrendBias,
  completedSessionAwareHtfBarsAsOf,
  isWithinUtcSessionHours
} from "../strategies/xauTrendPullbackHtf.js";
import { sessionContextFromEpochMs } from "../strategies/xauMtfEntryQuality.js";
import {
  evaluateBreakoutRetest,
  evaluateConsolidationBreakout
} from "../strategies/xauTrendBreakoutV2Consolidation.js";
import {
  XauTrendBreakoutV2Strategy,
  XAU_TREND_BREAKOUT_V2_DEFAULTS,
  type XauTrendBreakoutV2Params
} from "../strategies/xauTrendBreakoutV2.js";
import { summarizeTrades, type SplitMetrics } from "./benchmarkMetrics.js";
import {
  buildXauUsdCostProfiles,
  hourOfDayBreakdown,
  sessionBucketBreakdown,
  weekDominanceShare,
  type XauUsdWeeklySegment,
  xauUsdResearchInstrument,
  aggregateWeeklyResults
} from "./xauUsdWeeklyRobustness.js";
import {
  classifySampleSize,
  maxDrawdownR
} from "./xauTrendPullbackSparsityDiagnostic.js";
import { runXauTrendPullbackOnCandles } from "./xauTrendPullbackResearch.js";
import { buildBreakoutDirectionalDiagnostics } from "./breakoutFamilyResearch.js";

export { classifySampleSize };
export const XAU_TREND_BREAKOUT_V2_CONTEXT_WINDOW = 16_000;
export const XAU_TREND_BREAKOUT_V2_MAX_HOLD_BARS = 240;

export const FUTURE_UNTOUCHED_HOLDOUT_START_ISO = "2026-09-08T13:01:00.000Z";
export const FUTURE_UNTOUCHED_HOLDOUT_START_MS = Date.parse(FUTURE_UNTOUCHED_HOLDOUT_START_ISO);

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function consecutiveStreaks(trades: ReadonlyArray<CfdSimulatedTrade>) {
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

function averageStopAtr(trades: ReadonlyArray<CfdSimulatedTrade>): number | null {
  const vals: number[] = [];
  for (const t of trades) {
    const atr = t.entryFeatures?.atr;
    if (atr == null || atr <= 0) continue;
    vals.push(Math.abs(t.entryPrice - t.stopLoss) / atr);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function enrich(trades: CfdSimulatedTrade[], metrics: SplitMetrics) {
  const rs = trades.map((t) => t.netR).filter((x): x is number => x != null);
  return {
    ...metrics,
    averageR: metrics.expectancyR,
    medianR: median(rs),
    maxDrawdownR: maxDrawdownR(trades),
    averageStopDistanceAtr: averageStopAtr(trades),
    ...consecutiveStreaks(trades),
    sessionBreakdown: sessionBucketBreakdown(trades),
    hourBreakdown: hourOfDayBreakdown(trades),
    directionalDiagnostics: buildBreakoutDirectionalDiagnostics(trades),
    sampleSizeLabel: classifySampleSize(metrics.trades)
  };
}

export async function runXauTrendBreakoutV2OnCandles(
  candles: ReadonlyArray<Candle>,
  params: Partial<XauTrendBreakoutV2Params>,
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const strategy = new XauTrendBreakoutV2Strategy();
  const parameters = strategy.validateParameters({
    ...XAU_TREND_BREAKOUT_V2_DEFAULTS,
    ...params
  });
  const run = await new CfdBacktester({
    startingBalance: 10_000,
    riskPerTradePercent: 0.5,
    minRiskRewardRatio: 1.5,
    maxHoldBars: XAU_TREND_BREAKOUT_V2_MAX_HOLD_BARS,
    contextWindowSize: XAU_TREND_BREAKOUT_V2_CONTEXT_WINDOW,
    instrument: xauUsdResearchInstrument(spreadBps, slippageBps),
    strategies: [{ strategy, parameters }],
    testSplit: 0
  }).run([...candles]);
  return { metrics: summarizeTrades(run.trades, run.summary), trades: run.trades };
}

function sessionBucket(hour: number): string {
  if (hour >= 7 && hour < 12) return "LONDON";
  if (hour >= 12 && hour < 16) return "LONDON_NY_OVERLAP";
  if (hour >= 16 && hour < 21) return "NY";
  if (hour >= 0 && hour < 7) return "ASIA";
  return "OFF";
}

export function runXauTrendBreakoutV2Funnel(
  candles1m: ReadonlyArray<Candle>,
  paramsPartial?: Partial<XauTrendBreakoutV2Params>
) {
  const p = { ...XAU_TREND_BREAKOUT_V2_DEFAULTS, ...paramsPartial };
  const m15Events: number[] = [];
  for (let i = 0; i < candles1m.length; i++) {
    if (closesCompletedHtfBucket(candles1m, i, "15m")) m15Events.push(i);
  }
  const last = m15Events.at(-1) ?? -1;
  const m15All = last >= 0 ? completedHtfBarsAsOf(candles1m, last, "15m") : [];
  const m15Feat = m15All.length ? extractFeatures(m15All) : [];
  const h4All =
    last >= 0
      ? completedSessionAwareHtfBarsAsOf(candles1m, last, "4h", { minFillRatio: p.h4MinFillRatio })
      : [];

  let m15Bars = 0;
  let h4Valid = 0;
  let h4Dir = 0;
  let sessionOk = 0;
  let volOk = 0;
  let consolidationOk = 0;
  let breakout = 0;
  let quality = 0;
  let cooldownClear = 0;
  let finalSig = 0;
  let buy = 0;
  let sell = 0;
  let lastSig = Number.NEGATIVE_INFINITY;
  const adxBuckets: Record<string, number> = {};
  const atrBuckets: Record<string, number> = {};
  const sessionDiag: Record<string, { directional: number; signals: number }> = {};

  // Map as-of 1m index -> m15 length-1
  for (const asOf of m15Events) {
    const m15 = completedHtfBarsAsOf(candles1m, asOf, "15m");
    if (m15.length < 80) continue;
    m15Bars++;
    const m15Idx = m15.length - 1;
    const ts = m15[m15Idx]!.closeTime;
    let h4End = -1;
    for (let h = 0; h < h4All.length; h++) {
      if (h4All[h]!.closeTime <= ts) h4End = h;
      else break;
    }
    const h4Slice = h4End >= 0 ? h4All.slice(0, h4End + 1) : [];
    const biasSnap = classifyH4TrendBias(h4Slice, { slopeLookback: p.h4SlopeLookback });
    if (h4Slice.length < 55 || biasSnap.ema21 == null) continue;
    h4Valid++;
    if (biasSnap.bias === "NEUTRAL") continue;
    h4Dir++;
    const sess = sessionBucket(new Date(ts).getUTCHours());
    sessionDiag[sess] ??= { directional: 0, signals: 0 };
    sessionDiag[sess]!.directional++;

    const feat = m15Feat[m15Idx];
    const adx = feat?.adx ?? null;
    const adxB =
      adx == null
        ? "UNKNOWN"
        : adx < 15
          ? "adx_lt_15"
          : adx < 20
            ? "adx_15_20"
            : adx < 25
              ? "adx_20_25"
              : "adx_gte_25";
    adxBuckets[adxB] = (adxBuckets[adxB] ?? 0) + 1;

    if (!isWithinUtcSessionHours(ts, p.sessionStartHourUtc, p.sessionEndHourUtc)) continue;
    sessionOk++;
    if (!feat || feat.atr == null || feat.atr <= 0) continue;
    if (p.adxMinimum > 0 && feat.adx != null && feat.adx < p.adxMinimum) continue;

    const atrSeries = m15Feat.slice(0, m15Idx + 1).map((f) => f.atr);
    const atrPct = atrPercentileAtEnd(atrSeries, p.atrPercentileLookback);
    const atrB =
      atrPct == null
        ? "UNKNOWN"
        : atrPct < 0.2
          ? "p0_20"
          : atrPct < 0.4
            ? "p20_40"
            : atrPct < 0.6
              ? "p40_60"
              : atrPct < 0.9
                ? "p60_90"
                : "p90_100";
    atrBuckets[atrB] = (atrBuckets[atrB] ?? 0) + 1;
    if (atrPct == null || atrPct < p.atrPercentileMin || atrPct > p.atrPercentileMax) continue;
    volOk++;

    if (p.entryMode === "immediate") {
      const snap = evaluateConsolidationBreakout({
        m15: m15All.slice(0, m15Idx + 1),
        barIndex: m15Idx,
        bias: biasSnap.bias as "BULLISH" | "BEARISH",
        atr: feat.atr,
        lookback: p.consolidationLookback,
        minWidthAtr: p.minConsolidationWidthAtr,
        maxWidthAtr: p.maxConsolidationWidthAtr,
        minBreakoutDistanceAtr: p.minBreakoutDistanceAtr,
        maxBreakoutCandleRangeAtr: p.maxBreakoutCandleRangeAtr,
        minBreakoutBodyAtr: p.minBreakoutBodyAtr
      });
      if (snap.consolidation == null) continue;
      consolidationOk++;
      if (!snap.breakout) continue;
      breakout++;
      if (!snap.qualityPass) continue;
      quality++;
      if (m15Idx - lastSig < p.cooldownCandles) continue;
      cooldownClear++;
      finalSig++;
      lastSig = m15Idx;
      if (snap.direction === "BUY") buy++;
      else sell++;
      sessionDiag[sess]!.signals++;
    } else {
      const retest = evaluateBreakoutRetest({
        m15: m15All.slice(0, m15Idx + 1),
        barIndex: m15Idx,
        bias: biasSnap.bias as "BULLISH" | "BEARISH",
        atr: feat.atr,
        lookback: p.consolidationLookback,
        minWidthAtr: p.minConsolidationWidthAtr,
        maxWidthAtr: p.maxConsolidationWidthAtr,
        minBreakoutDistanceAtr: p.minBreakoutDistanceAtr,
        maxBreakoutCandleRangeAtr: p.maxBreakoutCandleRangeAtr,
        minBreakoutBodyAtr: p.minBreakoutBodyAtr,
        maxRetestDelayBars: p.maxRetestDelayBars,
        retestTouchAtr: p.retestTouchAtr
      });
      if (retest.consolidation != null) consolidationOk++;
      if (retest.breakoutBarIndex != null) {
        breakout++;
        quality++;
      }
      if (!retest.ok) continue;
      if (m15Idx - lastSig < p.cooldownCandles) continue;
      cooldownClear++;
      finalSig++;
      lastSig = m15Idx;
      if (retest.direction === "BUY") buy++;
      else sell++;
      sessionDiag[sess]!.signals++;
    }
  }

  const stages = [
    { stage: "m15_bars", count: m15Bars },
    { stage: "h4_valid", count: h4Valid },
    { stage: "h4_directional", count: h4Dir },
    { stage: "session_allowed", count: sessionOk },
    { stage: "volatility_allowed", count: volOk },
    { stage: "valid_consolidation", count: consolidationOk },
    { stage: "breakout", count: breakout },
    { stage: "breakout_quality_passed", count: quality },
    { stage: "cooldown_clear", count: cooldownClear },
    { stage: "final_signal", count: finalSig, buy, sell }
  ];

  return { stages, adxBuckets, atrBuckets, sessionDiag, finalBuy: buy, finalSell: sell };
}

function costKind(label: string): string {
  if (label === "ASSUMED") return "MODELED_HYPOTHETICAL_SLIPPAGE_NOT_EMPIRICAL";
  if (label === "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST")
    return "EMPIRICAL_OBSERVED_SPREAD_ONLY";
  return "ZERO_COST";
}

export function classifyBreakoutV2Architecture(input: {
  developmentTrades: number;
  expectancyRObserved: number;
  profitFactorObserved: number | null;
  maxDrawdownR: number;
  survivesModestSlip: boolean;
  weekDominanceShare: number;
}): {
  meritsContinuedResearch: boolean;
  sampleSizeLabel: ReturnType<typeof classifySampleSize>;
  reasons: string[];
} {
  const label = classifySampleSize(input.developmentTrades);
  const reasons: string[] = [];
  const ok =
    input.developmentTrades >= 50 &&
    input.expectancyRObserved > 0 &&
    (input.profitFactorObserved ?? 0) > 1.15 &&
    input.maxDrawdownR < 25 &&
    input.survivesModestSlip &&
    input.weekDominanceShare <= 0.6;
  if (input.developmentTrades < 50) reasons.push(`Sample ${label} (${input.developmentTrades} trades)`);
  if (!(input.expectancyRObserved > 0)) reasons.push("Observed-spread expectancy ≤ 0");
  if (!((input.profitFactorObserved ?? 0) > 1.15))
    reasons.push(`Observed PF ${(input.profitFactorObserved ?? 0).toFixed(2)} ≤ 1.15`);
  if (!input.survivesModestSlip) reasons.push("Fails modest modeled slippage (ASSUMED_SLIP_0_25)");
  if (input.weekDominanceShare > 0.6) reasons.push("Single week dominates positive netR");
  if (ok) reasons.push("Clears continued-research gates (NOT DEMO approval)");
  return { meritsContinuedResearch: ok, sampleSizeLabel: label, reasons };
}

export async function runXauTrendBreakoutV2Research(input: {
  developmentCandles: ReadonlyArray<Candle>;
  developmentWeeks: ReadonlyArray<XauUsdWeeklySegment>;
  observedSpreadBps: number;
  spreadStatus: string;
  datasetEndOpenTime: number;
}): Promise<Record<string, unknown>> {
  const defaults = { ...XAU_TREND_BREAKOUT_V2_DEFAULTS };
  const profiles = buildXauUsdCostProfiles(input.observedSpreadBps);
  const costIds = ["ZERO", "OBSERVED_SPREAD_ONLY", "ASSUMED_SLIP_0_25", "ASSUMED_SLIP_0_50"] as const;

  const funnelImmediate = runXauTrendBreakoutV2Funnel(input.developmentCandles, {
    entryMode: "immediate"
  });
  const funnelRetest = runXauTrendBreakoutV2Funnel(input.developmentCandles, {
    entryMode: "retest"
  });

  // Architecture A: immediate breakout — full cost matrix
  const immediateByCost: Record<string, ReturnType<typeof enrich>> = {};
  let immediateTradesObs: CfdSimulatedTrade[] = [];
  for (const id of costIds) {
    const profile = profiles.find((p) => p.id === id)!;
    const run = await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { entryMode: "immediate" },
      profile.spreadBps,
      profile.slippageBps
    );
    immediateByCost[id] = {
      ...enrich(run.trades, run.metrics),
      costKind: costKind(profile.label),
      spreadBps: profile.spreadBps,
      slippageBps: profile.slippageBps
    } as ReturnType<typeof enrich> & Record<string, unknown>;
    if (id === "OBSERVED_SPREAD_ONLY") immediateTradesObs = run.trades;
  }

  // Architecture B: retest — observed + zero at minimum
  const retestZero = await runXauTrendBreakoutV2OnCandles(
    input.developmentCandles,
    { entryMode: "retest" },
    0,
    0
  );
  const retestObs = await runXauTrendBreakoutV2OnCandles(
    input.developmentCandles,
    { entryMode: "retest" },
    input.observedSpreadBps,
    0
  );
  const retestSlip = await runXauTrendBreakoutV2OnCandles(
    input.developmentCandles,
    { entryMode: "retest" },
    input.observedSpreadBps,
    0.25
  );

  // Reference C: pullback v1 on same development (untouched strategy)
  const v1Zero = await runXauTrendPullbackOnCandles(input.developmentCandles, {}, 0, 0);
  const v1Obs = await runXauTrendPullbackOnCandles(
    input.developmentCandles,
    {},
    input.observedSpreadBps,
    0
  );

  // Development-only comparisons (not selected via holdout)
  const comparisons = {
    atr_10_90: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { atrPercentileMin: 0.1, atrPercentileMax: 0.9 },
      input.observedSpreadBps,
      0
    ),
    atr_20_90: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { atrPercentileMin: 0.2, atrPercentileMax: 0.9 },
      input.observedSpreadBps,
      0
    ),
    session_06_18: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { sessionStartHourUtc: 6, sessionEndHourUtc: 18 },
      input.observedSpreadBps,
      0
    ),
    adx_15: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { adxMinimum: 15 },
      input.observedSpreadBps,
      0
    ),
    adx_20: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { adxMinimum: 20 },
      input.observedSpreadBps,
      0
    ),
    target_1_5R: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { targetRMultiple: 1.5 },
      input.observedSpreadBps,
      0
    ),
    target_2_5R: await runXauTrendBreakoutV2OnCandles(
      input.developmentCandles,
      { targetRMultiple: 2.5 },
      input.observedSpreadBps,
      0
    )
  };

  const weeklyRows = input.developmentWeeks.map((week) => {
    const scoped = immediateTradesObs.filter(
      (t) => t.entryTime >= week.startOpenTime && t.entryTime <= week.endOpenTime + 60_000
    );
    return {
      segmentId: week.segmentId,
      weekStartIso: week.weekStartIso,
      strategyId: "xau-trend-breakout-v2",
      costProfileId: "OBSERVED_SPREAD_ONLY" as const,
      metrics: summarizeTrades(scoped)
    };
  });
  const pooled = aggregateWeeklyResults(weeklyRows, "xau-trend-breakout-v2", "OBSERVED_SPREAD_ONLY");
  const dominance = weekDominanceShare(
    weeklyRows,
    "xau-trend-breakout-v2",
    "OBSERVED_SPREAD_ONLY"
  );

  const obs = immediateByCost.OBSERVED_SPREAD_ONLY!;
  const slip = immediateByCost.ASSUMED_SLIP_0_25!;
  const verdict = classifyBreakoutV2Architecture({
    developmentTrades: obs.trades,
    expectancyRObserved: obs.expectancyR,
    profitFactorObserved: obs.profitFactor,
    maxDrawdownR: obs.maxDrawdownR,
    survivesModestSlip: slip.expectancyR > 0,
    weekDominanceShare: dominance
  });

  const futureHoldoutStatus =
    input.datasetEndOpenTime < FUTURE_UNTOUCHED_HOLDOUT_START_MS
      ? "PENDING_ADDITIONAL_HISTORY"
      : input.datasetEndOpenTime >= FUTURE_UNTOUCHED_HOLDOUT_START_MS
        ? "HISTORY_EXISTS_BUT_MUST_REMAIN_UNTOUCHED"
        : "PENDING_ADDITIONAL_HISTORY";

  return {
    generatedAt: new Date().toISOString(),
    strategyId: "xau-trend-breakout-v2",
    defaults,
    timestampAlignment:
      "M15 signals on contiguous completed closes only; H4 from session-aware completed buckets with closeTime <= as-of.",
    developmentScope: {
      bars1m: input.developmentCandles.length,
      startIso: new Date(input.developmentCandles[0]!.openTime).toISOString(),
      endIso: new Date(
        input.developmentCandles[input.developmentCandles.length - 1]!.openTime
      ).toISOString(),
      priorHoldoutExcluded: true,
      futureHoldoutExcluded: true
    },
    futureUntouchedHoldout: {
      startIso: FUTURE_UNTOUCHED_HOLDOUT_START_ISO,
      startOpenTime: FUTURE_UNTOUCHED_HOLDOUT_START_MS,
      status: futureHoldoutStatus,
      evaluated: false,
      note: "Must remain untouched until enough NEW chronological data exists after this boundary."
    },
    funnelImmediate,
    funnelRetest,
    architectureComparison: {
      A_immediateBreakout: {
        zero: immediateByCost.ZERO,
        observedSpread: immediateByCost.OBSERVED_SPREAD_ONLY,
        modestModeledSlip: immediateByCost.ASSUMED_SLIP_0_25,
        conservativeModeled: immediateByCost.ASSUMED_SLIP_0_50,
        funnelFinalSignals: funnelImmediate.stages.find((s) => s.stage === "final_signal"),
        executableTradesObserved: obs.trades
      },
      B_breakoutRetest: {
        zero: enrich(retestZero.trades, retestZero.metrics),
        observedSpread: enrich(retestObs.trades, retestObs.metrics),
        modestModeledSlip: enrich(retestSlip.trades, retestSlip.metrics),
        funnelFinalSignals: funnelRetest.stages.find((s) => s.stage === "final_signal"),
        note: "Separate retest variant — not combined with immediate baseline"
      },
      C_xauTrendPullbackV1Reference: {
        zero: enrich(v1Zero.trades, v1Zero.metrics),
        observedSpread: enrich(v1Obs.trades, v1Obs.metrics),
        note: "Reference only — xau-trend-pullback-v1 not modified"
      }
    },
    developmentComparisonsObservedSpread: Object.fromEntries(
      Object.entries(comparisons).map(([k, v]) => [
        k,
        {
          ...enrich(v.trades, v.metrics),
          note: "Development-only diagnostic; not selected via holdout"
        }
      ])
    ),
    weekDominanceShare: dominance,
    pooledWeeklyObserved: pooled,
    sampleClassification: verdict.sampleSizeLabel,
    meritsContinuedResearch: verdict.meritsContinuedResearch,
    classificationReasons: verdict.reasons,
    costAssumptions: {
      observedSpreadBps: input.observedSpreadBps,
      spreadStatus: input.spreadStatus,
      note: "ASSUMED_SLIP_* is modeled/hypothetical — never label as empirical"
    },
    safety: {
      nothingDeployed: true,
      xauTrendPullbackV1Untouched: true,
      priorHoldoutNotUsedForSelection: true,
      futureHoldoutNotEvaluated: true,
      notOnMt5Allowlist: true,
      globalRiskUnchanged: true
    }
  };
}
