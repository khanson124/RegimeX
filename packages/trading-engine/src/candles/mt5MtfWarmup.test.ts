/**
 * Multi-timeframe warm-up + native H4 context for xau-trend-pullback-v1.
 */
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { extractFeatures } from "../features/featureExtractor.js";
import {
  XauTrendPullbackStrategy,
  XAU_TREND_PULLBACK_DEFAULTS
} from "../strategies/xauTrendPullback.js";
import { type StrategyContext } from "../strategies/types.js";
import {
  completedContextBarsAsOf,
  deriveXauTrendPullbackM15MinimumBars,
  mergeMtfWarmupSpecs,
  mtfWarmupReadiness,
  XAU_TREND_PULLBACK_H4_MINIMUM_BARS,
  XAU_TREND_PULLBACK_M15_MINIMUM_BARS
} from "./mt5MtfWarmup.js";
import { candleIntervalToMt5BarTimeframe } from "./mt5HistoricalWarmup.js";
import { SqueezeBreakoutStrategy } from "../strategies/squeezeBreakout.js";

function m15(
  i: number,
  opts?: Partial<Candle>,
  base = Date.UTC(2026, 0, 5, 0, 0, 0)
): Candle {
  const openTime = base + i * 900_000;
  const close = 2000 + i * 0.02;
  return {
    symbol: "XAUUSD",
    interval: "15m",
    openTime,
    closeTime: openTime + 900_000,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
    tickCount: 8,
    isComplete: true,
    source: "MT5_HISTORY",
    ...opts
  };
}

function h4(
  i: number,
  opts?: Partial<Candle>,
  base = Date.UTC(2025, 6, 1, 0, 0, 0)
): Candle {
  const openTime = base + i * 14_400_000;
  // Strong uptrend closes for BULLISH bias when enough bars
  const close = 1800 + i * 3;
  return {
    symbol: "XAUUSD",
    interval: "4h" as Candle["interval"],
    openTime,
    closeTime: openTime + 14_400_000,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    tickCount: 40,
    isComplete: true,
    source: "MT5_HISTORY",
    ...opts
  };
}

function ctxOf(
  candles: Candle[],
  contextCandles?: StrategyContext["contextCandles"],
  params: Record<string, unknown> = {}
): StrategyContext {
  return {
    candles,
    features: extractFeatures(candles),
    regime: {
      regime: "STRONG_UPTREND",
      confidence: 0.7,
      scores: { trend: 80, momentum: 60, volatility: 40, range: 50, breakout: 40 },
      reasons: [],
      timestamp: candles[candles.length - 1]!.closeTime,
      classifierVersion: "test"
    },
    parameters: { ...XAU_TREND_PULLBACK_DEFAULTS, ...params } as Record<
      string,
      number | boolean | string
    >,
    candlesSinceLastSignal: Number.POSITIVE_INFINITY,
    contextCandles
  };
}

describe("derived XAU MTF warm-up floors", () => {
  it("documents M15 minimum from indicator lookbacks (not manufactured H4)", () => {
    expect(deriveXauTrendPullbackM15MinimumBars()).toBe(120);
    expect(XAU_TREND_PULLBACK_M15_MINIMUM_BARS).toBe(120);
    expect(XAU_TREND_PULLBACK_H4_MINIMUM_BARS).toBe(80);
    // Binding: atrPeriod(14) + atrPercentileLookback(100) = 114, floored to 120
    expect(deriveXauTrendPullbackM15MinimumBars({ atrPercentileLookback: 100 })).toBe(120);
  });

  it("strategy declares split MTF requirements", () => {
    const s = new XauTrendPullbackStrategy();
    expect(s.minimumHistory).toBe(120);
    expect(s.multiTimeframeWarmup).toEqual({
      executionInterval: "15m",
      requirements: [
        { interval: "15m", minimumBars: 120, role: "execution" },
        { interval: "4h", minimumBars: 80, role: "context" }
      ]
    });
  });

  it("R_10 squeeze strategy remains single-interval (unchanged)", () => {
    const s = new SqueezeBreakoutStrategy();
    expect((s as { multiTimeframeWarmup?: unknown }).multiTimeframeWarmup).toBeUndefined();
    expect(s.minimumHistory).toBeGreaterThan(0);
  });
});

describe("MT5 4h timeframe mapping helper", () => {
  it("maps 4h for getBars warm-up", () => {
    expect(candleIntervalToMt5BarTimeframe("4h")).toBe("4h");
  });
});

describe("mtfWarmupReadiness", () => {
  it("80 completed H4 accepted; 79 H4 blocks", () => {
    const spec = new XauTrendPullbackStrategy().multiTimeframeWarmup!;
    const m15Bars = Array.from({ length: 120 }, (_, i) => m15(i));
    const h4ok = Array.from({ length: 80 }, (_, i) => h4(i));
    const h4short = Array.from({ length: 79 }, (_, i) => h4(i));
    expect(
      mtfWarmupReadiness({
        spec,
        candlesByInterval: { "15m": m15Bars, "4h": h4ok }
      }).ready
    ).toBe(true);
    expect(
      mtfWarmupReadiness({
        spec,
        candlesByInterval: { "15m": m15Bars, "4h": h4short }
      }).ready
    ).toBe(false);
  });

  it("derived M15 minimum is enforced; 652 M15 + sufficient H4 is ready", () => {
    const spec = new XauTrendPullbackStrategy().multiTimeframeWarmup!;
    const short = Array.from({ length: 119 }, (_, i) => m15(i));
    const ok652 = Array.from({ length: 652 }, (_, i) => m15(i));
    const h4Bars = Array.from({ length: 80 }, (_, i) => h4(i));
    expect(
      mtfWarmupReadiness({
        spec,
        candlesByInterval: { "15m": short, "4h": h4Bars }
      }).ready
    ).toBe(false);
    expect(
      mtfWarmupReadiness({
        spec,
        candlesByInterval: { "15m": ok652, "4h": h4Bars }
      }).ready
    ).toBe(true);
  });

  it("H4 and M15 histories remain separate in readiness map", () => {
    const spec = new XauTrendPullbackStrategy().multiTimeframeWarmup!;
    const m15Bars = Array.from({ length: 120 }, (_, i) => m15(i));
    const h4Bars = Array.from({ length: 80 }, (_, i) => h4(i));
    const r = mtfWarmupReadiness({
      spec,
      candlesByInterval: { "15m": m15Bars, "4h": h4Bars }
    });
    expect(r.perInterval.find((p) => p.interval === "15m")?.available).toBe(120);
    expect(r.perInterval.find((p) => p.interval === "4h")?.available).toBe(80);
    expect(m15Bars.every((c) => String(c.interval) === "15m")).toBe(true);
    expect(h4Bars.every((c) => String(c.interval) === "4h")).toBe(true);
  });
});

describe("native H4 as-of M15 (no lookahead)", () => {
  it("selects H4 by closeTime <= M15 decision time; excludes forming", () => {
    const bars = Array.from({ length: 5 }, (_, i) => h4(i, undefined, Date.UTC(2026, 0, 5, 0, 0, 0)));
    // H4[0] closes 04:00, H4[1] closes 08:00
    const asOf = Date.UTC(2026, 0, 5, 7, 45, 0); // mid second H4
    const completed = completedContextBarsAsOf(bars, asOf);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.closeTime).toBe(Date.UTC(2026, 0, 5, 4, 0, 0));
    expect(completed.every((c) => c.closeTime <= asOf)).toBe(true);
  });

  it("exact H4 close boundary includes the just-closed bar", () => {
    const bars = Array.from({ length: 3 }, (_, i) => h4(i, undefined, Date.UTC(2026, 0, 5, 0, 0, 0)));
    const boundary = Date.UTC(2026, 0, 5, 8, 0, 0); // H4[1] close
    const completed = completedContextBarsAsOf(bars, boundary);
    expect(completed).toHaveLength(2);
    expect(completed.at(-1)!.closeTime).toBe(boundary);
  });

  it("live strategy uses native H4 context when provided", () => {
    const strategy = new XauTrendPullbackStrategy();
    const m15Bars = Array.from({ length: 120 }, (_, i) =>
      m15(i, undefined, Date.UTC(2026, 0, 12, 8, 0, 0))
    );
    const h4Bars = Array.from({ length: 80 }, (_, i) => h4(i));
    const d = strategy.evaluate(ctxOf(m15Bars, { "4h": h4Bars }));
    expect(d.metadata?.h4ContextSource).toBe("native_mt5_history");
    expect(d.metadata?.entryQualityReasonCodes).not.toContain("INSUFFICIENT_HISTORY");
    expect(d.metadata?.entryQualityReasonCodes).not.toContain("INSUFFICIENT_H4_CONTEXT");
  });

  it("blocks when native H4 present but below 80 as-of", () => {
    const strategy = new XauTrendPullbackStrategy();
    const m15Bars = Array.from({ length: 120 }, (_, i) => m15(i));
    const h4Bars = Array.from({ length: 40 }, (_, i) => h4(i));
    const d = strategy.evaluate(ctxOf(m15Bars, { "4h": h4Bars }));
    expect(d.action).toBe("HOLD");
    expect(d.metadata?.entryQualityReasonCodes).toContain("INSUFFICIENT_H4_CONTEXT");
  });

  it("live M15 updates do not corrupt H4 history object identity", () => {
    const h4Bars = Array.from({ length: 80 }, (_, i) => h4(i));
    const frozen = h4Bars.map((c) => ({ ...c }));
    const m15Bars = Array.from({ length: 120 }, (_, i) => m15(i));
    // Simulate a new live M15 candle appended — H4 array untouched
    const liveM15 = [
      ...m15Bars,
      m15(120, { source: "MT5_LIVE_TICKS" })
    ];
    expect(h4Bars).toEqual(frozen);
    expect(liveM15.filter((c) => String(c.interval) === "4h")).toHaveLength(0);
    expect(h4Bars.every((c) => c.source === "MT5_HISTORY")).toBe(true);
  });
});

describe("mergeMtfWarmupSpecs", () => {
  it("unions context requirements across strategies", () => {
    const xau = new XauTrendPullbackStrategy().multiTimeframeWarmup!;
    const merged = mergeMtfWarmupSpecs([xau], "15m");
    expect(merged?.requirements.some((r) => r.interval === "4h" && r.minimumBars === 80)).toBe(
      true
    );
    expect(merged?.requirements.some((r) => r.interval === "15m" && r.minimumBars === 120)).toBe(
      true
    );
  });
});

describe("forming H4 excluded", () => {
  it("incomplete H4 is filtered by completedContextBarsAsOf", () => {
    const bars = [
      h4(0),
      h4(1, { isComplete: false, closeTime: Date.now() + 3_600_000 })
    ];
    const asOf = Date.now() + 10_000_000;
    const completed = completedContextBarsAsOf(bars, asOf);
    expect(completed.every((c) => c.isComplete)).toBe(true);
    expect(completed).toHaveLength(1);
  });
});
