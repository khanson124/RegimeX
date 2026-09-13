import {
  candleOpenTime,
  intervalMs,
  type Candle,
  type CandleInterval,
  type CandleSource
} from "@regimex/shared";
import { type DerivClient } from "../deriv/derivClient.js";
import { ohlcConflict, validateHistoricalCandle } from "./candleValidation.js";

export interface FetchedHistoricalCandle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ExistingCandleRow {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

export interface CandleConflict {
  openTimeMs: number;
  existing: ExistingCandleRow;
  incoming: FetchedHistoricalCandle;
}

export interface BackfillBatchPlan {
  toInsert: Candle[];
  duplicatesSkipped: number;
  conflicts: CandleConflict[];
  invalid: Array<{ candle: FetchedHistoricalCandle; failures: string[] }>;
}

export interface HistoricalBackfillProgress {
  cursorMs: number;
  toMs: number;
  percent: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  invalid: number;
}

export interface HistoricalBackfillResult {
  symbol: string;
  interval: CandleInterval;
  source: CandleSource;
  fromMs: number;
  toMs: number;
  fetched: number;
  inserted: number;
  duplicatesSkipped: number;
  conflicts: number;
  invalid: number;
  dryRun: boolean;
  conflictSamples: CandleConflict[];
  invalidSamples: Array<{ openTimeMs: number; failures: string[] }>;
}

const GRANULARITY_SEC: Record<CandleInterval, number> = { "1m": 60, "5m": 300, "15m": 900 };
/**
 * Deriv `ticks_history` style=candles hard-caps at 1000 candles per request and
 * returns the *trailing* end of [start,end]. Windows larger than this silently
 * skip the leading portion (e.g. 4500-min window → keep last 1000 → 3500-min holes).
 */
export const DERIV_CANDLE_HISTORY_MAX_CANDLES = 1000;
export const DEFAULT_BACKFILL_BATCH_CANDLES = DERIV_CANDLE_HISTORY_MAX_CANDLES;

/**
 * Advance the backfill cursor after a Deriv history batch.
 * When the requested window exceeds the API max, Deriv returns only the trailing
 * candles — advance only through those candles so the leading hole is retried
 * with a properly sized window (caller must also clamp batch size ≤ max).
 */
export function nextBackfillCursorMs(input: {
  cursorMs: number;
  batchEndMs: number;
  stepMs: number;
  fetchedOpenTimesMs: ReadonlyArray<number>;
  maxCandlesPerRequest?: number;
}): { nextCursorMs: number; truncatedLeading: boolean } {
  const max = input.maxCandlesPerRequest ?? DERIV_CANDLE_HISTORY_MAX_CANDLES;
  const windowBars = Math.max(0, Math.round((input.batchEndMs - input.cursorMs) / input.stepMs));
  if (input.fetchedOpenTimesMs.length === 0) {
    return { nextCursorMs: input.batchEndMs, truncatedLeading: false };
  }
  const first = Math.min(...input.fetchedOpenTimesMs);
  const truncatedLeading = windowBars > max && first > input.cursorMs + input.stepMs;
  if (truncatedLeading) {
    // Retry the leading hole: next window ends at first returned open (exclusive).
    // Caller should clamp batch size so this path is rare.
    return { nextCursorMs: first, truncatedLeading: true };
  }
  return { nextCursorMs: input.batchEndMs, truncatedLeading: false };
}

export function planBackfillBatch(input: {
  fetched: FetchedHistoricalCandle[];
  existingByOpenTime: Map<number, ExistingCandleRow>;
  symbol: string;
  interval: CandleInterval;
  source: CandleSource;
}): BackfillBatchPlan {
  const step = intervalMs(input.interval);
  const toInsert: Candle[] = [];
  const conflicts: CandleConflict[] = [];
  const invalid: BackfillBatchPlan["invalid"] = [];
  let duplicatesSkipped = 0;

  const seen = new Set<number>();
  for (const f of input.fetched) {
    const openTime = candleOpenTime(f.openTimeMs, input.interval);
    const candle: Candle = {
      symbol: input.symbol,
      interval: input.interval,
      openTime,
      closeTime: openTime + step,
      open: f.open,
      high: f.high,
      low: f.low,
      close: f.close,
      tickCount: 0,
      isComplete: true,
      source: input.source
    };

    const v = validateHistoricalCandle(candle, {
      symbol: input.symbol,
      interval: input.interval
    });
    if (!v.ok) {
      invalid.push({ candle: f, failures: v.failures });
      continue;
    }

    if (seen.has(openTime)) {
      duplicatesSkipped++;
      continue;
    }
    seen.add(openTime);

    const existing = input.existingByOpenTime.get(openTime);
    if (existing) {
      if (
        ohlcConflict(existing, {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close
        })
      ) {
        conflicts.push({ openTimeMs: openTime, existing, incoming: f });
      } else {
        duplicatesSkipped++;
      }
      continue;
    }

    toInsert.push(candle);
  }

  return { toInsert, duplicatesSkipped, conflicts, invalid };
}

/**
 * Research-safe historical candle backfill using Deriv ticks_history (HISTORY_API).
 * Idempotent: skips exact duplicates; logs OHLC conflicts without overwrite.
 */
export async function runHistoricalCandleBackfill(input: {
  client: DerivClient;
  symbol: string;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
  dryRun?: boolean;
  batchCandles?: number;
  source?: CandleSource;
  /** Load existing candles overlapping [from,to] for conflict/dedupe. */
  loadExisting: (fromMs: number, toMs: number) => Promise<ExistingCandleRow[]>;
  /** Persist a batch of new candles. Ignored when dryRun. */
  persist?: (candles: Candle[]) => Promise<number>;
  onProgress?: (p: HistoricalBackfillProgress) => void | Promise<void>;
}): Promise<HistoricalBackfillResult> {
  const dryRun = input.dryRun === true;
  const source: CandleSource = input.source ?? "HISTORY_API";
  const batchCandles = Math.min(
    input.batchCandles ?? DEFAULT_BACKFILL_BATCH_CANDLES,
    DERIV_CANDLE_HISTORY_MAX_CANDLES
  );
  const step = intervalMs(input.interval);
  const granularity = GRANULARITY_SEC[input.interval];

  let cursor = input.fromMs;
  let fetched = 0;
  let inserted = 0;
  let duplicatesSkipped = 0;
  let conflictCount = 0;
  let invalidCount = 0;
  const conflictSamples: CandleConflict[] = [];
  const invalidSamples: Array<{ openTimeMs: number; failures: string[] }> = [];

  while (cursor < input.toMs) {
    const batchEnd = Math.min(cursor + batchCandles * step, input.toMs);
    const existingRows = await input.loadExisting(cursor, batchEnd);
    const existingByOpenTime = new Map(existingRows.map((r) => [r.openTimeMs, r]));

    const raw = await input.client.getCandleHistory(
      input.symbol,
      granularity,
      Math.floor(cursor / 1000),
      Math.floor(batchEnd / 1000),
      batchCandles
    );
    fetched += raw.length;

    const plan = planBackfillBatch({
      fetched: raw,
      existingByOpenTime,
      symbol: input.symbol,
      interval: input.interval,
      source
    });

    duplicatesSkipped += plan.duplicatesSkipped;
    conflictCount += plan.conflicts.length;
    invalidCount += plan.invalid.length;
    for (const c of plan.conflicts) {
      if (conflictSamples.length < 20) conflictSamples.push(c);
    }
    for (const inv of plan.invalid) {
      if (invalidSamples.length < 20) {
        invalidSamples.push({ openTimeMs: inv.candle.openTimeMs, failures: inv.failures });
      }
    }

    if (!dryRun && plan.toInsert.length > 0 && input.persist) {
      inserted += await input.persist(plan.toInsert);
    } else if (dryRun) {
      inserted += plan.toInsert.length; // would-insert count
    }

    const prevCursor = cursor;
    const advance = nextBackfillCursorMs({
      cursorMs: cursor,
      batchEndMs: batchEnd,
      stepMs: step,
      fetchedOpenTimesMs: raw.map((c) => c.openTimeMs),
      maxCandlesPerRequest: DERIV_CANDLE_HISTORY_MAX_CANDLES
    });
    cursor = advance.nextCursorMs;
    // Hard progress guarantee (empty/malformed responses).
    if (cursor <= prevCursor) {
      cursor = batchEnd;
    }
    const percent = Math.min(
      100,
      Math.round(((cursor - input.fromMs) / Math.max(1, input.toMs - input.fromMs)) * 100)
    );
    await input.onProgress?.({
      cursorMs: cursor,
      toMs: input.toMs,
      percent,
      fetched,
      inserted,
      duplicates: duplicatesSkipped,
      conflicts: conflictCount,
      invalid: invalidCount
    });
  }

  return {
    symbol: input.symbol,
    interval: input.interval,
    source,
    fromMs: input.fromMs,
    toMs: input.toMs,
    fetched,
    inserted,
    duplicatesSkipped,
    conflicts: conflictCount,
    invalid: invalidCount,
    dryRun,
    conflictSamples,
    invalidSamples
  };
}
