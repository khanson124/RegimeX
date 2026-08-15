import { describe, expect, it } from "vitest";
import {
  bollingerBands,
  consecutiveHigherHighs,
  consecutiveLowerLows,
  donchianChannel,
  ema,
  highestHigh,
  lowestLow,
  macd,
  percentileRank,
  rateOfChange,
  rollingMedian,
  rollingStdDev,
  rsi,
  sma,
  trendSlope
} from "./series.js";

describe("sma", () => {
  it("returns null until enough history", () => {
    expect(sma([1, 2, 3], 3)).toEqual([null, null, 2]);
  });

  it("computes rolling averages", () => {
    expect(sma([1, 2, 3, 4, 5], 2)).toEqual([null, 1.5, 2.5, 3.5, 4.5]);
  });
});

describe("ema", () => {
  it("seeds with SMA and smooths after", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(2); // seed = SMA(1,2,3)
    expect(out[3]).toBeCloseTo(3, 10); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it("has no look-ahead: past values unchanged by future data", () => {
    const short = ema([1, 2, 3, 4], 3);
    const long = ema([1, 2, 3, 4, 100, -50], 3);
    expect(long.slice(0, 4)).toEqual(short);
  });
});

describe("rsi", () => {
  it("is 100 for straight gains", () => {
    const out = rsi([1, 2, 3, 4, 5, 6], 5);
    expect(out[5]).toBe(100);
  });

  it("is 0 for straight losses after the seed period", () => {
    const values = [10, 9, 8, 7, 6, 5, 4];
    const out = rsi(values, 5);
    expect(out[5]).toBe(0);
  });

  it("returns null with insufficient history", () => {
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).toBe(true);
  });
});

describe("bollingerBands", () => {
  it("brackets the mean symmetrically", () => {
    const values = [1, 2, 3, 4, 5];
    const out = bollingerBands(values, 5, 2);
    const last = out[4]!;
    expect(last.middle).toBe(3);
    expect(last.upper - last.middle).toBeCloseTo(last.middle - last.lower, 10);
    expect(last.width).toBeGreaterThan(0);
  });
});

describe("macd", () => {
  it("produces histogram = macd - signal", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i);
    const out = macd(values, 5, 10, 3);
    const last = out[59]!;
    expect(last.histogram).toBeCloseTo(last.macd - last.signal, 10);
  });
});

describe("rateOfChange", () => {
  it("returns fraction change", () => {
    expect(rateOfChange([100, 110], 1)[1]).toBeCloseTo(0.1, 10);
  });
});

describe("donchianChannel / highestHigh / lowestLow", () => {
  it("excludes the current bar so breakouts are detectable", () => {
    const highs = [1, 2, 3, 10];
    const lows = [0, 1, 2, 9];
    const out = donchianChannel(highs, lows, 3);
    expect(out[3]!.upper).toBe(3); // previous 3 bars only
    expect(out[3]!.lower).toBe(0);
    expect(highestHigh(highs, 3)[3]).toBe(3);
    expect(lowestLow(lows, 3)[3]).toBe(0);
  });
});

describe("rollingStdDev", () => {
  it("is 0 for constant series", () => {
    expect(rollingStdDev([5, 5, 5, 5], 3)[3]).toBe(0);
  });
});

describe("trendSlope", () => {
  it("is positive for rising series and negative for falling", () => {
    const up = trendSlope([1, 2, 3, 4, 5], 5)[4]!;
    const down = trendSlope([5, 4, 3, 2, 1], 5)[4]!;
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
  });
});

describe("consecutive counts", () => {
  it("counts higher highs streaks", () => {
    expect(consecutiveHigherHighs([1, 2, 3, 2, 3])).toEqual([0, 1, 2, 0, 1]);
  });

  it("counts lower lows streaks", () => {
    expect(consecutiveLowerLows([3, 2, 1, 2, 1])).toEqual([0, 1, 2, 0, 1]);
  });
});

describe("percentileRank", () => {
  it("ranks the max at 100", () => {
    const out = percentileRank([1, 2, 3, 4, 5], 5);
    expect(out[4]).toBe(100);
  });
});

describe("rollingMedian", () => {
  it("computes median of window", () => {
    expect(rollingMedian([1, 100, 2, 3], 3)[3]).toBe(3);
  });
});
