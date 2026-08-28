import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  validateCandleOhlc,
  validateCloseDiscontinuity,
  validateCandleSeriesContinuity
} from "./candleIntegrity.js";

function candle(partial: Partial<Candle> & Pick<Candle, "open" | "high" | "low" | "close">): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: 0,
    closeTime: 60_000,
    tickCount: 1,
    isComplete: true,
    source: "MT5_LIVE_TICKS",
    ...partial
  };
}

describe("validateCandleOhlc", () => {
  it("accepts structurally valid OHLC", () => {
    expect(validateCandleOhlc({ open: 100, high: 102, low: 99, close: 101 }).valid).toBe(true);
  });

  it("structural OHLC passes but close discontinuity catches mixed-domain contamination", () => {
    const contaminated = { open: 4783.034, high: 9791.47, low: 4782.653, close: 9790.46 };
    expect(validateCandleOhlc(contaminated).valid).toBe(true);
    const jump = validateCloseDiscontinuity(4783.034, 9790.46);
    expect(jump.valid).toBe(false);
    expect(jump.code).toBe("CLOSE_JUMP");
  });

  it("rejects non-finite and inverted OHLC", () => {
    expect(validateCandleOhlc({ open: NaN, high: 1, low: 1, close: 1 }).code).toBe("NON_FINITE");
    expect(validateCandleOhlc({ open: 1, high: 0.5, low: 1, close: 1 }).code).toBe("HIGH_LOW_INVERTED");
  });
});

describe("validateCloseDiscontinuity", () => {
  it("F: accepts normal consecutive MT5 candles", () => {
    expect(validateCloseDiscontinuity(4783.1, 4784.2).valid).toBe(true);
    expect(validateCloseDiscontinuity(4784.2, 4783.8).valid).toBe(true);
  });

  it("rejects large close jumps indicative of mixed domains", () => {
    expect(validateCloseDiscontinuity(4783, 9790).valid).toBe(false);
  });
});

describe("validateCandleSeriesContinuity", () => {
  it("accepts a contiguous MT5 series", () => {
    const series = [
      candle({ open: 4780, high: 4782, low: 4779, close: 4781 }),
      candle({ open: 4781, high: 4783, low: 4780, close: 4782 })
    ];
    expect(validateCandleSeriesContinuity(series).valid).toBe(true);
  });

  it("rejects mixed-domain series", () => {
    const series = [
      candle({ open: 4783, high: 4785, low: 4782, close: 4783 }),
      candle({ open: 9790, high: 9792, low: 9788, close: 9791 })
    ];
    expect(validateCandleSeriesContinuity(series).valid).toBe(false);
  });
});
