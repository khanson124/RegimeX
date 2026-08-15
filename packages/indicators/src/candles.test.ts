import { describe, expect, it } from "vitest";
import {
  adx,
  atr,
  atrPercent,
  candleBodySize,
  candleRange,
  distanceFromEma,
  lowerWickSize,
  trueRange,
  upperWickSize
} from "./candles.js";
import { type OhlcCandle } from "./types.js";

function c(open: number, high: number, low: number, close: number): OhlcCandle {
  return { open, high, low, close };
}

describe("trueRange", () => {
  it("uses gap from previous close", () => {
    const candles = [c(10, 12, 9, 11), c(15, 16, 14, 15)];
    const tr = trueRange(candles);
    expect(tr[0]).toBe(3);
    expect(tr[1]).toBe(5); // |16 - 11| dominates
  });
});

describe("atr", () => {
  it("returns null until period is filled", () => {
    const candles = Array.from({ length: 5 }, () => c(10, 11, 9, 10));
    const out = atr(candles, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(2);
    expect(out[4]).toBe(2);
  });

  it("no look-ahead: adding future candles does not alter history", () => {
    const base = Array.from({ length: 10 }, (_, i) => c(10 + i, 12 + i, 9 + i, 11 + i));
    const extended = [...base, c(100, 200, 50, 60)];
    expect(atr(extended, 5).slice(0, 10)).toEqual(atr(base, 5));
  });
});

describe("atrPercent", () => {
  it("normalizes by close", () => {
    const candles = Array.from({ length: 3 }, () => c(100, 102, 98, 100));
    const out = atrPercent(candles, 3);
    expect(out[2]).toBeCloseTo(0.04, 10);
  });
});

describe("adx", () => {
  it("is high in a persistent trend", () => {
    const candles = Array.from({ length: 60 }, (_, i) => c(100 + i, 101 + i, 99 + i, 100.8 + i));
    const out = adx(candles, 14);
    expect(out[59]).not.toBeNull();
    expect(out[59]!).toBeGreaterThan(25);
  });

  it("returns null with insufficient history", () => {
    const candles = Array.from({ length: 10 }, () => c(10, 11, 9, 10));
    expect(adx(candles, 14).every((v) => v === null)).toBe(true);
  });
});

describe("candle anatomy", () => {
  const candle = c(10, 14, 8, 12);
  it("body / wicks / range", () => {
    expect(candleBodySize([candle])[0]).toBe(2);
    expect(upperWickSize([candle])[0]).toBe(2); // 14 - max(10,12)
    expect(lowerWickSize([candle])[0]).toBe(2); // min(10,12) - 8
    expect(candleRange([candle])[0]).toBe(6);
  });
});

describe("distanceFromEma", () => {
  it("is positive when price above EMA", () => {
    const candles = Array.from({ length: 10 }, (_, i) => c(10 + i, 10 + i, 10 + i, 10 + i));
    const out = distanceFromEma(candles, 5);
    expect(out[9]!).toBeGreaterThan(0);
  });
});
