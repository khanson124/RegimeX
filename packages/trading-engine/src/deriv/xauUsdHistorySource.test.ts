import { describe, expect, it } from "vitest";
import { toDerivHistoryApiSymbol, toDerivApiSymbol } from "./derivSymbols.js";
import { toDerivResearchHistorySymbol } from "./researchHistorySymbols.js";
import {
  auditXauUsdSessionAwareGaps,
  evaluateXauUsdHistoryLiveParity
} from "../research/xauUsdHistoryParity.js";
import { summarizeObservedSpreadRows } from "../research/observedXauUsdSpread.js";
import { type Candle } from "@regimex/shared";

describe("XAUUSD research history source detection", () => {
  it("maps XAUUSD → frxXAUUSD for HISTORY_API only", () => {
    expect(toDerivResearchHistorySymbol("XAUUSD")).toBe("frxXAUUSD");
    expect(toDerivHistoryApiSymbol("XAUUSD", "3480EH7xcjeMLwUvdv0GP")).toBe("frxXAUUSD");
    // Live/options tick map must NOT invent frx for R_10 path
    expect(toDerivApiSymbol("R_10", "3480EH7xcjeMLwUvdv0GP")).toBe("1HZ10V");
    expect(toDerivHistoryApiSymbol("R_10", "3480EH7xcjeMLwUvdv0GP")).toBe("1HZ10V");
  });

  it("classifies price-scale parity without treating products as identical", () => {
    const good = evaluateXauUsdHistoryLiveParity({
      historicalLastClose: 4405,
      liveMid: 4426
    });
    expect(good.verdict).toBe("MATCH_APPROXIMATE");
    expect(good.historicalApiSymbol).toBe("frxXAUUSD");
    expect(good.liveBrokerSymbol).toBe("XAUUSD");

    const bad = evaluateXauUsdHistoryLiveParity({
      historicalLastClose: 4405,
      liveMid: 2650
    });
    expect(bad.verdict).toBe("MATERIAL_MISMATCH");
  });

  it("treats weekend-sized gaps as expected closures, not corruption", () => {
    const t0 = Date.UTC(2026, 5, 5, 21, 0, 0); // Fri
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        symbol: "XAUUSD",
        interval: "1m",
        openTime: t0 + i * 60_000,
        closeTime: t0 + (i + 1) * 60_000,
        open: 4400,
        high: 4401,
        low: 4399,
        close: 4400.5,
        tickCount: 1,
        isComplete: true,
        source: "HISTORY_API"
      });
    }
    // Jump to Monday (+55h) — expected closure
    const monday = t0 + 55 * 3600_000;
    candles.push({
      symbol: "XAUUSD",
      interval: "1m",
      openTime: monday,
      closeTime: monday + 60_000,
      open: 4410,
      high: 4411,
      low: 4409,
      close: 4410,
      tickCount: 1,
      isComplete: true,
      source: "HISTORY_API"
    });
    // Daily maintenance ~60m — expected
    candles.push({
      symbol: "XAUUSD",
      interval: "1m",
      openTime: monday + 60 * 60_000,
      closeTime: monday + 61 * 60_000,
      open: 4410,
      high: 4411,
      low: 4409,
      close: 4410,
      tickCount: 1,
      isComplete: true,
      source: "HISTORY_API"
    });
    // Unexpected 5-minute hole
    candles.push({
      symbol: "XAUUSD",
      interval: "1m",
      openTime: monday + 60 * 60_000 + 6 * 60_000,
      closeTime: monday + 60 * 60_000 + 7 * 60_000,
      open: 4410,
      high: 4411,
      low: 4409,
      close: 4410,
      tickCount: 1,
      isComplete: true,
      source: "HISTORY_API"
    });

    const audit = auditXauUsdSessionAwareGaps(candles);
    expect(audit.treatedAs247).toBe(false);
    expect(audit.expectedClosureGapCount).toBe(2);
    expect(audit.unexpectedGapCount).toBe(1);
  });

  it("labels observed spread PRELIMINARY below 30 samples", () => {
    const rows = Array.from({ length: 17 }, (_, i) => ({
      symbol: "XAUUSD",
      bid: 4400,
      ask: 4400.27,
      mid: 4400.135,
      spreadPrice: 0.27,
      spreadBps: 0.61,
      spreadPoints: 27,
      brokerQuoteTimestampMs: i,
      localReceivedAtMs: i,
      qualityFlags: [],
      source: "MT5_OBSERVATION_CLI" as const
    }));
    const summary = summarizeObservedSpreadRows(rows);
    expect(summary.status).toBe("PRELIMINARY");
    expect(summary.medianBps).toBeCloseTo(0.61, 2);
    expect(summary.label).toBe("OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST");
  });
});
