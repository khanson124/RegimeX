/**
 * Multi-week XAUUSD robustness research (no strategy mutation / no enablement).
 * Segments never bridge maintenance/weekend gaps; each week is an independent backtest.
 */
import { type Candle, type InstrumentMetadata } from "@regimex/shared";
import { CfdBacktester } from "../backtest/cfdBacktester.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "../strategies/squeezeBreakout.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { detectContinuousSegments, sliceSegment } from "./gapSegments.js";
import {
  aggregateContiguousCompletedCandles,
  aggregateContiguousResearchCandles
} from "./candleResample.js";
import { summarizeTrades, sampleSizeFlag, type SplitMetrics } from "./benchmarkMetrics.js";
import { assertNoHoldoutLeakage, splitHoldoutByTimestamp } from "./holdoutSplit.js";
import { XAUUSD_EXPECTED_SESSION_GAP_MS } from "./xauUsdHistoryParity.js";

/** Bridge daily ~60m maintenance; still split weekends (~55h). */
export const XAUUSD_WEEKLY_CONTINUITY_MAX_GAP_MS = 3 * 60 * 60_000;

export const XAUUSD_MIN_USABLE_WEEK_BARS_1M = 500;

export type XauUsdCostProfileId =
  | "ZERO"
  | "OBSERVED_SPREAD_ONLY"
  | "ASSUMED_SLIP_0_10"
  | "ASSUMED_SLIP_0_25"
  | "ASSUMED_SLIP_0_50"
  | "ASSUMED_SLIP_1_00";

export interface XauUsdCostProfile {
  id: XauUsdCostProfileId;
  spreadBps: number;
  slippageBps: number;
  label: "ZERO" | "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST" | "ASSUMED";
}

export function buildXauUsdCostProfiles(observedSpreadBps: number): XauUsdCostProfile[] {
  return [
    { id: "ZERO", spreadBps: 0, slippageBps: 0, label: "ZERO" },
    {
      id: "OBSERVED_SPREAD_ONLY",
      spreadBps: observedSpreadBps,
      slippageBps: 0,
      label: "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST"
    },
    {
      id: "ASSUMED_SLIP_0_10",
      spreadBps: observedSpreadBps,
      slippageBps: 0.1,
      label: "ASSUMED"
    },
    {
      id: "ASSUMED_SLIP_0_25",
      spreadBps: observedSpreadBps,
      slippageBps: 0.25,
      label: "ASSUMED"
    },
    {
      id: "ASSUMED_SLIP_0_50",
      spreadBps: observedSpreadBps,
      slippageBps: 0.5,
      label: "ASSUMED"
    },
    {
      id: "ASSUMED_SLIP_1_00",
      spreadBps: observedSpreadBps,
      slippageBps: 1.0,
      label: "ASSUMED"
    }
  ];
}

export function utcWeekStartMs(epochMs: number): number {
  const d = new Date(epochMs);
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + mondayOffset);
}

export interface XauUsdWeeklySegment {
  segmentId: string;
  weekStartIso: string;
  startOpenTime: number;
  endOpenTime: number;
  startIso: string;
  endIso: string;
  bars1m: number;
  bars5m: number;
  /** Research-only contiguous 15m count (not a production interval). */
  bars15m: number;
  unexpectedGaps: number;
  usable: boolean;
  reason: string;
  candles: Candle[];
}

function countInteriorGaps(candles: ReadonlyArray<Candle>, stepMs: number, expectedClosureMs: number): number {
  let n = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (delta > stepMs + 1_000 && delta < expectedClosureMs) n++;
  }
  return n;
}

/**
 * Inventory weekly research segments from full HISTORY_API series.
 * Continuity max-gap bridges daily maintenance; weekends still split.
 * Calendar week boundaries further split long continuous stretches.
 */
export function inventoryXauUsdWeeklySegments(
  candles: ReadonlyArray<Candle>,
  opts?: {
    continuityMaxGapMs?: number;
    minBars1m?: number;
    expectedClosureGapMs?: number;
  }
): XauUsdWeeklySegment[] {
  const continuityMaxGapMs = opts?.continuityMaxGapMs ?? XAUUSD_WEEKLY_CONTINUITY_MAX_GAP_MS;
  const minBars = opts?.minBars1m ?? XAUUSD_MIN_USABLE_WEEK_BARS_1M;
  const expectedClosureMs = opts?.expectedClosureGapMs ?? XAUUSD_EXPECTED_SESSION_GAP_MS;
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const continuous = detectContinuousSegments(sorted, continuityMaxGapMs);

  const pieces: Candle[][] = [];
  for (const seg of continuous.segments) {
    const slice = sliceSegment(sorted, seg);
    if (slice.length === 0) continue;
    let bucket: Candle[] = [];
    let week = utcWeekStartMs(slice[0]!.openTime);
    for (const c of slice) {
      const w = utcWeekStartMs(c.openTime);
      if (w !== week && bucket.length > 0) {
        pieces.push(bucket);
        bucket = [];
        week = w;
      }
      week = w;
      bucket.push(c);
    }
    if (bucket.length > 0) pieces.push(bucket);
  }

  return pieces.map((cands, i) => {
    const weekStart = utcWeekStartMs(cands[0]!.openTime);
    const weekStartIso = new Date(weekStart).toISOString();
    const five = aggregateContiguousCompletedCandles(cands, "5m");
    const fifteen = aggregateContiguousResearchCandles(cands, "15m");
    const unexpectedGaps = countInteriorGaps(cands, 60_000, expectedClosureMs);
    const usable = cands.length >= minBars && unexpectedGaps === 0;
    let reason = "OK";
    if (cands.length < minBars) reason = `TOO_SHORT_<${minBars}`;
    else if (unexpectedGaps > 0) reason = "UNEXPECTED_INTERIOR_GAPS";
    return {
      segmentId: `W${String(i + 1).padStart(2, "0")}_${weekStartIso.slice(0, 10)}`,
      weekStartIso,
      startOpenTime: cands[0]!.openTime,
      endOpenTime: cands[cands.length - 1]!.openTime,
      startIso: new Date(cands[0]!.openTime).toISOString(),
      endIso: new Date(cands[cands.length - 1]!.openTime).toISOString(),
      bars1m: cands.length,
      bars5m: five.validCount,
      bars15m: fifteen.validCount,
      unexpectedGaps,
      usable,
      reason,
      candles: cands
    };
  });
}

export function xauUsdResearchInstrument(spreadBps: number, slippageBps: number): InstrumentMetadata {
  return {
    symbol: "XAUUSD",
    enabled: true,
    verified: true,
    contractSize: 100,
    volumeStep: 0.01,
    minVolume: 0.01,
    maxVolume: 10,
    tickSize: 0.01,
    tickValue: 1,
    marginRate: 0.01,
    spreadBps,
    slippageBps,
    pricePrecision: 2,
    currency: "USD"
  };
}

async function runStrategyOnCandles(
  candles: ReadonlyArray<Candle>,
  strategyId: "squeeze-breakout-v1" | "ema-pullback-v1",
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const strategy =
    strategyId === "squeeze-breakout-v1"
      ? new SqueezeBreakoutStrategy()
      : new EmaPullbackStrategy();
  const parameters =
    strategyId === "squeeze-breakout-v1"
      ? { ...SQUEEZE_BREAKOUT_DEFAULTS }
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

export interface WeeklyStrategyResult {
  segmentId: string;
  weekStartIso: string;
  strategyId: string;
  costProfileId: XauUsdCostProfileId;
  metrics: SplitMetrics;
}

export async function runWeeklyStrategyMatrix(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  strategyIds: ReadonlyArray<"squeeze-breakout-v1" | "ema-pullback-v1">,
  profiles: ReadonlyArray<XauUsdCostProfile>
): Promise<WeeklyStrategyResult[]> {
  const usable = weeks.filter((w) => w.usable);
  const out: WeeklyStrategyResult[] = [];
  for (const week of usable) {
    for (const strategyId of strategyIds) {
      for (const profile of profiles) {
        const { metrics } = await runStrategyOnCandles(
          week.candles,
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

export interface PooledWeekAggregate {
  weeks: number;
  positiveWeekCount: number;
  positiveWeekPct: number;
  medianWeeklyExpectancyR: number;
  bestWeek: { segmentId: string; expectancyR: number; netR: number } | null;
  worstWeek: { segmentId: string; expectancyR: number; netR: number } | null;
  longestLosingWeekStreak: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancyR: number;
  netR: number;
  buyTrades: number;
  sellTrades: number;
  buyExpectancyR: number | null;
  sellExpectancyR: number | null;
  byRegime: Record<string, { trades: number; expectancyR: number }>;
  sampleSize: ReturnType<typeof sampleSizeFlag>;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function aggregateWeeklyResults(
  rows: ReadonlyArray<WeeklyStrategyResult>,
  strategyId: string,
  costProfileId: XauUsdCostProfileId
): PooledWeekAggregate {
  const weeks = rows
    .filter((r) => r.strategyId === strategyId && r.costProfileId === costProfileId)
    .sort((a, b) => a.weekStartIso.localeCompare(b.weekStartIso));
  const exps = weeks.map((w) => w.metrics.expectancyR);
  const positive = weeks.filter((w) => w.metrics.expectancyR > 0 && w.metrics.trades > 0);
  let streak = 0;
  let longest = 0;
  for (const w of weeks) {
    if (w.metrics.trades > 0 && w.metrics.expectancyR <= 0) {
      streak++;
      longest = Math.max(longest, streak);
    } else streak = 0;
  }
  const totalTrades = weeks.reduce((a, w) => a + w.metrics.trades, 0);
  const wins = weeks.reduce((a, w) => a + w.metrics.wins, 0);
  const losses = weeks.reduce((a, w) => a + w.metrics.losses, 0);
  const netR = weeks.reduce((a, w) => a + w.metrics.netR, 0);
  const grossWinProxy = weeks.reduce(
    (a, w) => a + (w.metrics.averageWinR ?? 0) * w.metrics.wins,
    0
  );
  const grossLossProxy = Math.abs(
    weeks.reduce((a, w) => a + (w.metrics.averageLossR ?? 0) * w.metrics.losses, 0)
  );
  const pf =
    grossLossProxy > 0 ? grossWinProxy / grossLossProxy : grossWinProxy > 0 ? Infinity : null;

  const byRegime = new Map<string, { trades: number; netR: number }>();
  for (const w of weeks) {
    for (const [reg, v] of Object.entries(w.metrics.byRegime)) {
      const cur = byRegime.get(reg) ?? { trades: 0, netR: 0 };
      cur.trades += v.trades;
      cur.netR += v.expectancyR * v.trades;
      byRegime.set(reg, cur);
    }
  }
  const regimeOut: Record<string, { trades: number; expectancyR: number }> = {};
  for (const [k, v] of byRegime) {
    regimeOut[k] = { trades: v.trades, expectancyR: v.trades > 0 ? v.netR / v.trades : 0 };
  }

  const best = [...weeks].sort((a, b) => b.metrics.expectancyR - a.metrics.expectancyR)[0];
  const worst = [...weeks].sort((a, b) => a.metrics.expectancyR - b.metrics.expectancyR)[0];
  const buyTrades = weeks.reduce((a, w) => a + w.metrics.buyTrades, 0);
  const sellTrades = weeks.reduce((a, w) => a + w.metrics.sellTrades, 0);
  const buyNet = weeks.reduce(
    (a, w) => a + (w.metrics.buyExpectancyR ?? 0) * w.metrics.buyTrades,
    0
  );
  const sellNet = weeks.reduce(
    (a, w) => a + (w.metrics.sellExpectancyR ?? 0) * w.metrics.sellTrades,
    0
  );

  return {
    weeks: weeks.length,
    positiveWeekCount: positive.length,
    positiveWeekPct: weeks.length > 0 ? positive.length / weeks.length : 0,
    medianWeeklyExpectancyR: median(exps),
    bestWeek: best
      ? { segmentId: best.segmentId, expectancyR: best.metrics.expectancyR, netR: best.metrics.netR }
      : null,
    worstWeek: worst
      ? {
          segmentId: worst.segmentId,
          expectancyR: worst.metrics.expectancyR,
          netR: worst.metrics.netR
        }
      : null,
    longestLosingWeekStreak: longest,
    totalTrades,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    profitFactor: pf,
    expectancyR: totalTrades > 0 ? netR / totalTrades : 0,
    netR,
    buyTrades,
    sellTrades,
    buyExpectancyR: buyTrades > 0 ? buyNet / buyTrades : null,
    sellExpectancyR: sellTrades > 0 ? sellNet / sellTrades : null,
    byRegime: regimeOut,
    sampleSize: sampleSizeFlag(totalTrades)
  };
}

export interface LeaveOneWeekOutRow {
  leftOutSegmentId: string;
  remainingWeeks: number;
  trades: number;
  expectancyR: number;
  profitFactor: number | null;
  netR: number;
}

export function leaveOneWeekOut(
  rows: ReadonlyArray<WeeklyStrategyResult>,
  strategyId: string,
  costProfileId: XauUsdCostProfileId
): LeaveOneWeekOutRow[] {
  const weeks = rows
    .filter((r) => r.strategyId === strategyId && r.costProfileId === costProfileId)
    .sort((a, b) => a.weekStartIso.localeCompare(b.weekStartIso));
  return weeks.map((left) => {
    const rest = weeks.filter((w) => w.segmentId !== left.segmentId);
    const agg = aggregateWeeklyResults(
      rest.map((w) => ({ ...w })),
      strategyId,
      costProfileId
    );
    return {
      leftOutSegmentId: left.segmentId,
      remainingWeeks: rest.length,
      trades: agg.totalTrades,
      expectancyR: agg.expectancyR,
      profitFactor: agg.profitFactor,
      netR: agg.netR
    };
  });
}

/** Chronological concat of usable weeks (indicators reset each week via separate runs; holdout by time). */
export function chronologicalWeekSplit(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  holdoutWeekFraction = 0.3
): {
  developmentWeeks: XauUsdWeeklySegment[];
  holdoutWeeks: XauUsdWeeklySegment[];
  holdoutStartOpenTime: number | null;
} {
  const usable = weeks.filter((w) => w.usable).sort((a, b) => a.startOpenTime - b.startOpenTime);
  if (usable.length === 0) {
    return { developmentWeeks: [], holdoutWeeks: [], holdoutStartOpenTime: null };
  }
  const holdoutCount = Math.max(1, Math.floor(usable.length * holdoutWeekFraction));
  const cut = Math.max(1, usable.length - holdoutCount);
  const developmentWeeks = usable.slice(0, cut);
  const holdoutWeeks = usable.slice(cut);
  return {
    developmentWeeks,
    holdoutWeeks,
    holdoutStartOpenTime: holdoutWeeks[0]?.startOpenTime ?? null
  };
}

export async function runWeeksPooledMetrics(
  weeks: ReadonlyArray<XauUsdWeeklySegment>,
  strategyId: "squeeze-breakout-v1" | "ema-pullback-v1",
  spreadBps: number,
  slippageBps: number
): Promise<{ metrics: SplitMetrics; trades: CfdSimulatedTrade[] }> {
  const allTrades: CfdSimulatedTrade[] = [];
  for (const w of weeks) {
    const { trades } = await runStrategyOnCandles(w.candles, strategyId, spreadBps, slippageBps);
    allTrades.push(...trades);
  }
  return { metrics: summarizeTrades(allTrades), trades: allTrades };
}

export function hourOfDayBreakdown(trades: ReadonlyArray<CfdSimulatedTrade>): Array<{
  hourUtc: number;
  trades: number;
  expectancyR: number;
  netR: number;
}> {
  const buckets = new Map<number, { n: number; netR: number }>();
  for (const t of trades) {
    const hour = new Date(t.entryTime).getUTCHours();
    const cur = buckets.get(hour) ?? { n: 0, netR: 0 };
    cur.n++;
    cur.netR += t.netR ?? 0;
    buckets.set(hour, cur);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hourUtc, v]) => ({
      hourUtc,
      trades: v.n,
      expectancyR: v.n > 0 ? v.netR / v.n : 0,
      netR: v.netR
    }));
}

export function sessionBucketBreakdown(trades: ReadonlyArray<CfdSimulatedTrade>): Array<{
  session: string;
  trades: number;
  expectancyR: number;
  netR: number;
}> {
  const label = (hour: number): string => {
    if (hour >= 0 && hour < 7) return "ASIA";
    if (hour >= 7 && hour < 12) return "LONDON";
    if (hour >= 12 && hour < 16) return "LONDON_NY_OVERLAP";
    if (hour >= 16 && hour < 21) return "NEW_YORK";
    return "OFF_HOURS";
  };
  const buckets = new Map<string, { n: number; netR: number }>();
  for (const t of trades) {
    const s = label(new Date(t.entryTime).getUTCHours());
    const cur = buckets.get(s) ?? { n: 0, netR: 0 };
    cur.n++;
    cur.netR += t.netR ?? 0;
    buckets.set(s, cur);
  }
  return [...buckets.entries()].map(([session, v]) => ({
    session,
    trades: v.n,
    expectancyR: v.n > 0 ? v.netR / v.n : 0,
    netR: v.netR
  }));
}

function avg(nums: Array<number | null | undefined>): number | null {
  const v = nums.filter((n): n is number => n != null && Number.isFinite(n));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function diagnoseWinningVsLosing(trades: ReadonlyArray<CfdSimulatedTrade>): {
  wins: number;
  losses: number;
  features: Record<string, { winAvg: number | null; lossAvg: number | null }>;
} {
  const wins = trades.filter((t) => t.outcome === "WIN");
  const losses = trades.filter((t) => t.outcome === "LOSS");
  const keys = [
    "adx",
    "atr",
    "atrPercent",
    "bollingerWidth",
    "volatilityPercentile",
    "recentReturn",
    "candleBodySize",
    "distanceFromDonchianHigh",
    "distanceFromDonchianLow"
  ] as const;
  const features: Record<string, { winAvg: number | null; lossAvg: number | null }> = {};
  for (const k of keys) {
    features[k] = {
      winAvg: avg(wins.map((t) => t.entryFeatures?.[k] ?? null)),
      lossAvg: avg(losses.map((t) => t.entryFeatures?.[k] ?? null))
    };
  }
  features.buyShare = {
    winAvg: wins.length ? wins.filter((t) => t.action === "BUY").length / wins.length : null,
    lossAvg: losses.length ? losses.filter((t) => t.action === "BUY").length / losses.length : null
  };
  return { wins: wins.length, losses: losses.length, features };
}

export type OverlapParityVerdict =
  | "MATCH_GOOD"
  | "MATCH_APPROXIMATE"
  | "MATERIAL_MISMATCH"
  | "INSUFFICIENT_OVERLAP";

export function compareOverlappingCandleCloses(
  historical: ReadonlyArray<Candle>,
  live: ReadonlyArray<Candle>,
  opts?: { minPairs?: number }
): {
  verdict: OverlapParityVerdict;
  pairs: number;
  medianAbsCloseDiffPct: number | null;
  meanAbsCloseDiffPct: number | null;
  returnSignAgreement: number | null;
  atrRatio: number | null;
  reasons: string[];
} {
  const minPairs = opts?.minPairs ?? 30;
  const hist = new Map(historical.map((c) => [c.openTime, c]));
  const pairs: Array<{ h: Candle; l: Candle }> = [];
  for (const l of live) {
    const h = hist.get(l.openTime);
    if (h) pairs.push({ h, l });
  }
  if (pairs.length < minPairs) {
    return {
      verdict: "INSUFFICIENT_OVERLAP",
      pairs: pairs.length,
      medianAbsCloseDiffPct: null,
      meanAbsCloseDiffPct: null,
      returnSignAgreement: null,
      atrRatio: null,
      reasons: [`Only ${pairs.length} overlapping timestamps (need ≥${minPairs}).`]
    };
  }
  const diffs = pairs.map((p) => Math.abs(p.h.close - p.l.close) / Math.max(p.l.close, p.h.close));
  const medianDiff = median(diffs);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  let agree = 0;
  let retN = 0;
  for (let i = 1; i < pairs.length; i++) {
    const rh = pairs[i]!.h.close - pairs[i - 1]!.h.close;
    const rl = pairs[i]!.l.close - pairs[i - 1]!.l.close;
    if (rh === 0 && rl === 0) continue;
    retN++;
    if (Math.sign(rh) === Math.sign(rl)) agree++;
  }
  const signAgree = retN > 0 ? agree / retN : null;
  const histRanges = pairs.map((p) => p.h.high - p.h.low);
  const liveRanges = pairs.map((p) => p.l.high - p.l.low);
  const atrRatio =
    avg(liveRanges) && avg(histRanges) ? (avg(histRanges) as number) / (avg(liveRanges) as number) : null;

  let verdict: OverlapParityVerdict;
  const reasons: string[] = [];
  if (medianDiff <= 0.001 && (signAgree ?? 0) >= 0.85) {
    verdict = "MATCH_GOOD";
    reasons.push("Median |close| diff ≤0.1% and return-sign agreement ≥85%.");
  } else if (medianDiff <= 0.01 && (signAgree ?? 0) >= 0.7) {
    verdict = "MATCH_APPROXIMATE";
    reasons.push("Median |close| diff ≤1% and return-sign agreement ≥70%.");
  } else {
    verdict = "MATERIAL_MISMATCH";
    reasons.push("Close/return agreement outside approximate tolerance.");
  }
  return {
    verdict,
    pairs: pairs.length,
    medianAbsCloseDiffPct: medianDiff * 100,
    meanAbsCloseDiffPct: meanDiff * 100,
    returnSignAgreement: signAgree,
    atrRatio,
    reasons
  };
}

export type SqueezeRobustnessClass =
  | "PROMISING_FOR_FORWARD_DEMO_RESEARCH"
  | "TOO_SPARSE"
  | "UNSTABLE"
  | "FEED_PARITY_BLOCKED"
  | "COST_SENSITIVE"
  | "NO_EDGE";

export function classifySqueezeRobustness(input: {
  pooledObserved: PooledWeekAggregate;
  finalHoldoutTrades: number;
  finalHoldoutExpectancyR: number;
  leaveOneOutMinExpectancyR: number;
  positiveWeekPct: number;
  parityVerdict: OverlapParityVerdict | "MATCH_APPROXIMATE" | "MATCH_GOOD" | "MATERIAL_MISMATCH" | "NO_OVERLAP_TO_VERIFY" | "INSUFFICIENT_OVERLAP";
  survivesAssumedSlip025: boolean;
  singleWeekDominates: boolean;
}): { classification: SqueezeRobustnessClass; reasons: string[] } {
  const reasons: string[] = [];
  if (input.parityVerdict === "MATERIAL_MISMATCH") {
    return { classification: "FEED_PARITY_BLOCKED", reasons: ["Feed parity MATERIAL_MISMATCH"] };
  }
  if (input.pooledObserved.totalTrades < 50 && input.finalHoldoutTrades < 50) {
    reasons.push("Sample still sparse (<50 pooled or holdout trades preferred).");
  }
  if (input.pooledObserved.expectancyR <= 0 || (input.pooledObserved.profitFactor ?? 0) <= 1) {
    return {
      classification: "NO_EDGE",
      reasons: ["Pooled observed-spread expectancy≤0 or PF≤1"]
    };
  }
  if (input.positiveWeekPct < 0.5 || input.pooledObserved.positiveWeekCount < 2) {
    return {
      classification: "UNSTABLE",
      reasons: ["Fewer than half of weeks positive or <2 independent positive weeks"]
    };
  }
  if (input.singleWeekDominates || input.leaveOneOutMinExpectancyR <= 0) {
    return {
      classification: "UNSTABLE",
      reasons: ["Result depends on one exceptional week (leave-one-out or dominance)"]
    };
  }
  if (input.finalHoldoutExpectancyR <= 0) {
    return {
      classification: "NO_EDGE",
      reasons: ["Final chronological holdout expectancy ≤ 0"]
    };
  }
  if (!input.survivesAssumedSlip025) {
    return {
      classification: "COST_SENSITIVE",
      reasons: ["Fails under ASSUMED slippage 0.25 bps"]
    };
  }
  if (input.finalHoldoutTrades < 50) {
    reasons.push("Holdout still LOW SAMPLE (<50); promising only for more research, not deploy.");
  }
  if (
    input.pooledObserved.expectancyR > 0 &&
    (input.pooledObserved.profitFactor ?? 0) > 1 &&
    input.positiveWeekPct >= 0.5 &&
    input.finalHoldoutExpectancyR > 0 &&
    !input.singleWeekDominates &&
    input.survivesAssumedSlip025
  ) {
    return {
      classification: "PROMISING_FOR_FORWARD_DEMO_RESEARCH",
      reasons: [
        ...reasons,
        "Multi-week pooled edge, holdout>0, leave-one-out intact, modest assumed slip survived."
      ]
    };
  }
  if (input.finalHoldoutTrades < 20) {
    return { classification: "TOO_SPARSE", reasons: reasons.length ? reasons : ["Too few holdout trades"] };
  }
  return { classification: "UNSTABLE", reasons: reasons.length ? reasons : ["Did not meet PROMISING gate"] };
}

/** Dominance: one week contributes >60% of positive netR. */
export function weekDominanceShare(rows: ReadonlyArray<WeeklyStrategyResult>, strategyId: string, costProfileId: XauUsdCostProfileId): number {
  const weeks = rows.filter((r) => r.strategyId === strategyId && r.costProfileId === costProfileId);
  const positiveNet = weeks.filter((w) => w.metrics.netR > 0);
  const sumPos = positiveNet.reduce((a, w) => a + w.metrics.netR, 0);
  if (sumPos <= 0) return 0;
  const max = Math.max(...positiveNet.map((w) => w.metrics.netR));
  return max / sumPos;
}

export function assertSegmentBoundaryIntegrity(weeks: ReadonlyArray<XauUsdWeeklySegment>): void {
  for (const w of weeks) {
    for (let i = 1; i < w.candles.length; i++) {
      if (w.candles[i]!.openTime <= w.candles[i - 1]!.openTime) {
        throw new Error(`Non-monotonic candles in ${w.segmentId}`);
      }
    }
  }
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i]!.startOpenTime < weeks[i - 1]!.endOpenTime) {
      // weeks may be non-overlapping by construction; allow equal only if separate
      if (weeks[i]!.candles[0] === weeks[i - 1]!.candles.at(-1)) {
        throw new Error("Segment candle identity leak across weeks");
      }
    }
  }
}

export { assertNoHoldoutLeakage, splitHoldoutByTimestamp };
