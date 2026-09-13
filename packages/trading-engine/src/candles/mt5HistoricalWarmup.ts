/**
 * broker_demo_mt5 historical warm-up via MT5 getBars / CopyRates.
 * Converts research Mt5Bar rows (source "MT5") into live Candle rows (MT5_HISTORY).
 */
import {
  intervalMs,
  type Candle,
  type CandleInterval,
  type CandleSource
} from "@regimex/shared";
import {
  BROKER_SYMBOL_MAPPING_MISSING,
  BROKER_SYMBOL_MAPPING_UNVERIFIED,
  resolveBrokerSymbolMapping,
  type BrokerSymbolMappingRecord
} from "../broker/mt5/brokerSymbolMapping.js";
import { type Mt5Bar, type Mt5BarTimeframe } from "../broker/mt5/types.js";
import {
  fetchRecentMt5Bars,
  timeframeMs,
  type Mt5BarsClient
} from "../research/mt5BarsFetcher.js";
import {
  countMt5ProvenanceSources,
  filterRestorableMt5Candles,
  isMt5MarketDataReady,
  mergeMt5TrustedCandles,
  type Mt5WarmupRequirement
} from "./mt5MarketData.js";

/** Extra completed bars requested beyond the deficit for overlap reconciliation. */
export const MT5_WARMUP_FETCH_OVERLAP_BARS = 10;

export const MT5_WARMUP_INTERVAL_UNSUPPORTED = "MT5_WARMUP_INTERVAL_UNSUPPORTED";
export const MT5_WARMUP_MAPPING_REQUIRED = "MT5_WARMUP_MAPPING_REQUIRED";
export const MT5_WARMUP_DEMO_REQUIRED = "MT5_WARMUP_DEMO_REQUIRED";
export const MT5_WARMUP_INSUFFICIENT_HISTORY = "MT5_WARMUP_INSUFFICIENT_HISTORY";
export const MT5_WARMUP_FETCH_FAILED = "MT5_WARMUP_FETCH_FAILED";
export const MT5_WARMUP_MERGE_REJECTED = "MT5_WARMUP_MERGE_REJECTED";

export function candleIntervalToMt5BarTimeframe(
  interval: CandleInterval | string
): Mt5BarTimeframe | null {
  if (interval === "1m" || interval === "5m" || interval === "15m") return interval;
  return null;
}

export function mt5BarToHistoryCandle(input: {
  bar: Mt5Bar;
  engineSymbol: string;
  interval: CandleInterval;
}): Candle {
  const { bar, engineSymbol, interval } = input;
  return {
    symbol: engineSymbol,
    interval,
    openTime: bar.openTimeMs,
    closeTime: bar.closeTimeMs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    tickCount: bar.tickVolume ?? 0,
    isComplete: true,
    source: "MT5_HISTORY"
  };
}

export function computeMt5WarmupFetchCount(input: {
  requiredBars: number;
  persistedTrustedBars: number;
  overlapBars?: number;
}): { missing: number; fetchCount: number; needsFetch: boolean } {
  const overlap = input.overlapBars ?? MT5_WARMUP_FETCH_OVERLAP_BARS;
  const missing = Math.max(0, input.requiredBars - input.persistedTrustedBars);
  if (missing === 0) {
    return { missing: 0, fetchCount: 0, needsFetch: false };
  }
  // Fetch a coherent recent window covering the full requirement (+ overlap),
  // not only the deficit — avoids holes between old persisted and new history.
  const fetchCount = input.requiredBars + overlap;
  return { missing, fetchCount, needsFetch: true };
}

export function shouldPersistMt5HistoryCandle(existingSource: CandleSource | null | undefined): boolean {
  if (existingSource == null) return true;
  if (existingSource === "MT5_LIVE_TICKS") return false; // never downgrade
  if (existingSource === "MT5_HISTORY") return true;
  return false; // do not overwrite Deriv/other provenance via history path
}

export interface Mt5HistoricalWarmupPlan {
  status: "SKIP" | "FETCH" | "BLOCKED";
  reason: string | null;
  requiredBars: number;
  persistedTrustedBars: number;
  missing: number;
  fetchCount: number;
  timeframe: Mt5BarTimeframe | null;
  brokerSymbol: string | null;
}

export function planMt5HistoricalWarmup(input: {
  requirement: Mt5WarmupRequirement;
  persistedCandles: readonly Candle[];
  interval: CandleInterval | string;
  engineSymbol: string;
  mapping: BrokerSymbolMappingRecord | null | undefined;
  isDemoAccount: boolean;
}): Mt5HistoricalWarmupPlan {
  if (input.requirement.status === "NO_ELIGIBLE_STRATEGIES") {
    return {
      status: "BLOCKED",
      reason: input.requirement.reason,
      requiredBars: 0,
      persistedTrustedBars: input.persistedCandles.length,
      missing: 0,
      fetchCount: 0,
      timeframe: null,
      brokerSymbol: null
    };
  }

  const requiredBars = input.requirement.requiredBars;
  const timeframe = candleIntervalToMt5BarTimeframe(input.interval);
  if (!timeframe) {
    return {
      status: "BLOCKED",
      reason: MT5_WARMUP_INTERVAL_UNSUPPORTED,
      requiredBars,
      persistedTrustedBars: input.persistedCandles.length,
      missing: Math.max(0, requiredBars - input.persistedCandles.length),
      fetchCount: 0,
      timeframe: null,
      brokerSymbol: null
    };
  }

  if (!input.isDemoAccount) {
    return {
      status: "BLOCKED",
      reason: MT5_WARMUP_DEMO_REQUIRED,
      requiredBars,
      persistedTrustedBars: input.persistedCandles.length,
      missing: Math.max(0, requiredBars - input.persistedCandles.length),
      fetchCount: 0,
      timeframe,
      brokerSymbol: null
    };
  }

  if (!input.mapping) {
    return {
      status: "BLOCKED",
      reason: BROKER_SYMBOL_MAPPING_MISSING,
      requiredBars,
      persistedTrustedBars: input.persistedCandles.length,
      missing: Math.max(0, requiredBars - input.persistedCandles.length),
      fetchCount: 0,
      timeframe,
      brokerSymbol: null
    };
  }

  const mappingResolved = resolveBrokerSymbolMapping(input.engineSymbol, input.mapping);
  if (!mappingResolved.ok || !mappingResolved.brokerSymbol) {
    return {
      status: "BLOCKED",
      reason: mappingResolved.reasonCode ?? BROKER_SYMBOL_MAPPING_UNVERIFIED,
      requiredBars,
      persistedTrustedBars: input.persistedCandles.length,
      missing: Math.max(0, requiredBars - input.persistedCandles.length),
      fetchCount: 0,
      timeframe,
      brokerSymbol: null
    };
  }

  const counts = computeMt5WarmupFetchCount({
    requiredBars,
    persistedTrustedBars: input.persistedCandles.length
  });

  if (!counts.needsFetch) {
    return {
      status: "SKIP",
      reason: null,
      requiredBars,
      persistedTrustedBars: input.persistedCandles.length,
      missing: 0,
      fetchCount: 0,
      timeframe,
      brokerSymbol: mappingResolved.brokerSymbol
    };
  }

  return {
    status: "FETCH",
    reason: null,
    requiredBars,
    persistedTrustedBars: input.persistedCandles.length,
    missing: counts.missing,
    fetchCount: counts.fetchCount,
    timeframe,
    brokerSymbol: mappingResolved.brokerSymbol
  };
}

export interface Mt5HistoricalWarmupResult {
  status: "READY" | "BLOCKED" | "SKIPPED";
  reason: string | null;
  candles: Candle[];
  plan: Mt5HistoricalWarmupPlan;
  fetchedBars: number;
  requestedBars: number;
  sourceMix: { history: number; liveTicks: number };
  firstOpenTime: number | null;
  lastCloseTime: number | null;
  historyCandlesToPersist: Candle[];
}

/**
 * Pure merge + readiness after a getBars fetch (completed bars only).
 * Does not touch the network or DB.
 */
export function assembleMt5HistoricalWarmup(input: {
  plan: Mt5HistoricalWarmupPlan;
  requirement: Mt5WarmupRequirement;
  persistedCandles: readonly Candle[];
  fetchedBars: readonly Mt5Bar[];
  engineSymbol: string;
  interval: CandleInterval;
}): Mt5HistoricalWarmupResult {
  const { plan, requirement, persistedCandles, fetchedBars, engineSymbol, interval } = input;

  if (plan.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      reason: plan.reason,
      candles: [...persistedCandles],
      plan,
      fetchedBars: 0,
      requestedBars: 0,
      sourceMix: countMt5ProvenanceSources(persistedCandles),
      firstOpenTime: persistedCandles[0]?.openTime ?? null,
      lastCloseTime: persistedCandles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }

  if (plan.status === "SKIP") {
    const ready = isMt5MarketDataReady(persistedCandles, requirement);
    return {
      status: ready.ready ? "READY" : "BLOCKED",
      reason: ready.reason,
      candles: [...persistedCandles],
      plan,
      fetchedBars: 0,
      requestedBars: 0,
      sourceMix: countMt5ProvenanceSources(persistedCandles),
      firstOpenTime: persistedCandles[0]?.openTime ?? null,
      lastCloseTime: persistedCandles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }

  const historyFromFetch = fetchedBars
    .filter((b) => b.isComplete && b.source === "MT5")
    .map((bar) => mt5BarToHistoryCandle({ bar, engineSymbol, interval }));

  // Enforce completed-only: drop any bar whose close is still in the future
  const now = Date.now();
  const completedHistory = historyFromFetch.filter((c) => c.closeTime <= now);

  const live = persistedCandles.filter((c) => c.source === "MT5_LIVE_TICKS");
  const priorHistory = persistedCandles.filter((c) => c.source === "MT5_HISTORY");
  const mergedHistory = mergeMt5TrustedCandles({
    history: [...priorHistory, ...completedHistory],
    live: []
  });
  if (mergedHistory.rejected) {
    return {
      status: "BLOCKED",
      reason: mergedHistory.reason ?? MT5_WARMUP_MERGE_REJECTED,
      candles: [...persistedCandles],
      plan,
      fetchedBars: completedHistory.length,
      requestedBars: plan.fetchCount,
      sourceMix: countMt5ProvenanceSources(persistedCandles),
      firstOpenTime: persistedCandles[0]?.openTime ?? null,
      lastCloseTime: persistedCandles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }

  const merged = mergeMt5TrustedCandles({
    history: mergedHistory.candles,
    live
  });
  if (merged.rejected) {
    return {
      status: "BLOCKED",
      reason: merged.reason ?? MT5_WARMUP_MERGE_REJECTED,
      candles: [...persistedCandles],
      plan,
      fetchedBars: completedHistory.length,
      requestedBars: plan.fetchCount,
      sourceMix: countMt5ProvenanceSources(persistedCandles),
      firstOpenTime: persistedCandles[0]?.openTime ?? null,
      lastCloseTime: persistedCandles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }

  const filtered = filterRestorableMt5Candles(merged.candles);
  if (filtered.rejected) {
    return {
      status: "BLOCKED",
      reason: filtered.reason ?? MT5_WARMUP_MERGE_REJECTED,
      candles: [...persistedCandles],
      plan,
      fetchedBars: completedHistory.length,
      requestedBars: plan.fetchCount,
      sourceMix: countMt5ProvenanceSources(persistedCandles),
      firstOpenTime: persistedCandles[0]?.openTime ?? null,
      lastCloseTime: persistedCandles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }

  const ready = isMt5MarketDataReady(filtered.candles, requirement);
  if (!ready.ready) {
    return {
      status: "BLOCKED",
      reason: ready.reason?.includes("incomplete")
        ? MT5_WARMUP_INSUFFICIENT_HISTORY
        : ready.reason,
      candles: filtered.candles,
      plan,
      fetchedBars: completedHistory.length,
      requestedBars: plan.fetchCount,
      sourceMix: countMt5ProvenanceSources(filtered.candles),
      firstOpenTime: filtered.candles[0]?.openTime ?? null,
      lastCloseTime: filtered.candles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }

  // Persist only HISTORY rows that do not collide with LIVE buckets
  const liveOpen = new Set(live.map((c) => c.openTime));
  const priorHistoryOpen = new Set(priorHistory.map((c) => c.openTime));
  const historyCandlesToPersist = completedHistory.filter(
    (c) => !liveOpen.has(c.openTime) && !priorHistoryOpen.has(c.openTime)
  );

  return {
    status: "READY",
    reason: null,
    candles: filtered.candles,
    plan,
    fetchedBars: completedHistory.length,
    requestedBars: plan.fetchCount,
    sourceMix: countMt5ProvenanceSources(filtered.candles),
    firstOpenTime: filtered.candles[0]?.openTime ?? null,
    lastCloseTime: filtered.candles.at(-1)?.closeTime ?? null,
    historyCandlesToPersist
  };
}

/**
 * Fetch + assemble warm-up buffer. Network via Mt5BarsClient only.
 */
export async function runMt5HistoricalWarmup(input: {
  client: Mt5BarsClient;
  requirement: Mt5WarmupRequirement;
  persistedCandles: readonly Candle[];
  interval: CandleInterval;
  engineSymbol: string;
  mapping: BrokerSymbolMappingRecord | null | undefined;
  isDemoAccount: boolean;
}): Promise<Mt5HistoricalWarmupResult> {
  const plan = planMt5HistoricalWarmup({
    requirement: input.requirement,
    persistedCandles: input.persistedCandles,
    interval: input.interval,
    engineSymbol: input.engineSymbol,
    mapping: input.mapping,
    isDemoAccount: input.isDemoAccount
  });

  if (plan.status !== "FETCH") {
    return assembleMt5HistoricalWarmup({
      plan,
      requirement: input.requirement,
      persistedCandles: input.persistedCandles,
      fetchedBars: [],
      engineSymbol: input.engineSymbol,
      interval: input.interval
    });
  }

  try {
    const result = await fetchRecentMt5Bars(input.client, {
      symbol: plan.brokerSymbol!,
      timeframe: plan.timeframe!,
      count: plan.fetchCount,
      completedBarsOnly: true
    });
    return assembleMt5HistoricalWarmup({
      plan,
      requirement: input.requirement,
      persistedCandles: input.persistedCandles,
      fetchedBars: result.bars,
      engineSymbol: input.engineSymbol,
      interval: input.interval
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "BLOCKED",
      reason: `${MT5_WARMUP_FETCH_FAILED}:${msg}`,
      candles: [...input.persistedCandles],
      plan,
      fetchedBars: 0,
      requestedBars: plan.fetchCount,
      sourceMix: countMt5ProvenanceSources(input.persistedCandles),
      firstOpenTime: input.persistedCandles[0]?.openTime ?? null,
      lastCloseTime: input.persistedCandles.at(-1)?.closeTime ?? null,
      historyCandlesToPersist: []
    };
  }
}

/** Expected open-time step for an interval; used by tests for gap classification. */
export function expectedMt5BarStepMs(interval: CandleInterval): number {
  const tf = candleIntervalToMt5BarTimeframe(interval);
  if (tf) return timeframeMs(tf);
  return intervalMs(interval);
}

/**
 * Classify openTime gap between consecutive completed bars.
 * Large gaps (weekend / session) are accepted; they are not continuity failures.
 * Continuity failure remains close-jump based in filterRestorableMt5Candles.
 */
export function classifyMt5OpenTimeGap(input: {
  previousOpenTime: number;
  nextOpenTime: number;
  interval: CandleInterval;
}): "CONTIGUOUS" | "SHORT_GAP" | "SESSION_OR_WEEKEND_GAP" | "INVALID_ORDER" {
  if (input.nextOpenTime <= input.previousOpenTime) return "INVALID_ORDER";
  const step = expectedMt5BarStepMs(input.interval);
  const gap = input.nextOpenTime - input.previousOpenTime;
  if (gap === step) return "CONTIGUOUS";
  // Gold weekend ≈ 48h+; treat anything > 6 hours as session/weekend for 15m (24 bars)
  if (gap > Math.max(step * 24, 6 * 60 * 60_000)) return "SESSION_OR_WEEKEND_GAP";
  return "SHORT_GAP";
}
