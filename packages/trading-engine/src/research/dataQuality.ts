import { type Candle } from "@regimex/shared";

export interface DataQualityIssue {
  code:
    | "DUPLICATE_TIMESTAMP"
    | "NON_MONOTONIC"
    | "INVALID_OHLC"
    | "ZERO_RANGE"
    | "LARGE_GAP"
    | "EMPTY";
  index?: number;
  detail: string;
}

export interface DataQualityReport {
  candleCount: number;
  symbol: string | null;
  interval: string | null;
  source: string | null;
  firstOpenTime: number | null;
  lastCloseTime: number | null;
  firstIso: string | null;
  lastIso: string | null;
  expectedIntervalMs: number | null;
  gapCount: number;
  missingBarEstimate: number;
  missingBarRate: number;
  duplicateCount: number;
  nonMonotonicCount: number;
  invalidOhlcCount: number;
  zeroRangeCount: number;
  largeGapCount: number;
  treatedAs247: boolean;
  issues: DataQualityIssue[];
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Read-only data-quality inspection. Does not mutate or repair candles.
 */
export function inspectCandleDataQuality(
  candles: ReadonlyArray<Candle>,
  opts?: { expectedIntervalMs?: number; largeGapMultiple?: number }
): DataQualityReport {
  const expectedIntervalMs = opts?.expectedIntervalMs ?? null;
  const largeGapMultiple = opts?.largeGapMultiple ?? 3;
  const issues: DataQualityIssue[] = [];

  if (candles.length === 0) {
    issues.push({ code: "EMPTY", detail: "No candles provided" });
    return {
      candleCount: 0,
      symbol: null,
      interval: null,
      source: null,
      firstOpenTime: null,
      lastCloseTime: null,
      firstIso: null,
      lastIso: null,
      expectedIntervalMs,
      gapCount: 0,
      missingBarEstimate: 0,
      missingBarRate: 0,
      duplicateCount: 0,
      nonMonotonicCount: 0,
      invalidOhlcCount: 0,
      zeroRangeCount: 0,
      largeGapCount: 0,
      treatedAs247: true,
      issues
    };
  }

  let duplicateCount = 0;
  let nonMonotonicCount = 0;
  let invalidOhlcCount = 0;
  let zeroRangeCount = 0;
  let gapCount = 0;
  let missingBarEstimate = 0;
  let largeGapCount = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (
      !(c.open > 0) ||
      !(c.high > 0) ||
      !(c.low > 0) ||
      !(c.close > 0) ||
      c.high < c.low ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close)
    ) {
      invalidOhlcCount++;
      if (issues.length < 50) {
        issues.push({ code: "INVALID_OHLC", index: i, detail: `Invalid OHLC at index ${i}` });
      }
    }
    if (c.high === c.low) {
      zeroRangeCount++;
      if (issues.length < 50) {
        issues.push({ code: "ZERO_RANGE", index: i, detail: `Zero-range bar at index ${i}` });
      }
    }

    if (i === 0) continue;
    const prev = candles[i - 1]!;
    if (c.openTime === prev.openTime) {
      duplicateCount++;
      if (issues.length < 50) {
        issues.push({
          code: "DUPLICATE_TIMESTAMP",
          index: i,
          detail: `Duplicate openTime ${c.openTime}`
        });
      }
    }
    if (c.openTime < prev.openTime) {
      nonMonotonicCount++;
      if (issues.length < 50) {
        issues.push({
          code: "NON_MONOTONIC",
          index: i,
          detail: `openTime ${c.openTime} < previous ${prev.openTime}`
        });
      }
    }

    if (expectedIntervalMs != null && expectedIntervalMs > 0) {
      const delta = c.openTime - prev.openTime;
      if (delta > expectedIntervalMs) {
        const missing = Math.round(delta / expectedIntervalMs) - 1;
        if (missing > 0) {
          gapCount++;
          missingBarEstimate += missing;
          if (delta >= expectedIntervalMs * largeGapMultiple) {
            largeGapCount++;
            if (issues.length < 50) {
              issues.push({
                code: "LARGE_GAP",
                index: i,
                detail: `Gap ${delta}ms (~${missing} missing bars) before index ${i}`
              });
            }
          }
        }
      }
    }
  }

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const spanBars =
    expectedIntervalMs != null && expectedIntervalMs > 0
      ? Math.max(1, Math.round((last.openTime - first.openTime) / expectedIntervalMs) + 1)
      : candles.length;
  const missingBarRate = spanBars > 0 ? missingBarEstimate / spanBars : 0;

  return {
    candleCount: candles.length,
    symbol: first.symbol,
    interval: first.interval,
    source: first.source,
    firstOpenTime: first.openTime,
    lastCloseTime: last.closeTime,
    firstIso: iso(first.openTime),
    lastIso: iso(last.closeTime),
    expectedIntervalMs,
    gapCount,
    missingBarEstimate,
    missingBarRate: Number(missingBarRate.toFixed(6)),
    duplicateCount,
    nonMonotonicCount,
    invalidOhlcCount,
    zeroRangeCount,
    largeGapCount,
    treatedAs247: true,
    issues
  };
}
