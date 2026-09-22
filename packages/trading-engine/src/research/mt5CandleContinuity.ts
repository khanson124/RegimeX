/**
 * MT5 candle continuity checks for research replays (read-only helpers).
 */
import { type Candle } from "@regimex/shared";

export const MT5_CANDLE_SOURCES = ["MT5_LIVE_TICKS", "MT5_HISTORY"] as const;

export interface Mt5ContinuityReport {
  barCount: number;
  firstIso: string | null;
  lastIso: string | null;
  sources: string[];
  duplicateOpenTimes: string[];
  gapCount: number;
  gaps: Array<{ afterIso: string; beforeIso: string; missingMinutes: number }>;
  nonAscending: boolean;
  incompleteRejected: number;
  nonMt5Rejected: number;
  continuous1m: boolean;
}

export function filterMt5CompleteCandles(candlesIn: ReadonlyArray<Candle>): {
  candles: Candle[];
  incompleteRejected: number;
  nonMt5Rejected: number;
} {
  const allowed = new Set<string>(MT5_CANDLE_SOURCES);
  let incompleteRejected = 0;
  let nonMt5Rejected = 0;
  const cleaned: Candle[] = [];
  for (const c of candlesIn) {
    if (!c.isComplete) {
      incompleteRejected += 1;
      continue;
    }
    if (!allowed.has(String(c.source))) {
      nonMt5Rejected += 1;
      continue;
    }
    cleaned.push(c);
  }
  cleaned.sort((a, b) => a.openTime - b.openTime);
  return { candles: cleaned, incompleteRejected, nonMt5Rejected };
}

export function assertMt5CandleContinuity(candlesIn: ReadonlyArray<Candle>): {
  candles: Candle[];
  report: Mt5ContinuityReport;
} {
  const { candles: cleaned, incompleteRejected, nonMt5Rejected } =
    filterMt5CompleteCandles(candlesIn);

  const seen = new Set<number>();
  const duplicateOpenTimes: string[] = [];
  const deduped: Candle[] = [];
  for (const c of cleaned) {
    if (seen.has(c.openTime)) {
      duplicateOpenTimes.push(new Date(c.openTime).toISOString());
      continue;
    }
    seen.add(c.openTime);
    deduped.push(c);
  }

  let nonAscending = false;
  const gaps: Mt5ContinuityReport["gaps"] = [];
  for (let i = 1; i < deduped.length; i++) {
    const prev = deduped[i - 1]!;
    const cur = deduped[i]!;
    if (cur.openTime < prev.openTime) nonAscending = true;
    const dt = cur.openTime - prev.openTime;
    if (dt !== 60_000) {
      gaps.push({
        afterIso: new Date(prev.openTime).toISOString(),
        beforeIso: new Date(cur.openTime).toISOString(),
        missingMinutes: Math.max(0, Math.round(dt / 60_000) - 1)
      });
    }
  }

  return {
    candles: deduped,
    report: {
      barCount: deduped.length,
      firstIso: deduped[0] ? new Date(deduped[0].openTime).toISOString() : null,
      lastIso: deduped.length
        ? new Date(deduped[deduped.length - 1]!.openTime).toISOString()
        : null,
      sources: [...new Set(deduped.map((c) => String(c.source)))],
      duplicateOpenTimes,
      gapCount: gaps.length,
      gaps: gaps.slice(0, 20),
      nonAscending,
      incompleteRejected,
      nonMt5Rejected,
      continuous1m: gaps.length === 0 && !nonAscending && deduped.length > 0
    }
  };
}
