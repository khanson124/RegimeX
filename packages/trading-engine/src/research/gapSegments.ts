import { type Candle } from "@regimex/shared";

export interface ContinuousSegment {
  segmentIndex: number;
  startIndex: number;
  endIndexExclusive: number;
  startOpenTime: number;
  endOpenTime: number;
  startIso: string;
  endIso: string;
  candleCount: number;
  spanMs: number;
}

export interface GapSegmentReport {
  maxGapMs: number;
  segments: ContinuousSegment[];
  segmentCount: number;
  largestSegmentCandleCount: number;
  largestSegmentSpanMs: number;
}

/**
 * Split a chronological candle series into continuous segments.
 * A new segment starts when successive openTimes differ by more than maxGapMs
 * (default: 1 interval + small slack → use 2 * expectedIntervalMs typically).
 */
export function detectContinuousSegments(
  candles: ReadonlyArray<Candle>,
  maxGapMs: number
): GapSegmentReport {
  if (candles.length === 0) {
    return {
      maxGapMs,
      segments: [],
      segmentCount: 0,
      largestSegmentCandleCount: 0,
      largestSegmentSpanMs: 0
    };
  }

  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const segments: ContinuousSegment[] = [];
  let start = 0;

  const push = (from: number, toExclusive: number) => {
    const first = sorted[from]!;
    const last = sorted[toExclusive - 1]!;
    segments.push({
      segmentIndex: segments.length,
      startIndex: from,
      endIndexExclusive: toExclusive,
      startOpenTime: first.openTime,
      endOpenTime: last.openTime,
      startIso: new Date(first.openTime).toISOString(),
      endIso: new Date(last.openTime).toISOString(),
      candleCount: toExclusive - from,
      spanMs: last.openTime - first.openTime
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]!.openTime - sorted[i - 1]!.openTime;
    if (delta > maxGapMs) {
      push(start, i);
      start = i;
    }
  }
  push(start, sorted.length);

  const largest = segments.reduce(
    (a, s) => (s.candleCount > a.candleCount ? s : a),
    segments[0]!
  );

  return {
    maxGapMs,
    segments,
    segmentCount: segments.length,
    largestSegmentCandleCount: largest.candleCount,
    largestSegmentSpanMs: largest.spanMs
  };
}

export function sliceSegment(
  candles: ReadonlyArray<Candle>,
  segment: ContinuousSegment
): Candle[] {
  return candles.slice(segment.startIndex, segment.endIndexExclusive);
}
