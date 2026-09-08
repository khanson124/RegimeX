import { describe, expect, it } from "vitest";
import { CandleAggregator } from "../candles/aggregator.js";
import {
  accountWideCapacityRemaining,
  engineSessionKey,
  listSessionKeysForUser,
  parseEngineSessionKey
} from "./multiSymbolSessions.js";

describe("multi-symbol session keys", () => {
  it("keys sessions by userId::symbol without colliding", () => {
    expect(engineSessionKey("u1", "R_10")).toBe("u1::R_10");
    expect(engineSessionKey("u1", "XAUUSD")).toBe("u1::XAUUSD");
    expect(parseEngineSessionKey("u1::XAUUSD")).toEqual({ userId: "u1", symbol: "XAUUSD" });
    expect(
      listSessionKeysForUser(["u1::R_10", "u1::XAUUSD", "u2::R_10", "u1"], "u1").sort()
    ).toEqual(["u1", "u1::R_10", "u1::XAUUSD"]);
  });

  it("treats max concurrent positions as account-wide across symbols", () => {
    expect(
      accountWideCapacityRemaining({
        maxConcurrentPositions: 5,
        consumedSlotsAcrossAllSymbols: 4
      })
    ).toEqual({ remaining: 1, blocked: false, reason: null });

    const blocked = accountWideCapacityRemaining({
      maxConcurrentPositions: 5,
      consumedSlotsAcrossAllSymbols: 5
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe("ACCOUNT_WIDE_MAX_CONCURRENT_POSITIONS_REACHED");

    // 1 R_10 + 1 XAUUSD with max=1 must block the second open account-wide.
    expect(
      accountWideCapacityRemaining({
        maxConcurrentPositions: 1,
        consumedSlotsAcrossAllSymbols: 1
      }).blocked
    ).toBe(true);
  });
});

describe("independent per-symbol candle buffers", () => {
  it("does not contaminate R_10 and XAUUSD aggregators on concurrent ticks", () => {
    const closed: Array<{ symbol: string; close: number }> = [];
    const r10 = new CandleAggregator({
      symbol: "R_10",
      interval: "1m",
      pricePrecision: 3,
      onCandleClosed: (c) => closed.push({ symbol: c.symbol, close: c.close })
    });
    const xau = new CandleAggregator({
      symbol: "XAUUSD",
      interval: "1m",
      pricePrecision: 2,
      onCandleClosed: (c) => closed.push({ symbol: c.symbol, close: c.close })
    });

    const t0 = Date.UTC(2026, 0, 1, 12, 0, 10);
    r10.processTick({ symbol: "R_10", epochMs: t0, quote: 1000.5 });
    xau.processTick({ symbol: "XAUUSD", epochMs: t0, quote: 2650.25 });
    // Wrong-symbol ticks must be ignored by each aggregator.
    r10.processTick({ symbol: "XAUUSD", epochMs: t0 + 1, quote: 9999 });
    xau.processTick({ symbol: "R_10", epochMs: t0 + 1, quote: 1 });

    expect(r10.currentCandle?.close).toBe(1000.5);
    expect(xau.currentCandle?.close).toBe(2650.25);

    const tNext = Date.UTC(2026, 0, 1, 12, 1, 5);
    r10.processTick({ symbol: "R_10", epochMs: tNext, quote: 1001 });
    xau.processTick({ symbol: "XAUUSD", epochMs: tNext, quote: 2651 });

    expect(closed).toEqual([
      { symbol: "R_10", close: 1000.5 },
      { symbol: "XAUUSD", close: 2650.25 }
    ]);
    expect(r10.currentCandle?.close).toBe(1001);
    expect(xau.currentCandle?.close).toBe(2651);
  });
});
