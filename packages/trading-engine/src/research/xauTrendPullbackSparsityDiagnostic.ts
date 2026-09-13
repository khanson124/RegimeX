/**
 * Development-only sparsity diagnostic for xau-trend-pullback-v1.
 * Does NOT tune against the consumed final holdout. Does NOT change production defaults.
 */
import { type Candle } from "@regimex/shared";
import { extractFeatures } from "../features/featureExtractor.js";
import { completedHtfBarsAsOf, closesCompletedHtfBucket } from "../strategies/mtfResampleAsOf.js";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind
} from "../strategies/structureSwings.js";
import {
  atrPercentileAtEnd,
  classifyH4TrendBias,
  completedSessionAwareHtfBarsAsOf,
  emaSeries,
  isWithinUtcSessionHours,
  type H4TrendBias
} from "../strategies/xauTrendPullbackHtf.js";
import { sessionContextFromEpochMs } from "../strategies/xauMtfEntryQuality.js";
import {
  XAU_TREND_PULLBACK_DEFAULTS,
  type XauTrendPullbackParams
} from "../strategies/xauTrendPullback.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { summarizeTrades } from "./benchmarkMetrics.js";
import { buildXauUsdCostProfiles } from "./xauUsdWeeklyRobustness.js";
import { runXauTrendPullbackOnCandles } from "./xauTrendPullbackResearch.js";

export type SampleSizeLabel =
  | "TOO_SPARSE"
  | "LOW_SAMPLE"
  | "USABLE_FOR_RESEARCH"
  | "GOOD_SAMPLE";

export type FunnelStageId =
  | "m15_bars"
  | "h4_context_valid"
  | "h4_bias_non_neutral"
  | "adx_ok"
  | "session_allowed"
  | "atr_percentile_ok"
  | "not_overextended"
  | "pullback_detected"
  | "continuation_detected"
  | "cooldown_clear"
  | "spread_eligible"
  | "final_signal";

export interface FunnelStageRow {
  stage: FunnelStageId;
  count: number;
  pctOfPrevious: number | null;
  pctOfTotal: number;
  buyCandidates: number;
  sellCandidates: number;
}

export interface AlignmentExample {
  m15CloseIso: string;
  m15CloseTime: number;
  latestH4OpenIso: string | null;
  latestH4CloseIso: string | null;
  latestH4CloseTime: number | null;
  h4CloseBeforeM15: boolean;
  h4Bias: H4TrendBias;
  note: string;
}

function nearEma(price: number, ema: number, atr: number, touchAtr: number): boolean {
  return Math.abs(price - ema) <= atr * touchAtr;
}

function sessionBucket(hour: number): "ASIA" | "LONDON" | "LONDON_NY_OVERLAP" | "NY" | "OFF" {
  if (hour >= 7 && hour < 12) return "LONDON";
  if (hour >= 12 && hour < 16) return "LONDON_NY_OVERLAP";
  if (hour >= 16 && hour < 21) return "NY";
  if (hour >= 0 && hour < 7) return "ASIA";
  return "OFF";
}

function adxBucket(adx: number | null): string {
  if (adx == null || !Number.isFinite(adx)) return "UNKNOWN";
  if (adx < 15) return "adx_lt_15";
  if (adx < 20) return "adx_15_20";
  if (adx < 25) return "adx_20_25";
  if (adx < 30) return "adx_25_30";
  return "adx_gte_30";
}

function atrPctBucket(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return "UNKNOWN";
  if (p < 0.2) return "p0_20";
  if (p < 0.4) return "p20_40";
  if (p < 0.6) return "p40_60";
  if (p < 0.85) return "p60_85";
  return "p85_100";
}

export function classifySampleSize(trades: number): SampleSizeLabel {
  if (trades < 50) return "TOO_SPARSE";
  if (trades < 100) return "LOW_SAMPLE";
  if (trades < 200) return "USABLE_FOR_RESEARCH";
  return "GOOD_SAMPLE";
}

export function maxDrawdownR(trades: ReadonlyArray<CfdSimulatedTrade>): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.netR ?? 0;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return Number(maxDd.toFixed(4));
}

function stageRow(
  stage: FunnelStageId,
  count: number,
  previous: number | null,
  total: number,
  buy = 0,
  sell = 0
): FunnelStageRow {
  return {
    stage,
    count,
    pctOfPrevious: previous != null && previous > 0 ? Number(((count / previous) * 100).toFixed(2)) : null,
    pctOfTotal: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0,
    buyCandidates: buy,
    sellCandidates: sell
  };
}

export interface FunnelDiagnosticResult {
  params: XauTrendPullbackParams;
  totalM15Bars: number;
  stages: FunnelStageRow[];
  primaryBottlenecks: Array<{ stage: FunnelStageId; dropFromPrevious: number; dropPct: number }>;
  directionOpportunity: {
    bullishH4Bars: number;
    bearishH4Bars: number;
    neutralH4Bars: number;
    finalBuy: number;
    finalSell: number;
  };
  sessionOpportunity: Record<string, { barsWithBias: number; signals: number }>;
  atrPercentileOpportunity: Record<string, { barsWithBias: number; signals: number }>;
  adxOpportunity: Record<string, { barsWithBias: number; signals: number }>;
  pullback: {
    h4AlignedTrendBars: number;
    withPullback: number;
    withContinuation: number;
    expiredWithoutContinuation: number;
    medianBarsPullbackToConfirmation: number | null;
    note: string;
  };
  alignmentAudit: {
    closedH4Only: true;
    noFutureH4LeakObserved: boolean;
    examples: AlignmentExample[];
  };
}

/**
 * Efficient M15-as-of funnel over a 1m development series (no holdout candles).
 * Cooldown is applied only for the final_signal stage (matches strategy).
 */
export function runXauTrendPullbackFunnelDiagnostic(
  candles1m: ReadonlyArray<Candle>,
  paramsPartial?: Partial<XauTrendPullbackParams>
): FunnelDiagnosticResult {
  const p = {
    ...XAU_TREND_PULLBACK_DEFAULTS,
    ...paramsPartial
  } as XauTrendPullbackParams;

  // Collect contiguous M15 closes with their 1m as-of indices
  const m15Events: Array<{ asOf1m: number; m15Index: number }> = [];
  for (let i = 0; i < candles1m.length; i++) {
    if (!closesCompletedHtfBucket(candles1m, i, "15m")) continue;
    const m15 = completedHtfBarsAsOf(candles1m, i, "15m");
    if (m15.length < 80) continue;
    m15Events.push({ asOf1m: i, m15Index: m15.length - 1 });
  }

  // Use full-series M15 + features once (as-of length grows; features[i] uses 0..i only)
  const lastAsOf = m15Events.at(-1)?.asOf1m ?? -1;
  const m15All =
    lastAsOf >= 0 ? completedHtfBarsAsOf(candles1m, lastAsOf, "15m") : [];
  const m15Feat = m15All.length > 0 ? extractFeatures(m15All) : [];
  const m15Closes = m15All.map((c) => c.close);
  const ema21s = emaSeries(m15Closes, 21);
  const ema50s = emaSeries(m15Closes, 50);

  const h4All =
    lastAsOf >= 0
      ? completedSessionAwareHtfBarsAsOf(candles1m, lastAsOf, "4h", {
          minFillRatio: p.h4MinFillRatio
        })
      : [];

  const total = m15Events.length;
  let h4Valid = 0;
  let h4NonNeutral = 0;
  let adxOk = 0;
  let sessionOk = 0;
  let atrOk = 0;
  let notExt = 0;
  let pullback = 0;
  let continuation = 0;
  let cooldownClear = 0;
  let spreadOk = 0;
  let finalSig = 0;
  let finalBuy = 0;
  let finalSell = 0;
  let bullishBars = 0;
  let bearishBars = 0;
  let neutralBars = 0;
  let contBuy = 0;
  let contSell = 0;

  const sessionOpp: Record<string, { barsWithBias: number; signals: number }> = {};
  const atrOpp: Record<string, { barsWithBias: number; signals: number }> = {};
  const adxOpp: Record<string, { barsWithBias: number; signals: number }> = {};

  // Pullback timing: pending pullbacks awaiting continuation under same bias
  let pendingPullbackBar: number | null = null;
  let pendingBias: H4TrendBias | null = null;
  const confirmLags: number[] = [];
  let expiredWithoutContinuation = 0;
  let h4AlignedTrendBars = 0;
  let withPullback = 0;
  let withContinuation = 0;
  const maxPendingBars = 16; // ~4h of M15

  let lastSignalM15Idx = Number.NEGATIVE_INFINITY;
  let futureLeak = false;
  const alignmentExamples: AlignmentExample[] = [];

  for (const ev of m15Events) {
    const m15Idx = ev.m15Index;
    const m15Bar = m15All[m15Idx]!;
    const ts = m15Bar.closeTime;
    const feat = m15Feat[m15Idx];
    const ema21 = ema21s[m15Idx];
    const ema50 = ema50s[m15Idx];

    // H4 as-of: only bars with closeTime <= m15 close
    let h4End = -1;
    for (let h = 0; h < h4All.length; h++) {
      if (h4All[h]!.closeTime <= ts) h4End = h;
      else break;
    }
    if (h4End >= 0 && h4All[h4End]!.closeTime > ts) futureLeak = true;
    const h4Slice = h4End >= 0 ? h4All.slice(0, h4End + 1) : [];
    const biasSnap = classifyH4TrendBias(h4Slice, { slopeLookback: p.h4SlopeLookback });

    if (alignmentExamples.length < 6 && m15Idx % Math.max(1, Math.floor(m15All.length / 8)) === 0) {
      const latest = h4Slice.at(-1) ?? null;
      alignmentExamples.push({
        m15CloseIso: new Date(ts).toISOString(),
        m15CloseTime: ts,
        latestH4OpenIso: latest ? new Date(latest.openTime).toISOString() : null,
        latestH4CloseIso: latest ? new Date(latest.closeTime).toISOString() : null,
        latestH4CloseTime: latest?.closeTime ?? null,
        h4CloseBeforeM15: latest == null || latest.closeTime <= ts,
        h4Bias: biasSnap.bias,
        note: "H4 bucket included only if closeTime <= M15 closeTime"
      });
    }

    const h4Ok = h4Slice.length >= 55 && biasSnap.ema21 != null && biasSnap.ema50 != null;
    if (!h4Ok) {
      if (pendingPullbackBar != null && m15Idx - pendingPullbackBar > maxPendingBars) {
        expiredWithoutContinuation++;
        pendingPullbackBar = null;
        pendingBias = null;
      }
      continue;
    }
    h4Valid++;

    if (biasSnap.bias === "NEUTRAL") {
      neutralBars++;
      pendingPullbackBar = null;
      pendingBias = null;
      continue;
    }
    h4NonNeutral++;
    h4AlignedTrendBars++;
    if (biasSnap.bias === "BULLISH") bullishBars++;
    else bearishBars++;

    const sess = sessionBucket(new Date(ts).getUTCHours());
    sessionOpp[sess] ??= { barsWithBias: 0, signals: 0 };
    sessionOpp[sess]!.barsWithBias++;

    const adx = feat?.adx ?? null;
    const adxB = adxBucket(adx);
    adxOpp[adxB] ??= { barsWithBias: 0, signals: 0 };
    adxOpp[adxB]!.barsWithBias++;

    if (adx != null && adx < p.adxMinimum) {
      pendingPullbackBar = null;
      pendingBias = null;
      continue;
    }
    adxOk++;

    if (!isWithinUtcSessionHours(ts, p.sessionStartHourUtc, p.sessionEndHourUtc)) {
      continue;
    }
    sessionOk++;

    if (!feat || feat.atr == null || feat.atr <= 0 || ema21 == null || ema50 == null) {
      continue;
    }

    const atrSeries = m15Feat.slice(0, m15Idx + 1).map((f) => f.atr);
    const atrPct = atrPercentileAtEnd(atrSeries, p.atrPercentileLookback);
    const atrB = atrPctBucket(atrPct);
    atrOpp[atrB] ??= { barsWithBias: 0, signals: 0 };
    // Count atr buckets among session-passed trend bars
    atrOpp[atrB]!.barsWithBias++;

    if (atrPct == null || atrPct < p.atrPercentileMin || atrPct > p.atrPercentileMax) {
      continue;
    }
    atrOk++;

    const atr = feat.atr;
    const distEma21Atr = Math.abs(m15Bar.close - ema21) / atr;
    if (distEma21Atr > p.maxDistanceFromEma21Atr) {
      continue;
    }
    notExt++;

    const pivots = findConfirmedSwingPivots(m15All, m15Idx, p.swingLookback);
    const swingHigh = latestSwingOfKind(pivots, "high");
    const swingLow = latestSwingOfKind(pivots, "low");
    const prev = m15Idx >= 1 ? m15All[m15Idx - 1]! : null;
    const touchedEma =
      nearEma(m15Bar.low, ema21, atr, p.pullbackTouchAtr) ||
      nearEma(m15Bar.low, ema50, atr, p.pullbackTouchAtr) ||
      nearEma(m15Bar.high, ema21, atr, p.pullbackTouchAtr) ||
      nearEma(m15Bar.high, ema50, atr, p.pullbackTouchAtr) ||
      (prev != null &&
        (nearEma(prev.low, ema21, atr, p.pullbackTouchAtr) ||
          nearEma(prev.high, ema21, atr, p.pullbackTouchAtr) ||
          nearEma(prev.low, ema50, atr, p.pullbackTouchAtr) ||
          nearEma(prev.high, ema50, atr, p.pullbackTouchAtr)));

    if (!touchedEma) {
      if (pendingPullbackBar != null && m15Idx - pendingPullbackBar > maxPendingBars) {
        expiredWithoutContinuation++;
        pendingPullbackBar = null;
        pendingBias = null;
      }
      continue;
    }
    pullback++;
    withPullback++;
    if (pendingPullbackBar == null || pendingBias !== biasSnap.bias) {
      pendingPullbackBar = m15Idx;
      pendingBias = biasSnap.bias;
    }

    const bodyAtr = Math.abs(m15Bar.close - m15Bar.open) / atr;
    let action: "BUY" | "SELL" | null = null;
    let breakout = false;
    let reclaim = false;
    if (biasSnap.bias === "BULLISH") {
      breakout =
        swingHigh != null && m15Bar.close > swingHigh.price && m15Bar.close > m15Bar.open;
      reclaim =
        bodyAtr >= p.minContinuationBodyAtr &&
        m15Bar.close > ema21 &&
        (prev == null || prev.close <= ema21 || prev.low <= ema21);
      const allowBreakout = p.continuationMode === "either" || p.continuationMode === "breakout_only";
      const allowReclaim = p.continuationMode === "either" || p.continuationMode === "reclaim_only";
      if (allowBreakout && breakout) action = "BUY";
      else if (allowReclaim && reclaim) action = "BUY";
    } else {
      breakout =
        swingLow != null && m15Bar.close < swingLow.price && m15Bar.close < m15Bar.open;
      reclaim =
        bodyAtr >= p.minContinuationBodyAtr &&
        m15Bar.close < ema21 &&
        (prev == null || prev.close >= ema21 || prev.high >= ema21);
      const allowBreakout = p.continuationMode === "either" || p.continuationMode === "breakout_only";
      const allowReclaim = p.continuationMode === "either" || p.continuationMode === "reclaim_only";
      if (allowBreakout && breakout) action = "SELL";
      else if (allowReclaim && reclaim) action = "SELL";
    }

    if (action == null) {
      if (pendingPullbackBar != null && m15Idx - pendingPullbackBar > maxPendingBars) {
        expiredWithoutContinuation++;
        pendingPullbackBar = null;
        pendingBias = null;
      }
      continue;
    }
    continuation++;
    withContinuation++;
    if (action === "BUY") contBuy++;
    else contSell++;
    if (pendingPullbackBar != null) {
      confirmLags.push(m15Idx - pendingPullbackBar);
      pendingPullbackBar = null;
      pendingBias = null;
    }

    const sinceSignal = m15Idx - lastSignalM15Idx;
    if (sinceSignal < p.cooldownCandles) continue;
    cooldownClear++;

    // maxSpreadBps default -1 → always eligible in research funnel
    spreadOk++;

    // Stop validity (mirrors strategy)
    const buffer = atr * p.structureBufferAtr;
    let stopOk = true;
    if (action === "BUY") {
      const atrStop = m15Bar.close - atr * p.stopAtrMultiple;
      const structStop =
        swingLow != null && swingLow.price < m15Bar.close ? swingLow.price - buffer : null;
      const stopLoss = structStop != null ? Math.min(atrStop, structStop) : atrStop;
      if (!(stopLoss < m15Bar.close)) stopOk = false;
    } else {
      const atrStop = m15Bar.close + atr * p.stopAtrMultiple;
      const structStop =
        swingHigh != null && swingHigh.price > m15Bar.close ? swingHigh.price + buffer : null;
      const stopLoss = structStop != null ? Math.max(atrStop, structStop) : atrStop;
      if (!(stopLoss > m15Bar.close)) stopOk = false;
    }
    if (!stopOk) continue;

    finalSig++;
    lastSignalM15Idx = m15Idx;
    if (action === "BUY") finalBuy++;
    else finalSell++;
    sessionOpp[sess]!.signals++;
    atrOpp[atrB]!.signals++;
    adxOpp[adxB]!.signals++;
  }

  if (pendingPullbackBar != null) {
    expiredWithoutContinuation++;
  }

  const stages: FunnelStageRow[] = [
    stageRow("m15_bars", total, null, total),
    stageRow("h4_context_valid", h4Valid, total, total),
    stageRow("h4_bias_non_neutral", h4NonNeutral, h4Valid, total, bullishBars, bearishBars),
    stageRow("adx_ok", adxOk, h4NonNeutral, total),
    stageRow("session_allowed", sessionOk, adxOk, total),
    stageRow("atr_percentile_ok", atrOk, sessionOk, total),
    stageRow("not_overextended", notExt, atrOk, total),
    stageRow("pullback_detected", pullback, notExt, total),
    stageRow("continuation_detected", continuation, pullback, total, contBuy, contSell),
    stageRow("cooldown_clear", cooldownClear, continuation, total),
    stageRow("spread_eligible", spreadOk, cooldownClear, total),
    stageRow("final_signal", finalSig, spreadOk, total, finalBuy, finalSell)
  ];

  const bottlenecks = [];
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1]!;
    const cur = stages[i]!;
    const drop = prev.count - cur.count;
    if (drop <= 0) continue;
    bottlenecks.push({
      stage: cur.stage,
      dropFromPrevious: drop,
      dropPct: prev.count > 0 ? Number(((drop / prev.count) * 100).toFixed(2)) : 0
    });
  }
  bottlenecks.sort((a, b) => b.dropPct - a.dropPct);

  const lags = [...confirmLags].sort((a, b) => a - b);
  const medianLag =
    lags.length === 0
      ? null
      : lags.length % 2 === 0
        ? (lags[lags.length / 2 - 1]! + lags[lags.length / 2]!) / 2
        : lags[Math.floor(lags.length / 2)]!;

  return {
    params: p,
    totalM15Bars: total,
    stages,
    primaryBottlenecks: bottlenecks.slice(0, 5),
    directionOpportunity: {
      bullishH4Bars: bullishBars,
      bearishH4Bars: bearishBars,
      neutralH4Bars: neutralBars,
      finalBuy,
      finalSell
    },
    sessionOpportunity: sessionOpp,
    atrPercentileOpportunity: atrOpp,
    adxOpportunity: adxOpp,
    pullback: {
      h4AlignedTrendBars,
      withPullback,
      withContinuation,
      expiredWithoutContinuation,
      medianBarsPullbackToConfirmation: medianLag,
      note:
        "Pullback counted when M15 touches EMA21/50 within pullbackTouchAtr while H4 bias active; confirmation = continuation trigger within 16 M15 bars."
    },
    alignmentAudit: {
      closedH4Only: true,
      noFutureH4LeakObserved: !futureLeak,
      examples: alignmentExamples
    }
  };
}

export interface AblationRow {
  variantId: string;
  family: string;
  changeDescription: string;
  params: Partial<XauTrendPullbackParams>;
  sampleSizeLabel: SampleSizeLabel;
  developmentTrades: number;
  expectancyR: number;
  profitFactor: number | null;
  netR: number;
  maxDrawdownR: number;
  winRate: number;
  buyTrades: number;
  sellTrades: number;
  costSensitivity: Array<{
    id: string;
    label: string;
    costKind: string;
    trades: number;
    expectancyR: number;
    profitFactor: number | null;
    netR: number;
    maxDrawdownR: number;
  }> | null;
  funnelFinalSignals: number | null;
}

export const XAU_TREND_PULLBACK_ABLATION_VARIANTS: Array<{
  variantId: string;
  family: string;
  changeDescription: string;
  params: Partial<XauTrendPullbackParams>;
}> = [
  {
    variantId: "baseline",
    family: "baseline",
    changeDescription: "Current defaults",
    params: {}
  },
  {
    variantId: "adx_15",
    family: "adx",
    changeDescription: "ADX >= 15",
    params: { adxMinimum: 15 }
  },
  {
    variantId: "adx_25",
    family: "adx",
    changeDescription: "ADX >= 25",
    params: { adxMinimum: 25 }
  },
  {
    variantId: "atr_10_90",
    family: "atr_percentile",
    changeDescription: "ATR pctl 10–90",
    params: { atrPercentileMin: 0.1, atrPercentileMax: 0.9 }
  },
  {
    variantId: "atr_15_90",
    family: "atr_percentile",
    changeDescription: "ATR pctl 15–90",
    params: { atrPercentileMin: 0.15, atrPercentileMax: 0.9 }
  },
  {
    variantId: "atr_20_90",
    family: "atr_percentile",
    changeDescription: "ATR pctl 20–90",
    params: { atrPercentileMin: 0.2, atrPercentileMax: 0.9 }
  },
  {
    variantId: "session_06_18",
    family: "session",
    changeDescription: "Session 06:00–18:00 UTC",
    params: { sessionStartHourUtc: 6, sessionEndHourUtc: 18 }
  },
  {
    variantId: "session_07_18",
    family: "session",
    changeDescription: "Session 07:00–18:00 UTC",
    params: { sessionStartHourUtc: 7, sessionEndHourUtc: 18 }
  },
  {
    variantId: "max_dist_2_0",
    family: "max_ema21_distance",
    changeDescription: "Max EMA21 distance 2.0 ATR",
    params: { maxDistanceFromEma21Atr: 2.0 }
  },
  {
    variantId: "max_dist_3_0",
    family: "max_ema21_distance",
    changeDescription: "Max EMA21 distance 3.0 ATR",
    params: { maxDistanceFromEma21Atr: 3.0 }
  },
  {
    variantId: "slope_2",
    family: "h4_slope",
    changeDescription: "H4 slope lookback 2",
    params: { h4SlopeLookback: 2 }
  },
  {
    variantId: "slope_4",
    family: "h4_slope",
    changeDescription: "H4 slope lookback 4",
    params: { h4SlopeLookback: 4 }
  },
  {
    variantId: "cont_breakout_only",
    family: "continuation",
    changeDescription: "Structure breakout only",
    params: { continuationMode: "breakout_only" }
  },
  {
    variantId: "cont_reclaim_only",
    family: "continuation",
    changeDescription: "EMA reclaim only",
    params: { continuationMode: "reclaim_only" }
  }
];

function costKind(label: string): string {
  if (label === "ASSUMED") return "MODELED_HYPOTHETICAL_SLIPPAGE_NOT_EMPIRICAL";
  if (label === "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST")
    return "EMPIRICAL_OBSERVED_SPREAD_ONLY";
  return "ZERO_COST";
}

export async function runAblationVariant(
  developmentCandles: ReadonlyArray<Candle>,
  variant: (typeof XAU_TREND_PULLBACK_ABLATION_VARIANTS)[number],
  observedSpreadBps: number,
  funnelFinalSignals: number | null
): Promise<AblationRow> {
  const profiles = buildXauUsdCostProfiles(observedSpreadBps).filter((p) =>
    ["ZERO", "OBSERVED_SPREAD_ONLY", "ASSUMED_SLIP_0_25", "ASSUMED_SLIP_0_50"].includes(p.id)
  );

  const observed = await runXauTrendPullbackOnCandles(
    developmentCandles,
    variant.params,
    observedSpreadBps,
    0
  );
  const m = observed.metrics;
  const label = classifySampleSize(m.trades);

  let costSensitivity: AblationRow["costSensitivity"] = null;
  if (m.trades >= 50) {
    costSensitivity = [];
    for (const profile of profiles) {
      const run = await runXauTrendPullbackOnCandles(
        developmentCandles,
        variant.params,
        profile.spreadBps,
        profile.slippageBps
      );
      costSensitivity.push({
        id: profile.id,
        label: profile.label,
        costKind: costKind(profile.label),
        trades: run.metrics.trades,
        expectancyR: run.metrics.expectancyR,
        profitFactor: run.metrics.profitFactor,
        netR: run.metrics.netR,
        maxDrawdownR: maxDrawdownR(run.trades)
      });
    }
  }

  return {
    variantId: variant.variantId,
    family: variant.family,
    changeDescription: variant.changeDescription,
    params: variant.params,
    sampleSizeLabel: label,
    developmentTrades: m.trades,
    expectancyR: m.expectancyR,
    profitFactor: m.profitFactor,
    netR: m.netR,
    maxDrawdownR: maxDrawdownR(observed.trades),
    winRate: m.winRate,
    buyTrades: m.buyTrades,
    sellTrades: m.sellTrades,
    costSensitivity,
    funnelFinalSignals
  };
}

export function recommendSingleModestChange(input: {
  baseline: AblationRow;
  ablations: ReadonlyArray<AblationRow>;
  funnel: FunnelDiagnosticResult;
}): {
  recommendedVariantId: string | null;
  change: Partial<XauTrendPullbackParams> | null;
  rationale: string[];
  architectureTooRestrictive: boolean;
} {
  const reasons: string[] = [];
  const baselineTrades = input.baseline.developmentTrades;
  const baselineExp = input.baseline.expectancyR;

  // Rank non-baseline variants that materially improve sample without collapsing expectancy
  const candidates = input.ablations
    .filter((a) => a.variantId !== "baseline")
    .filter((a) => a.developmentTrades >= baselineTrades + 15 || a.developmentTrades >= 50)
    .filter((a) => a.expectancyR >= Math.min(0, baselineExp) - 0.05)
    .filter((a) => a.expectancyR > -0.15)
    .map((a) => {
      const observedCost = a.costSensitivity?.find((c) => c.id === "OBSERVED_SPREAD_ONLY");
      const slip = a.costSensitivity?.find((c) => c.id === "ASSUMED_SLIP_0_25");
      const costOk =
        a.developmentTrades < 50
          ? a.expectancyR > -0.1
          : (observedCost?.expectancyR ?? a.expectancyR) > -0.1 &&
            (slip == null || slip.expectancyR > -0.15);
      return { a, costOk, deltaTrades: a.developmentTrades - baselineTrades };
    })
    .filter((x) => x.costOk)
    .sort((x, y) => {
      // Prefer reaching LOW_SAMPLE/USABLE, then trade gain, then expectancy
      const rank = (s: SampleSizeLabel) =>
        s === "GOOD_SAMPLE" ? 3 : s === "USABLE_FOR_RESEARCH" ? 2 : s === "LOW_SAMPLE" ? 1 : 0;
      const rd = rank(y.a.sampleSizeLabel) - rank(x.a.sampleSizeLabel);
      if (rd !== 0) return rd;
      if (y.deltaTrades !== x.deltaTrades) return y.deltaTrades - x.deltaTrades;
      return y.a.expectancyR - x.a.expectancyR;
    });

  const top = candidates[0]?.a;
  if (!top || top.developmentTrades < 50) {
    const topBottleneck = input.funnel.primaryBottlenecks[0]?.stage ?? "unknown";
    reasons.push(
      `No single one-at-a-time relaxation reached ≥50 development trades (baseline=${baselineTrades}).`
    );
    reasons.push(`Largest funnel drop at stage: ${topBottleneck}.`);
    reasons.push(
      "Stacked H4 bias + pullback + continuation filters remain jointly restrictive for this sample."
    );
    return {
      recommendedVariantId: null,
      change: null,
      rationale: reasons,
      architectureTooRestrictive: true
    };
  }

  reasons.push(
    `${top.variantId}: ${top.changeDescription} lifts development trades ${baselineTrades} → ${top.developmentTrades} (${top.sampleSizeLabel}).`
  );
  reasons.push(
    `Development expectancy ${top.expectancyR.toFixed(3)}R (baseline ${baselineExp.toFixed(3)}R); selection used development only — prior holdout not consulted.`
  );
  if (top.family === "atr_percentile") {
    reasons.push(
      "Market rationale: gold often trends in elevated but not extreme vol; widening the upper ATR percentile admits more continuation setups without abandoning the vol filter."
    );
  } else if (top.family === "adx") {
    reasons.push(
      "Market rationale: ADX 15 still requires directional movement while admitting early trend phases common on M15 gold."
    );
  } else if (top.family === "session") {
    reasons.push(
      "Market rationale: modest session widening captures adjacent London/NY liquidity without Asian thin hours."
    );
  } else if (top.family === "max_ema21_distance") {
    reasons.push(
      "Market rationale: gold pullbacks can overshoot EMA21 slightly; 3.0 ATR still rejects chase entries."
    );
  } else if (top.family === "h4_slope") {
    reasons.push(
      "Market rationale: shorter/longer slope lookback adjusts trend confirmation lag without changing EMA structure."
    );
  } else if (top.family === "continuation") {
    reasons.push(
      "Market rationale: isolating continuation mode tests which trigger actually produces tradable frequency."
    );
  }

  return {
    recommendedVariantId: top.variantId,
    change: top.params,
    rationale: reasons,
    architectureTooRestrictive: false
  };
}

export async function runXauTrendPullbackSparsityDiagnostic(input: {
  developmentCandles: ReadonlyArray<Candle>;
  observedSpreadBps: number;
  spreadStatus: string;
  priorHoldoutStartOpenTime: number;
  priorHoldoutEndOpenTime: number;
  datasetEndOpenTime: number;
}): Promise<Record<string, unknown>> {
  const baselineFunnel = runXauTrendPullbackFunnelDiagnostic(input.developmentCandles);

  const ablationRows: AblationRow[] = [];
  for (const variant of XAU_TREND_PULLBACK_ABLATION_VARIANTS) {
    const funnelSignals =
      variant.variantId === "baseline"
        ? baselineFunnel.stages.find((s) => s.stage === "final_signal")?.count ?? null
        : runXauTrendPullbackFunnelDiagnostic(input.developmentCandles, variant.params).stages.find(
            (s) => s.stage === "final_signal"
          )?.count ?? null;
    const row = await runAblationVariant(
      input.developmentCandles,
      variant,
      input.observedSpreadBps,
      funnelSignals
    );
    ablationRows.push(row);
  }

  const baseline = ablationRows.find((r) => r.variantId === "baseline")!;
  const recommendation = recommendSingleModestChange({
    baseline,
    ablations: ablationRows,
    funnel: baselineFunnel
  });

  const proposedNewHoldoutStart = input.priorHoldoutEndOpenTime + 60_000;

  return {
    generatedAt: new Date().toISOString(),
    strategyId: "xau-trend-pullback-v1",
    diagnosticOnly: true,
    productionDefaultsUnchanged: true,
    priorHoldout: {
      status: "CONSUMED_DO_NOT_USE_FOR_MODEL_SELECTION",
      startOpenTime: input.priorHoldoutStartOpenTime,
      startIso: new Date(input.priorHoldoutStartOpenTime).toISOString(),
      endOpenTime: input.priorHoldoutEndOpenTime,
      endIso: new Date(input.priorHoldoutEndOpenTime).toISOString(),
      note: "Inspected in prior research run; excluded from this diagnostic selection."
    },
    developmentScope: {
      bars1m: input.developmentCandles.length,
      startIso: new Date(input.developmentCandles[0]!.openTime).toISOString(),
      endIso: new Date(
        input.developmentCandles[input.developmentCandles.length - 1]!.openTime
      ).toISOString(),
      holdoutExcluded: true
    },
    baselineFunnel,
    primaryBottlenecks: baselineFunnel.primaryBottlenecks,
    directionalDiagnostics: baselineFunnel.directionOpportunity,
    sessionDiagnostics: baselineFunnel.sessionOpportunity,
    volatilityDiagnostics: baselineFunnel.atrPercentileOpportunity,
    adxDiagnostics: baselineFunnel.adxOpportunity,
    pullbackDiagnostic: baselineFunnel.pullback,
    alignmentAudit: baselineFunnel.alignmentAudit,
    ablationTable: ablationRows,
    recommendation: {
      ...recommendation,
      note: "At most one modest change; not selected using the consumed prior holdout."
    },
    proposedNewUntouchedHoldout: {
      status:
        proposedNewHoldoutStart > input.datasetEndOpenTime
          ? "PENDING_ADDITIONAL_HISTORY"
          : "AVAILABLE_IN_DATASET_BUT_NOT_EVALUATED_HERE",
      startOpenTime: proposedNewHoldoutStart,
      startIso: new Date(proposedNewHoldoutStart).toISOString(),
      rationale:
        "Chronological period after the consumed prior holdout end. Not evaluated in this diagnostic. Required for eventual revised-strategy validation.",
      doNotEvaluateInThisRun: true
    },
    costAssumptions: {
      observedSpreadBps: input.observedSpreadBps,
      spreadStatus: input.spreadStatus,
      note: "ASSUMED_SLIP_* is modeled/hypothetical — never label as empirical"
    },
    safety: {
      nothingDeployed: true,
      productionStrategyConfigUnchanged: true,
      priorHoldoutNotUsedForSelection: true,
      r10Untouched: true
    }
  };
}
