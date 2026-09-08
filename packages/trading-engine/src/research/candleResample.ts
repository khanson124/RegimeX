import {
  candleCloseTime,
  candleOpenTime,
  type Candle,
  type CandleInterval
} from "@regimex/shared";
import {
  researchCandleCloseTime,
  researchCandleOpenTime,
  researchIntervalMs,
  toBacktestCandle,
  type ResearchCandleInterval
} from "./researchCandleInterval.js";

/**
 * Legacy aggregation (may bridge incomplete buckets). Prefer
 * {@link aggregateContiguousCompletedCandles} for research HTF work.
 */
export function aggregateCompletedCandles(
  candles: ReadonlyArray<Candle>,
  targetInterval: CandleInterval
): Candle[] {
  if (candles.length === 0) return [];
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    if (!c.isComplete) continue;
    const open = candleOpenTime(c.openTime, targetInterval);
    const list = buckets.get(open) ?? [];
    list.push(c);
    buckets.set(open, list);
  }

  const outs: Candle[] = [];
  const opens = [...buckets.keys()].sort((a, b) => a - b);
  for (const open of opens) {
    const group = buckets.get(open)!;
    group.sort((a, b) => a.openTime - b.openTime);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const closeTime = candleCloseTime(open, targetInterval);
    if (last.closeTime < closeTime && group.length === 1) {
      continue;
    }
    let high = first.high;
    let low = first.low;
    let ticks = 0;
    for (const g of group) {
      high = Math.max(high, g.high);
      low = Math.min(low, g.low);
      ticks += g.tickCount;
    }
    outs.push({
      symbol: first.symbol,
      interval: targetInterval,
      openTime: open,
      closeTime,
      open: first.open,
      high,
      low,
      close: last.close,
      tickCount: ticks,
      isComplete: true,
      source: first.source
    });
  }
  return outs;
}

export type ContiguousBucketExcludeReason =
  | "INCOMPLETE_COUNT"
  | "MISSING_INTERIOR_MINUTE"
  | "NON_CONTIGUOUS_OPENS"
  | "DUPLICATE_MINUTE"
  | "INVALID_SOURCE_OHLC"
  | "EMPTY_BUCKET";

export interface ContiguousAggregationResult {
  /** Research target; may be `15m` (not a production CandleInterval). */
  targetInterval: ResearchCandleInterval;
  sourceIntervalMs: number;
  expectedSourceBarsPerBucket: number;
  rawBucketCount: number;
  validBars: Candle[];
  excluded: Array<{
    bucketOpenTime: number;
    bucketIso: string;
    reason: ContiguousBucketExcludeReason;
    sourceBarCount: number;
    detail: string;
  }>;
  validCount: number;
  excludedCount: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isInvalidOhlc(c: Candle): boolean {
  return (
    !(c.open > 0) ||
    !(c.high > 0) ||
    !(c.low > 0) ||
    !(c.close > 0) ||
    c.high < c.low ||
    c.high < Math.max(c.open, c.close) ||
    c.low > Math.min(c.open, c.close)
  );
}

/**
 * Gap-aware research aggregation (incl. research-only `15m`): emit a HTF bar only when
 * the bucket contains a complete contiguous set of source bars (no missing interior
 * minutes, no gap bridging). Session/maintenance gaps simply leave incomplete buckets
 * that are rejected — never bridged.
 *
 * Lookahead-safe: uses only completed source candles; OHLC from chronological members.
 * Does not modify live tick ingestion or production CandleInterval contracts.
 */
export function aggregateContiguousResearchCandles(
  candles: ReadonlyArray<Candle>,
  targetInterval: ResearchCandleInterval,
  opts?: { sourceIntervalMs?: number }
): ContiguousAggregationResult {
  const sourceIntervalMs = opts?.sourceIntervalMs ?? 60_000;
  const targetMs = researchIntervalMs(targetInterval);
  const expectedSourceBarsPerBucket = Math.round(targetMs / sourceIntervalMs);

  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    if (!c.isComplete) continue;
    const open = researchCandleOpenTime(c.openTime, targetInterval);
    const list = buckets.get(open) ?? [];
    list.push(c);
    buckets.set(open, list);
  }

  const opens = [...buckets.keys()].sort((a, b) => a - b);
  const validBars: Candle[] = [];
  const excluded: ContiguousAggregationResult["excluded"] = [];

  for (const open of opens) {
    const group = [...(buckets.get(open) ?? [])].sort((a, b) => a.openTime - b.openTime);
    if (group.length === 0) {
      excluded.push({
        bucketOpenTime: open,
        bucketIso: iso(open),
        reason: "EMPTY_BUCKET",
        sourceBarCount: 0,
        detail: "Empty bucket"
      });
      continue;
    }

    if (group.some(isInvalidOhlc)) {
      excluded.push({
        bucketOpenTime: open,
        bucketIso: iso(open),
        reason: "INVALID_SOURCE_OHLC",
        sourceBarCount: group.length,
        detail: "Invalid OHLC in source bars"
      });
      continue;
    }

    const opensSeen = new Set<number>();
    let dup = false;
    for (const g of group) {
      if (opensSeen.has(g.openTime)) {
        dup = true;
        break;
      }
      opensSeen.add(g.openTime);
    }
    if (dup) {
      excluded.push({
        bucketOpenTime: open,
        bucketIso: iso(open),
        reason: "DUPLICATE_MINUTE",
        sourceBarCount: group.length,
        detail: "Duplicate source openTime in bucket"
      });
      continue;
    }

    if (group.length !== expectedSourceBarsPerBucket) {
      excluded.push({
        bucketOpenTime: open,
        bucketIso: iso(open),
        reason: "INCOMPLETE_COUNT",
        sourceBarCount: group.length,
        detail: `Expected ${expectedSourceBarsPerBucket} source bars, got ${group.length}`
      });
      continue;
    }

    let contiguous = true;
    let missingInterior = false;
    for (let i = 0; i < group.length; i++) {
      const expectedOpen = open + i * sourceIntervalMs;
      if (group[i]!.openTime !== expectedOpen) {
        contiguous = false;
        if (group[i]!.openTime > expectedOpen) missingInterior = true;
        break;
      }
    }
    if (!contiguous) {
      excluded.push({
        bucketOpenTime: open,
        bucketIso: iso(open),
        reason: missingInterior ? "MISSING_INTERIOR_MINUTE" : "NON_CONTIGUOUS_OPENS",
        sourceBarCount: group.length,
        detail: "Source opens are not a contiguous minute sequence for this bucket"
      });
      continue;
    }

    const first = group[0]!;
    const last = group[group.length - 1]!;
    let high = first.high;
    let low = first.low;
    let ticks = 0;
    for (const g of group) {
      high = Math.max(high, g.high);
      low = Math.min(low, g.low);
      ticks += g.tickCount;
    }

    validBars.push(
      toBacktestCandle({
        symbol: first.symbol,
        interval: targetInterval,
        openTime: open,
        closeTime: researchCandleCloseTime(open, targetInterval),
        open: first.open,
        high,
        low,
        close: last.close,
        tickCount: ticks,
        isComplete: true,
        source: first.source
      })
    );
  }

  return {
    targetInterval,
    sourceIntervalMs,
    expectedSourceBarsPerBucket,
    rawBucketCount: opens.length,
    validBars,
    excluded,
    validCount: validBars.length,
    excludedCount: excluded.length
  };
}

/**
 * Production-interval wrapper (`1m`|`5m`). Prefer
 * {@link aggregateContiguousResearchCandles} when targeting research-only `15m`.
 */
export function aggregateContiguousCompletedCandles(
  candles: ReadonlyArray<Candle>,
  targetInterval: CandleInterval,
  opts?: { sourceIntervalMs?: number }
): ContiguousAggregationResult {
  return aggregateContiguousResearchCandles(candles, targetInterval, opts);
}
