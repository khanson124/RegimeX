/**
 * Deep R_10 dataset audit (read-only). Does not repair source data.
 */
import { type Candle } from "@regimex/shared";

export interface GapRecord {
  afterIndex: number;
  fromOpenTime: number;
  toOpenTime: number;
  fromIso: string;
  toIso: string;
  deltaMs: number;
  missingMinutes: number;
  priceJumpAbs: number | null;
  priceJumpPct: number | null;
}

export interface DatasetAuditReport {
  actualCandleCount: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
  firstIso: string | null;
  lastIso: string | null;
  spanMs: number;
  /** Expected 1m bars for continuous 24/7 coverage from first→last open inclusive. */
  expectedContinuous1mCount: number;
  missingCandleCount: number;
  missingCandlePct: number;
  coveragePct: number;
  duplicateTimestamps: number;
  outOfOrderTimestamps: number;
  invalidOhlc: number;
  zeroRange: number;
  gapCount: number;
  gaps: GapRecord[];
  gapSizeDistribution: {
    missing1: number;
    missing2to4: number;
    missing5to14: number;
    missing15to59: number;
    missing60to1439: number;
    missing1dayPlus: number;
  };
  longestGaps: GapRecord[];
  suspiciousPriceJumpsNearGaps: GapRecord[];
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
 * Exact continuous-coverage audit for 1m candles (research-only).
 */
export function auditOneMinuteDataset(
  candles: ReadonlyArray<Candle>,
  opts?: { suspiciousJumpPct?: number }
): DatasetAuditReport {
  const suspiciousJumpPct = opts?.suspiciousJumpPct ?? 0.005; // 0.5%
  if (candles.length === 0) {
    return {
      actualCandleCount: 0,
      firstOpenTime: null,
      lastOpenTime: null,
      firstIso: null,
      lastIso: null,
      spanMs: 0,
      expectedContinuous1mCount: 0,
      missingCandleCount: 0,
      missingCandlePct: 0,
      coveragePct: 0,
      duplicateTimestamps: 0,
      outOfOrderTimestamps: 0,
      invalidOhlc: 0,
      zeroRange: 0,
      gapCount: 0,
      gaps: [],
      gapSizeDistribution: {
        missing1: 0,
        missing2to4: 0,
        missing5to14: 0,
        missing15to59: 0,
        missing60to1439: 0,
        missing1dayPlus: 0
      },
      longestGaps: [],
      suspiciousPriceJumpsNearGaps: []
    };
  }

  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const spanMs = last.openTime - first.openTime;
  const expectedContinuous1mCount = Math.floor(spanMs / 60_000) + 1;

  let duplicateTimestamps = 0;
  let outOfOrderTimestamps = 0;
  let invalidOhlc = 0;
  let zeroRange = 0;
  const gaps: GapRecord[] = [];
  const dist = {
    missing1: 0,
    missing2to4: 0,
    missing5to14: 0,
    missing15to59: 0,
    missing60to1439: 0,
    missing1dayPlus: 0
  };

  // Detect out-of-order vs original input order
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.openTime < candles[i - 1]!.openTime) outOfOrderTimestamps++;
  }

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (isInvalidOhlc(c)) invalidOhlc++;
    if (c.high === c.low) zeroRange++;
    if (i === 0) continue;
    const prev = sorted[i - 1]!;
    if (c.openTime === prev.openTime) {
      duplicateTimestamps++;
      continue;
    }
    const delta = c.openTime - prev.openTime;
    if (delta > 60_000) {
      const missingMinutes = Math.round(delta / 60_000) - 1;
      const jumpAbs = Math.abs(c.open - prev.close);
      const jumpPct = prev.close !== 0 ? jumpAbs / Math.abs(prev.close) : null;
      const gap: GapRecord = {
        afterIndex: i - 1,
        fromOpenTime: prev.openTime,
        toOpenTime: c.openTime,
        fromIso: iso(prev.openTime),
        toIso: iso(c.openTime),
        deltaMs: delta,
        missingMinutes,
        priceJumpAbs: Number(jumpAbs.toFixed(6)),
        priceJumpPct: jumpPct != null ? Number(jumpPct.toFixed(6)) : null
      };
      gaps.push(gap);
      if (missingMinutes <= 1) dist.missing1++;
      else if (missingMinutes <= 4) dist.missing2to4++;
      else if (missingMinutes <= 14) dist.missing5to14++;
      else if (missingMinutes <= 59) dist.missing15to59++;
      else if (missingMinutes <= 1439) dist.missing60to1439++;
      else dist.missing1dayPlus++;
    }
  }

  const missingCandleCount = Math.max(0, expectedContinuous1mCount - sorted.length + duplicateTimestamps);
  // Prefer gap-sum for exact missing minutes between observed bars
  const missingFromGaps = gaps.reduce((a, g) => a + g.missingMinutes, 0);
  const missingExact = missingFromGaps;
  const missingCandlePct =
    expectedContinuous1mCount > 0 ? missingExact / expectedContinuous1mCount : 0;
  const coveragePct =
    expectedContinuous1mCount > 0
      ? (expectedContinuous1mCount - missingExact) / expectedContinuous1mCount
      : 0;

  const longestGaps = [...gaps].sort((a, b) => b.missingMinutes - a.missingMinutes).slice(0, 15);
  const suspiciousPriceJumpsNearGaps = gaps.filter(
    (g) => g.priceJumpPct != null && g.priceJumpPct >= suspiciousJumpPct
  );

  return {
    actualCandleCount: sorted.length,
    firstOpenTime: first.openTime,
    lastOpenTime: last.openTime,
    firstIso: iso(first.openTime),
    lastIso: iso(last.openTime),
    spanMs,
    expectedContinuous1mCount,
    missingCandleCount: missingExact,
    missingCandlePct: Number(missingCandlePct.toFixed(6)),
    coveragePct: Number(coveragePct.toFixed(6)),
    duplicateTimestamps,
    outOfOrderTimestamps,
    invalidOhlc,
    zeroRange,
    gapCount: gaps.length,
    gaps,
    gapSizeDistribution: dist,
    longestGaps,
    suspiciousPriceJumpsNearGaps
  };
}
