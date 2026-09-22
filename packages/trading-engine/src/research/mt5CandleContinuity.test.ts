import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { assertMt5CandleContinuity } from "./mt5CandleContinuity.js";

function bar(openTime: number, source = "MT5_LIVE_TICKS", overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime,
    closeTime: openTime + 60_000,
    open: 5020,
    high: 5022,
    low: 5019,
    close: 5021,
    tickCount: 10,
    isComplete: true,
    source: source as Candle["source"],
    ...overrides
  };
}

describe("assertMt5CandleContinuity", () => {
  it("rejects HISTORY_API and incomplete bars", () => {
    const t0 = Date.UTC(2026, 8, 21, 9, 0, 0);
    const { candles, report } = assertMt5CandleContinuity([
      bar(t0, "HISTORY_API"),
      bar(t0 + 60_000, "MT5_LIVE_TICKS", { isComplete: false }),
      bar(t0 + 120_000, "MT5_LIVE_TICKS")
    ]);
    expect(report.nonMt5Rejected).toBe(1);
    expect(report.incompleteRejected).toBe(1);
    expect(candles).toHaveLength(1);
  });

  it("flags duplicate openTimes and 1m gaps", () => {
    const t0 = Date.UTC(2026, 8, 21, 9, 0, 0);
    const { report } = assertMt5CandleContinuity([
      bar(t0),
      bar(t0),
      bar(t0 + 120_000)
    ]);
    expect(report.duplicateOpenTimes).toHaveLength(1);
    expect(report.gapCount).toBe(1);
    expect(report.continuous1m).toBe(false);
  });

  it("passes continuous MT5 1m series", () => {
    const t0 = Date.UTC(2026, 8, 21, 9, 0, 0);
    const series = Array.from({ length: 5 }, (_, i) => bar(t0 + i * 60_000));
    const { report } = assertMt5CandleContinuity(series);
    expect(report.continuous1m).toBe(true);
    expect(report.barCount).toBe(5);
    expect(report.gapCount).toBe(0);
    expect(report.duplicateOpenTimes).toHaveLength(0);
  });
});
