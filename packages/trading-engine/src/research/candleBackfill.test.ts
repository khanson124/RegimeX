import { describe, expect, it } from "vitest";
import { validateHistoricalCandle, ohlcConflict } from "./candleValidation.js";
import { planBackfillBatch, nextBackfillCursorMs, DERIV_CANDLE_HISTORY_MAX_CANDLES } from "./candleBackfill.js";
import { detectContinuousSegments, sliceSegment } from "./gapSegments.js";
import { buildResearchDatasetManifest, hashCandleSeries } from "./researchDatasetManifest.js";
import { type Candle } from "@regimex/shared";

function c(i: number, overrides: Partial<Candle> = {}): Candle {
  const t = Date.UTC(2026, 4, 1) + i * 60_000;
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: t,
    closeTime: t + 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    tickCount: 0,
    isComplete: true,
    source: "HISTORY_API",
    ...overrides
  };
}

describe("candleValidation", () => {
  it("rejects invalid OHLC and misaligned timestamps", () => {
    const bad = c(0, { high: 90, low: 95 });
    expect(validateHistoricalCandle(bad, { symbol: "R_10", interval: "1m" }).ok).toBe(false);
    const misaligned = c(0, { openTime: Date.UTC(2026, 4, 1) + 30_000 });
    expect(
      validateHistoricalCandle(misaligned, { symbol: "R_10", interval: "1m" }).failures
    ).toContain("TIMESTAMP_MISALIGNED");
  });

  it("accepts valid candle", () => {
    expect(validateHistoricalCandle(c(0), { symbol: "R_10", interval: "1m" }).ok).toBe(true);
  });

  it("detects OHLC conflicts", () => {
    expect(ohlcConflict({ open: 1, high: 2, low: 0.5, close: 1.5 }, { open: 1, high: 2, low: 0.5, close: 1.5 })).toBe(
      false
    );
    expect(ohlcConflict({ open: 1, high: 2, low: 0.5, close: 1.5 }, { open: 1, high: 2, low: 0.5, close: 1.6 })).toBe(
      true
    );
  });
});

describe("planBackfillBatch", () => {
  it("inserts new, skips duplicates, logs conflicts, rejects invalid", () => {
    const existing = new Map([
      [
        c(0).openTime,
        {
          openTimeMs: c(0).openTime,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          source: "LIVE_TICKS"
        }
      ],
      [
        c(1).openTime,
        {
          openTimeMs: c(1).openTime,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          source: "HISTORY_API"
        }
      ]
    ]);
    const plan = planBackfillBatch({
      fetched: [
        { openTimeMs: c(0).openTime, open: 100, high: 101, low: 99, close: 100.5 }, // exact dup
        { openTimeMs: c(1).openTime, open: 100, high: 120, low: 99, close: 111 }, // conflict (valid OHLC)
        { openTimeMs: c(2).openTime, open: 100, high: 101, low: 99, close: 100.2 }, // insert
        { openTimeMs: c(3).openTime, open: 100, high: 90, low: 99, close: 100 } // invalid
      ],
      existingByOpenTime: existing,
      symbol: "R_10",
      interval: "1m",
      source: "HISTORY_API"
    });
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.toInsert[0]!.openTime).toBe(c(2).openTime);
    expect(plan.duplicatesSkipped).toBeGreaterThanOrEqual(1);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.invalid.length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent for identical incoming vs existing", () => {
    const t = c(5).openTime;
    const existing = new Map([
      [t, { openTimeMs: t, open: 1, high: 2, low: 0.5, close: 1.2, source: "HISTORY_API" }]
    ]);
    const a = planBackfillBatch({
      fetched: [{ openTimeMs: t, open: 1, high: 2, low: 0.5, close: 1.2 }],
      existingByOpenTime: existing,
      symbol: "R_10",
      interval: "1m",
      source: "HISTORY_API"
    });
    const b = planBackfillBatch({
      fetched: [{ openTimeMs: t, open: 1, high: 2, low: 0.5, close: 1.2 }],
      existingByOpenTime: existing,
      symbol: "R_10",
      interval: "1m",
      source: "HISTORY_API"
    });
    expect(a).toEqual(b);
    expect(a.toInsert).toHaveLength(0);
  });
});

describe("nextBackfillCursorMs", () => {
  const step = 60_000;
  it("advances to batchEnd when window fits API max", () => {
    const cursor = Date.UTC(2026, 5, 1);
    const batchEnd = cursor + 1000 * step;
    const times = Array.from({ length: 1000 }, (_, i) => cursor + i * step);
    const r = nextBackfillCursorMs({
      cursorMs: cursor,
      batchEndMs: batchEnd,
      stepMs: step,
      fetchedOpenTimesMs: times,
      maxCandlesPerRequest: DERIV_CANDLE_HISTORY_MAX_CANDLES
    });
    expect(r.nextCursorMs).toBe(batchEnd);
    expect(r.truncatedLeading).toBe(false);
  });

  it("detects trailing-window truncation on oversized batches", () => {
    const cursor = Date.UTC(2026, 5, 1);
    const batchEnd = cursor + 4500 * step;
    // API returns only last 1000 of the window
    const firstReturned = batchEnd - 1000 * step;
    const times = Array.from({ length: 1000 }, (_, i) => firstReturned + i * step);
    const r = nextBackfillCursorMs({
      cursorMs: cursor,
      batchEndMs: batchEnd,
      stepMs: step,
      fetchedOpenTimesMs: times,
      maxCandlesPerRequest: DERIV_CANDLE_HISTORY_MAX_CANDLES
    });
    expect(r.truncatedLeading).toBe(true);
    expect(r.nextCursorMs).toBe(firstReturned);
  });

  it("advances empty windows to batchEnd", () => {
    const cursor = Date.UTC(2026, 5, 1);
    const batchEnd = cursor + 1000 * step;
    expect(
      nextBackfillCursorMs({
        cursorMs: cursor,
        batchEndMs: batchEnd,
        stepMs: step,
        fetchedOpenTimesMs: []
      }).nextCursorMs
    ).toBe(batchEnd);
  });
});

describe("gapSegments", () => {
  it("splits on large gaps and supports slice", () => {
    const candles = [c(0), c(1), c(2), c(100), c(101)];
    const report = detectContinuousSegments(candles, 2 * 60_000);
    expect(report.segmentCount).toBe(2);
    expect(report.segments[0]!.candleCount).toBe(3);
    expect(report.segments[1]!.candleCount).toBe(2);
    const s0 = sliceSegment(candles, report.segments[0]!);
    expect(s0).toHaveLength(3);
  });

  it("does not treat contiguous 5m bars as gaps when maxGapMs is 2*bar", () => {
    const bars = Array.from({ length: 10 }, (_, i) => {
      const t = Date.UTC(2026, 4, 1) + i * 300_000;
      return {
        symbol: "R_10",
        interval: "5m" as const,
        openTime: t,
        closeTime: t + 300_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        tickCount: 0,
        isComplete: true,
        source: "HISTORY_API" as const
      };
    });
    // Bug regression: using 2m threshold on 5m tape would create 10 segments.
    expect(detectContinuousSegments(bars, 2 * 60_000).segmentCount).toBe(10);
    expect(detectContinuousSegments(bars, 2 * 300_000).segmentCount).toBe(1);
  });
});

describe("researchDatasetManifest", () => {
  it("hashes deterministically", () => {
    const candles = [c(0), c(1)];
    expect(hashCandleSeries(candles)).toBe(hashCandleSeries(candles));
    const m = buildResearchDatasetManifest({
      datasetId: "test",
      symbol: "R_10",
      interval: "1m",
      sources: ["HISTORY_API"],
      candles
    });
    expect(m.rowCount).toBe(2);
    expect(m.contentHash.length).toBe(64);
  });
});
