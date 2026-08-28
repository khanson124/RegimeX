import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { CandleAggregator, detectMissingBuckets } from "./aggregator.js";

const T0 = Date.UTC(2026, 0, 2, 10, 0, 0);

function makeAggregator(): { agg: CandleAggregator; closed: Candle[]; updated: Candle[] } {
  const closed: Candle[] = [];
  const updated: Candle[] = [];
  const agg = new CandleAggregator({
    symbol: "R_10",
    interval: "1m",
    pricePrecision: 3,
    onCandleClosed: (c) => closed.push(c),
    onCandleUpdated: (c) => updated.push(c)
  });
  return { agg, closed, updated };
}

describe("CandleAggregator", () => {
  it("builds OHLC from ticks", () => {
    const { agg } = makeAggregator();
    agg.processTick({ symbol: "R_10", epochMs: T0 + 1000, quote: 100 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 2000, quote: 102 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 3000, quote: 99 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 4000, quote: 101 });
    const c = agg.currentCandle!;
    expect(c.open).toBe(100);
    expect(c.high).toBe(102);
    expect(c.low).toBe(99);
    expect(c.close).toBe(101);
    expect(c.tickCount).toBe(4);
    expect(c.isComplete).toBe(false);
  });

  it("closes candles deterministically on bucket boundaries", () => {
    const { agg, closed } = makeAggregator();
    agg.processTick({ symbol: "R_10", epochMs: T0 + 1000, quote: 100 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 61_000, quote: 105 });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.isComplete).toBe(true);
    expect(closed[0]!.openTime).toBe(T0);
    expect(closed[0]!.closeTime).toBe(T0 + 60_000);
    expect(agg.currentCandle!.openTime).toBe(T0 + 60_000);
  });

  it("ignores duplicate and out-of-order ticks", () => {
    const { agg } = makeAggregator();
    agg.processTick({ symbol: "R_10", epochMs: T0 + 2000, quote: 100 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 2000, quote: 500 }); // duplicate epoch
    agg.processTick({ symbol: "R_10", epochMs: T0 + 1000, quote: 500 }); // out of order
    const c = agg.currentCandle!;
    expect(c.high).toBe(100);
    expect(c.tickCount).toBe(1);
  });

  it("records gaps when ticks skip buckets", () => {
    const { agg, closed } = makeAggregator();
    agg.processTick({ symbol: "R_10", epochMs: T0 + 1000, quote: 100 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 3 * 60_000 + 1000, quote: 101 });
    expect(closed).toHaveLength(1);
    const gaps = agg.drainGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.fromCloseTime).toBe(T0 + 60_000);
  });

  it("flushIfExpired closes a candle when no ticks arrive", () => {
    const { agg, closed } = makeAggregator();
    agg.processTick({ symbol: "R_10", epochMs: T0 + 1000, quote: 100 });
    agg.flushIfExpired(T0 + 59_000);
    expect(closed).toHaveLength(0);
    agg.flushIfExpired(T0 + 60_000);
    expect(closed).toHaveLength(1);
  });

  it("emits configured provenance source", () => {
    const closed: Candle[] = [];
    const agg = new CandleAggregator({
      symbol: "R_10",
      interval: "1m",
      pricePrecision: 3,
      source: "MT5_LIVE_TICKS",
      onCandleClosed: (c) => closed.push(c)
    });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 1000, quote: 100 });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 61_000, quote: 101 });
    expect(closed[0]!.source).toBe("MT5_LIVE_TICKS");
  });

  it("restores state after a restart", () => {
    const { agg, closed } = makeAggregator();
    agg.restore({
      symbol: "R_10",
      interval: "1m",
      openTime: T0,
      closeTime: T0 + 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      tickCount: 5,
      isComplete: false,
      source: "LIVE_TICKS"
    });
    agg.processTick({ symbol: "R_10", epochMs: T0 + 30_000, quote: 103 });
    expect(agg.currentCandle!.high).toBe(103);
    expect(agg.currentCandle!.tickCount).toBe(6);
    agg.processTick({ symbol: "R_10", epochMs: T0 + 61_000, quote: 104 });
    expect(closed).toHaveLength(1);
  });
});

describe("detectMissingBuckets", () => {
  it("finds missing open times", () => {
    const candles = [{ openTime: T0 }, { openTime: T0 + 3 * 60_000 }];
    expect(detectMissingBuckets(candles, "1m")).toEqual([T0 + 60_000, T0 + 2 * 60_000]);
  });

  it("returns empty for contiguous candles", () => {
    const candles = [{ openTime: T0 }, { openTime: T0 + 60_000 }];
    expect(detectMissingBuckets(candles, "1m")).toEqual([]);
  });
});
