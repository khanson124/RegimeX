/**
 * Chunked read-only MT5 bar retrieval (pagination + overlap handling).
 */
import { Mt5BrokerError } from "../broker/mt5/mt5BrokerError.js";
import {
  type Mt5Bar,
  type Mt5BarTimeframe,
  type Mt5BarsQuery,
  type Mt5BarsResult
} from "../broker/mt5/types.js";

export const MT5_BARS_MAX_PER_REQUEST = 250;

export function timeframeMs(tf: Mt5BarTimeframe): number {
  if (tf === "1m") return 60_000;
  if (tf === "5m") return 300_000;
  if (tf === "15m") return 900_000;
  return 14_400_000; // 4h
}

export interface Mt5BarsClient {
  getBars(query: Mt5BarsQuery): Promise<Mt5BarsResult>;
}

export interface ChunkFetchReport {
  symbol: string;
  timeframe: Mt5BarTimeframe;
  requestedFromMs: number;
  requestedToMs: number;
  chunks: number;
  bars: Mt5Bar[];
  firstOpenTimeMs: number | null;
  lastOpenTimeMs: number | null;
  truncatedChunks: number;
  emptyChunks: number;
  brokerServerUtcOffsetSeconds: number | null;
  timestampSemantics: string | null;
}

/**
 * Walk [fromMs, toMs] in time windows sized for ≤ maxPerRequest bars.
 * Dedupes boundary overlaps. Expects EA completedBarsOnly=true by default.
 */
export async function fetchMt5BarsChunked(
  client: Mt5BarsClient,
  input: {
    symbol: string;
    timeframe: Mt5BarTimeframe;
    fromMs: number;
    toMs: number;
    completedBarsOnly?: boolean;
    maxPerRequest?: number;
  }
): Promise<ChunkFetchReport> {
  const maxPer = input.maxPerRequest ?? MT5_BARS_MAX_PER_REQUEST;
  const step = timeframeMs(input.timeframe);
  const windowMs = maxPer * step;
  const byOpen = new Map<number, Mt5Bar>();
  let chunks = 0;
  let truncatedChunks = 0;
  let emptyChunks = 0;
  let offset: number | null = null;
  let semantics: string | null = null;

  let cursor = input.fromMs;
  while (cursor <= input.toMs) {
    const chunkTo = Math.min(input.toMs, cursor + windowMs - step);
    let result: Mt5BarsResult;
    try {
      result = await client.getBars({
        symbol: input.symbol,
        timeframe: input.timeframe,
        fromMs: cursor,
        toMs: chunkTo,
        count: maxPer,
        completedBarsOnly: input.completedBarsOnly ?? true
      });
    } catch (err) {
      // Historical gaps / market closures: tolerate only this empty-chunk code here.
      // Do not soft-succeed getBars globally — other errors still abort pagination.
      if (err instanceof Mt5BrokerError && err.errorCode === "MT5_BARS_UNAVAILABLE") {
        chunks++;
        emptyChunks++;
        cursor = chunkTo + step;
        if (chunks > 10_000) break;
        continue;
      }
      throw err;
    }
    chunks++;
    offset = result.brokerServerUtcOffsetSeconds;
    semantics = result.timestampSemantics;
    if (result.bars.length === 0) emptyChunks++;
    if (result.returnedCount >= maxPer) truncatedChunks++;
    for (const bar of result.bars) {
      if (bar.source !== "MT5") continue;
      if (bar.openTimeMs < input.fromMs || bar.openTimeMs > input.toMs) continue;
      byOpen.set(bar.openTimeMs, bar);
    }
    // Advance past last returned bar, or by full window if empty
    const last = result.bars.at(-1)?.openTimeMs;
    if (last != null && last >= cursor) {
      cursor = last + step;
    } else {
      cursor = chunkTo + step;
    }
    if (chunks > 10_000) break; // hard safety
  }

  const bars = [...byOpen.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    requestedFromMs: input.fromMs,
    requestedToMs: input.toMs,
    chunks,
    bars,
    firstOpenTimeMs: bars[0]?.openTimeMs ?? null,
    lastOpenTimeMs: bars.at(-1)?.openTimeMs ?? null,
    truncatedChunks,
    emptyChunks,
    brokerServerUtcOffsetSeconds: offset,
    timestampSemantics: semantics
  };
}

/** Fetch most recent completed bars (single or multi chunk via count windows). */
export async function fetchRecentMt5Bars(
  client: Mt5BarsClient,
  input: {
    symbol: string;
    timeframe: Mt5BarTimeframe;
    count: number;
    completedBarsOnly?: boolean;
  }
): Promise<Mt5BarsResult> {
  const maxPer = MT5_BARS_MAX_PER_REQUEST;
  if (input.count <= maxPer) {
    return client.getBars({
      symbol: input.symbol,
      timeframe: input.timeframe,
      count: input.count,
      completedBarsOnly: input.completedBarsOnly ?? true
    });
  }
  const step = timeframeMs(input.timeframe);
  const toMs = Date.now();
  const fromMs = toMs - input.count * step;
  const chunked = await fetchMt5BarsChunked(client, {
    symbol: input.symbol,
    timeframe: input.timeframe,
    fromMs,
    toMs,
    completedBarsOnly: input.completedBarsOnly ?? true
  });
  const bars = chunked.bars.slice(-input.count);
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    brokerServerUtcOffsetSeconds: chunked.brokerServerUtcOffsetSeconds ?? 0,
    timestampSemantics: chunked.timestampSemantics ?? "",
    completedBarsOnly: input.completedBarsOnly ?? true,
    requestedFromMs: fromMs,
    requestedToMs: toMs,
    returnedCount: bars.length,
    bars
  };
}
