/**
 * MT5 historical warm-up + provenance merge tests.
 */
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { type Mt5Bar } from "../broker/mt5/types.js";
import {
  BROKER_SYMBOL_MAPPING_MISSING,
  BROKER_SYMBOL_MAPPING_UNVERIFIED
} from "../broker/mt5/brokerSymbolMapping.js";
import {
  filterRestorableMt5Candles,
  isMt5MarketDataReady,
  mergeMt5TrustedCandles,
  shouldIngestMt5ClosedCandle,
  validateIncomingMt5Candle
} from "./mt5MarketData.js";
import {
  assembleMt5HistoricalWarmup,
  classifyMt5OpenTimeGap,
  computeMt5WarmupFetchCount,
  MT5_WARMUP_DEMO_REQUIRED,
  MT5_WARMUP_INSUFFICIENT_HISTORY,
  mt5BarToHistoryCandle,
  planMt5HistoricalWarmup,
  shouldPersistMt5HistoryCandle
} from "./mt5HistoricalWarmup.js";
import { completedSessionAwareHtfBarsAsOf } from "../strategies/xauTrendPullbackHtf.js";
import { XauTrendPullbackStrategy } from "../strategies/xauTrendPullback.js";
import { extractFeatures } from "../features/featureExtractor.js";
import { XAU_TREND_PULLBACK_DEFAULTS } from "../strategies/xauTrendPullback.js";

const XAU_REQ = {
  status: "REQUIRES_BARS" as const,
  requiredBars: 120,
  eligibleStrategyIds: ["xau-trend-pullback-v1"] as const
};

const verifiedMapping = {
  internalSymbol: "XAUUSD",
  brokerSymbol: "XAUUSD",
  verified: true,
  venue: "MT5",
  executionMode: "broker_demo_mt5"
};

function hist(
  i: number,
  opts?: Partial<Candle>,
  base = Date.UTC(2026, 0, 5, 0, 0, 0)
): Candle {
  const openTime = base + i * 900_000;
  const close = 2000 + i * 0.01;
  return {
    symbol: "XAUUSD",
    interval: "15m",
    openTime,
    closeTime: openTime + 900_000,
    open: close - 0.05,
    high: close + 0.1,
    low: close - 0.1,
    close,
    tickCount: 5,
    isComplete: true,
    source: "MT5_HISTORY",
    ...opts
  };
}

function live(i: number, opts?: Partial<Candle>): Candle {
  return hist(i, { source: "MT5_LIVE_TICKS", ...opts });
}

function mt5Bar(i: number, base = Date.UTC(2026, 0, 5, 0, 0, 0)): Mt5Bar {
  const openTimeMs = base + i * 900_000;
  const close = 2000 + i * 0.01;
  return {
    symbol: "XAUUSD",
    timeframe: "15m",
    openTimeMs,
    closeTimeMs: openTimeMs + 900_000,
    brokerServerOpenTimeMs: openTimeMs,
    open: close - 0.05,
    high: close + 0.1,
    low: close - 0.1,
    close,
    tickVolume: 5,
    realVolume: null,
    spreadPoints: 20,
    source: "MT5",
    isComplete: true
  };
}

describe("computeMt5WarmupFetchCount", () => {
  it("1000 history bars need no fetch", () => {
    expect(computeMt5WarmupFetchCount({ requiredBars: 1000, persistedTrustedBars: 1000 })).toEqual({
      missing: 0,
      fetchCount: 0,
      needsFetch: false
    });
  });

  it("999 bars trigger historical fetch covering full requirement + overlap", () => {
    const r = computeMt5WarmupFetchCount({ requiredBars: 1000, persistedTrustedBars: 999 });
    expect(r.needsFetch).toBe(true);
    expect(r.missing).toBe(1);
    expect(r.fetchCount).toBe(1010);
  });

  it("persisted 300 + fetch plans for 1000+overlap window", () => {
    const r = computeMt5WarmupFetchCount({ requiredBars: 1000, persistedTrustedBars: 300 });
    expect(r.missing).toBe(700);
    expect(r.fetchCount).toBe(1010);
  });
});

describe("merge / provenance", () => {
  it("mixed MT5_HISTORY + MT5_LIVE_TICKS works", () => {
    const r = filterRestorableMt5Candles([hist(0), hist(1), live(2), live(3)]);
    expect(r.rejected).toBe(false);
    expect(r.candles).toHaveLength(4);
    expect(r.candles.map((c) => c.source)).toEqual([
      "MT5_HISTORY",
      "MT5_HISTORY",
      "MT5_LIVE_TICKS",
      "MT5_LIVE_TICKS"
    ]);
  });

  it("overlapping live candle wins over history candle", () => {
    const history = hist(5, { close: 2005, open: 2004.9, high: 2005.1, low: 2004.8 });
    const liveBar = live(5, { close: 2005.01, open: 2004.91, high: 2005.11, low: 2004.81 });
    const merged = mergeMt5TrustedCandles({ history: [history], live: [liveBar] });
    expect(merged.rejected).toBe(false);
    expect(merged.candles).toHaveLength(1);
    expect(merged.candles[0]!.source).toBe("MT5_LIVE_TICKS");
    expect(merged.candles[0]!.close).toBe(2005.01);
  });

  it("no duplicate bucket remains after merge", () => {
    const merged = mergeMt5TrustedCandles({
      history: [hist(1), hist(1)],
      live: [live(1)]
    });
    expect(merged.rejected).toBe(false);
    expect(merged.candles).toHaveLength(1);
  });

  it("HISTORY_API rejected", () => {
    const r = filterRestorableMt5Candles([
      { ...hist(0), source: "HISTORY_API" },
      hist(1)
    ]);
    expect(r.rejected).toBe(true);
    expect(r.candles).toEqual([]);
  });

  it("LIVE_TICKS rejected", () => {
    const r = filterRestorableMt5Candles([{ ...hist(0), source: "LIVE_TICKS" }]);
    expect(r.rejected).toBe(true);
  });

  it("never downgrade MT5_LIVE_TICKS when persisting history", () => {
    expect(shouldPersistMt5HistoryCandle("MT5_LIVE_TICKS")).toBe(false);
    expect(shouldPersistMt5HistoryCandle("MT5_HISTORY")).toBe(true);
    expect(shouldPersistMt5HistoryCandle(null)).toBe(true);
  });

  it("live ingest requires MT5_LIVE_TICKS (not MT5_HISTORY)", () => {
    expect(shouldIngestMt5ClosedCandle(hist(1), 2000)).toBe(false);
    expect(validateIncomingMt5Candle(hist(1), 2000).reason).toMatch(/MT5_LIVE_TICKS/);
    expect(shouldIngestMt5ClosedCandle(live(1), 2000)).toBe(true);
  });

  it("material disagreement fails closed", () => {
    const merged = mergeMt5TrustedCandles({
      history: [hist(0, { close: 2000 })],
      live: [live(0, { close: 2500, open: 2499, high: 2501, low: 2498 })]
    });
    expect(merged.rejected).toBe(true);
  });
});

describe("planMt5HistoricalWarmup gates", () => {
  it("verified broker mapping required; unverified blocks fetch", () => {
    const missing = planMt5HistoricalWarmup({
      requirement: XAU_REQ,
      persistedCandles: [],
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: null,
      isDemoAccount: true
    });
    expect(missing.status).toBe("BLOCKED");
    expect(missing.reason).toBe(BROKER_SYMBOL_MAPPING_MISSING);

    const unverified = planMt5HistoricalWarmup({
      requirement: XAU_REQ,
      persistedCandles: [],
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: { ...verifiedMapping, verified: false },
      isDemoAccount: true
    });
    expect(unverified.status).toBe("BLOCKED");
    expect(unverified.reason).toBe(BROKER_SYMBOL_MAPPING_UNVERIFIED);
  });

  it("demo environment required", () => {
    const plan = planMt5HistoricalWarmup({
      requirement: XAU_REQ,
      persistedCandles: [],
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: verifiedMapping,
      isDemoAccount: false
    });
    expect(plan.status).toBe("BLOCKED");
    expect(plan.reason).toBe(MT5_WARMUP_DEMO_REQUIRED);
  });

  it("120 MT5_HISTORY bars satisfy XAU M15 warm-up without fetch", () => {
    const bars = Array.from({ length: 120 }, (_, i) => hist(i));
    const plan = planMt5HistoricalWarmup({
      requirement: XAU_REQ,
      persistedCandles: bars,
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: verifiedMapping,
      isDemoAccount: true
    });
    expect(plan.status).toBe("SKIP");
    expect(isMt5MarketDataReady(bars, XAU_REQ).ready).toBe(true);
  });
});

describe("assembleMt5HistoricalWarmup", () => {
  it("persisted 30 + fetched window reaches M15 readiness at 120", () => {
    const persisted = Array.from({ length: 30 }, (_, i) => live(100 + i));
    const fetched = Array.from({ length: 130 }, (_, i) => mt5Bar(i));
    const plan = planMt5HistoricalWarmup({
      requirement: XAU_REQ,
      persistedCandles: persisted,
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: verifiedMapping,
      isDemoAccount: true
    });
    expect(plan.status).toBe("FETCH");
    expect(plan.fetchCount).toBe(130);
    const result = assembleMt5HistoricalWarmup({
      plan,
      requirement: XAU_REQ,
      persistedCandles: persisted,
      fetchedBars: fetched,
      engineSymbol: "XAUUSD",
      interval: "15m"
    });
    expect(result.status).toBe("READY");
    expect(result.candles.length).toBeGreaterThanOrEqual(120);
  });

  it("current forming M15 bar excluded; completedBarsOnly enforced", () => {
    const formingOpen = Math.floor(Date.now() / 900_000) * 900_000;
    const completed = mt5Bar(0, formingOpen - 900_000);
    const forming: Mt5Bar = {
      ...mt5Bar(0, formingOpen),
      isComplete: false,
      closeTimeMs: formingOpen + 900_000
    };
    const plan = planMt5HistoricalWarmup({
      requirement: { status: "REQUIRES_BARS", requiredBars: 1, eligibleStrategyIds: ["x"] },
      persistedCandles: [],
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: verifiedMapping,
      isDemoAccount: true
    });
    const result = assembleMt5HistoricalWarmup({
      plan,
      requirement: { status: "REQUIRES_BARS", requiredBars: 1, eligibleStrategyIds: ["x"] },
      persistedCandles: [],
      fetchedBars: [completed, forming],
      engineSymbol: "XAUUSD",
      interval: "15m"
    });
    expect(result.candles.every((c) => c.isComplete)).toBe(true);
    expect(result.candles.every((c) => c.openTime < formingOpen)).toBe(true);
  });

  it("insufficient broker history remains blocked / NO_TRADE ready=false", () => {
    const plan = planMt5HistoricalWarmup({
      requirement: XAU_REQ,
      persistedCandles: [],
      interval: "15m",
      engineSymbol: "XAUUSD",
      mapping: verifiedMapping,
      isDemoAccount: true
    });
    const result = assembleMt5HistoricalWarmup({
      plan,
      requirement: XAU_REQ,
      persistedCandles: [],
      fetchedBars: Array.from({ length: 50 }, (_, i) => mt5Bar(i)),
      engineSymbol: "XAUUSD",
      interval: "15m"
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toBe(MT5_WARMUP_INSUFFICIENT_HISTORY);
    expect(isMt5MarketDataReady(result.candles, XAU_REQ).ready).toBe(false);
  });
});

describe("session gaps + continuity", () => {
  it("weekend/session gap accepted as SESSION_OR_WEEKEND_GAP", () => {
    const fri = Date.UTC(2026, 0, 9, 20, 0, 0); // Friday
    const mon = Date.UTC(2026, 0, 12, 1, 0, 0); // Monday
    expect(
      classifyMt5OpenTimeGap({
        previousOpenTime: fri,
        nextOpenTime: mon,
        interval: "15m"
      })
    ).toBe("SESSION_OR_WEEKEND_GAP");
  });

  it("session gap with continuous prices restores; corrupt close jump rejected", () => {
    const fri = hist(0, undefined, Date.UTC(2026, 0, 9, 20, 0, 0));
    const monClose = 2000.5;
    const mon = hist(0, {
      close: monClose,
      open: monClose - 0.05,
      high: monClose + 0.1,
      low: monClose - 0.1
    }, Date.UTC(2026, 0, 12, 1, 0, 0));
    const ok = filterRestorableMt5Candles([fri, mon]);
    expect(ok.rejected).toBe(false);

    const bad = filterRestorableMt5Candles([
      fri,
      {
        ...mon,
        close: 5000,
        open: 4999,
        high: 5001,
        low: 4998
      }
    ]);
    expect(bad.rejected).toBe(true);
  });
});

describe("H4 after historical M15 bootstrap", () => {
  it("H4 aggregation uses only completed M15; forming H4 excluded; boundary works", () => {
    const bars = Array.from({ length: 32 }, (_, i) => hist(i, undefined, Date.UTC(2026, 0, 5, 16, 0, 0)));
    const atBoundary = completedSessionAwareHtfBarsAsOf(bars, 15, "4h", { minFillRatio: 0.25 });
    expect(atBoundary.length).toBeGreaterThanOrEqual(1);
    expect(atBoundary.every((b) => b.closeTime <= bars[15]!.closeTime)).toBe(true);
    const midNext = completedSessionAwareHtfBarsAsOf(bars, 18, "4h", { minFillRatio: 0.25 });
    expect(midNext.length).toBe(atBoundary.length);
    expect(midNext.at(-1)!.closeTime).toBe(atBoundary.at(-1)!.closeTime);
  });

  it("XAU strategy can evaluate immediately after historical bootstrap (no INSUFFICIENT_HISTORY)", () => {
    const strategy = new XauTrendPullbackStrategy();
    const bars = Array.from({ length: 120 }, (_, i) => hist(i, undefined, Date.UTC(2026, 0, 1, 8, 0, 0)));
    expect(isMt5MarketDataReady(bars, XAU_REQ).ready).toBe(true);
    const features = extractFeatures(bars);
    const decision = strategy.evaluate({
      candles: bars,
      features,
      regime: {
        regime: "STRONG_UPTREND",
        confidence: 0.7,
        scores: { trend: 80, momentum: 60, volatility: 40, range: 50, breakout: 40 },
        reasons: [],
        timestamp: bars[bars.length - 1]!.closeTime,
        classifierVersion: "test"
      },
      parameters: { ...XAU_TREND_PULLBACK_DEFAULTS } as Record<string, number | boolean | string>,
      candlesSinceLastSignal: Number.POSITIVE_INFINITY
    });
    const codes = (decision.metadata?.entryQualityReasonCodes as string[] | undefined) ?? [];
    expect(codes).not.toContain("INSUFFICIENT_HISTORY");
    expect(codes).not.toContain("UNSUPPORTED_EXECUTION_INTERVAL");
  });

  it("mt5BarToHistoryCandle tags MT5_HISTORY not MT5_LIVE_TICKS", () => {
    const c = mt5BarToHistoryCandle({
      bar: mt5Bar(0),
      engineSymbol: "XAUUSD",
      interval: "15m"
    });
    expect(c.source).toBe("MT5_HISTORY");
  });
});
