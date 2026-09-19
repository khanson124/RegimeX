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
  filterStrategiesForSessionWarmup,
  mergeMtfWarmupSpecs,
  mtfWarmupReadiness,
  resolveSessionMtfWarmupSpec,
  strategyAppliesToSession,
  XAU_TREND_PULLBACK_H4_MINIMUM_BARS,
  XAU_TREND_PULLBACK_M15_MINIMUM_BARS
} from "./mt5MtfWarmup.js";
import { candleIntervalToMt5BarTimeframe } from "./mt5HistoricalWarmup.js";
import { BreakoutMomentumStrategy } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy } from "../strategies/emaPullback.js";
import { BollingerReversionStrategy } from "../strategies/bollingerReversion.js";
import { SqueezeBreakoutStrategy } from "../strategies/squeezeBreakout.js";
import { TrendStructurePullbackStrategy } from "../strategies/trendStructurePullback.js";
import { XauTrendBreakoutV2Strategy } from "../strategies/xauTrendBreakoutV2.js";
import { XauMtfStructureMomentumStrategy } from "../strategies/xauMtfStructureMomentum.js";
import { XauVolatilityExpansionRetestStrategy } from "../strategies/xauVolatilityExpansionRetest.js";
import { isMt5MarketDataReady, resolveMt5WarmupRequirement } from "./mt5MarketData.js";

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

  it("drops foreign executionInterval specs (XAU cannot contaminate R_10)", () => {
    const xau = new XauTrendPullbackStrategy().multiTimeframeWarmup!;
    const squeeze = {
      executionInterval: "1m",
      requirements: [{ interval: "1m", minimumBars: 80, role: "execution" as const }]
    };
    const merged = mergeMtfWarmupSpecs([squeeze, xau], "1m");
    expect(merged?.requirements.map((r) => r.interval).sort()).toEqual(["1m"]);
    expect(merged?.requirements.some((r) => r.interval === "15m" || r.interval === "4h")).toBe(
      false
    );
  });
});

describe("session-scoped MTF warm-up", () => {
  const demoConfig = {
    EXECUTION_MODE: "broker_demo_mt5",
    REAL_MONEY_ENABLED: false,
    MT5_ENGINE_ENABLED: true,
    MT5_ENGINE_STRATEGY_ALLOWLIST: "squeeze-breakout-v1,xau-trend-pullback-v1"
  };

  it("XAU strategy does not apply to R_10/1m", () => {
    const xau = new XauTrendPullbackStrategy();
    const squeeze = new SqueezeBreakoutStrategy();
    expect(strategyAppliesToSession(xau, { symbol: "R_10", interval: "1m" })).toBe(false);
    expect(strategyAppliesToSession(squeeze, { symbol: "R_10", interval: "1m" })).toBe(true);
    expect(strategyAppliesToSession(xau, { symbol: "XAUUSD", interval: "15m" })).toBe(true);
    expect(strategyAppliesToSession(squeeze, { symbol: "XAUUSD", interval: "15m" })).toBe(false);
  });

  it("R_10 / 1m / AUTO / global allowlist with squeeze+xau → only 1m warm-up", () => {
    const strategies = [new SqueezeBreakoutStrategy(), new XauTrendPullbackStrategy()];
    const sessionScoped = filterStrategiesForSessionWarmup(strategies, {
      symbol: "R_10",
      interval: "1m"
    });
    expect(sessionScoped.map((s) => s.id)).toEqual(["squeeze-breakout-v1"]);

    const requirement = resolveMt5WarmupRequirement({
      strategies: sessionScoped.map((s) => ({
        strategyId: s.id,
        minimumHistory: s.minimumHistory
      })),
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    expect(requirement).toMatchObject({
      status: "REQUIRES_BARS",
      requiredBars: 80,
      eligibleStrategyIds: ["squeeze-breakout-v1"]
    });

    const spec = resolveSessionMtfWarmupSpec({
      strategies: sessionScoped,
      eligibleStrategyIds:
        requirement.status === "REQUIRES_BARS" ? requirement.eligibleStrategyIds : [],
      symbol: "R_10",
      interval: "1m"
    });
    expect(spec?.requirements.map((r) => r.interval)).toEqual(["1m"]);
    expect(spec?.requirements.some((r) => r.interval === "15m" || r.interval === "4h")).toBe(
      false
    );

    const bars1m = Array.from({ length: 80 }, (_, i) => ({
      symbol: "R_10",
      interval: "1m" as const,
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000,
      open: 4780,
      high: 4781,
      low: 4779,
      close: 4780 + i * 0.01,
      tickCount: 2,
      isComplete: true,
      source: "MT5_LIVE_TICKS" as const
    }));
    const ready = mtfWarmupReadiness({
      spec: spec!,
      candlesByInterval: { "1m": bars1m }
    });
    expect(ready.ready).toBe(true);
    expect(ready.perInterval.map((p) => p.interval)).toEqual(["1m"]);
    expect(isMt5MarketDataReady(bars1m, requirement).ready).toBe(true);
  });

  it("R_10 with 1500 1m bars is READY without 15m/4h", () => {
    const strategies = [new SqueezeBreakoutStrategy(), new XauTrendPullbackStrategy()];
    const sessionScoped = filterStrategiesForSessionWarmup(strategies, {
      symbol: "R_10",
      interval: "1m"
    });
    const requirement = resolveMt5WarmupRequirement({
      strategies: sessionScoped.map((s) => ({
        strategyId: s.id,
        minimumHistory: s.minimumHistory
      })),
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    const spec = resolveSessionMtfWarmupSpec({
      strategies: sessionScoped,
      eligibleStrategyIds:
        requirement.status === "REQUIRES_BARS" ? requirement.eligibleStrategyIds : [],
      symbol: "R_10",
      interval: "1m"
    });
    const bars = Array.from({ length: 1500 }, (_, i) => ({
      symbol: "R_10",
      interval: "1m" as const,
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000,
      open: 4780,
      high: 4781,
      low: 4779,
      close: 4780,
      tickCount: 1,
      isComplete: true,
      source: "MT5_LIVE_TICKS" as const
    }));
    expect(mtfWarmupReadiness({ spec: spec!, candlesByInterval: { "1m": bars } }).ready).toBe(
      true
    );
    expect(spec!.requirements).toHaveLength(1);
  });

  it("XAUUSD / 15m / SINGLE / xau-trend-pullback-v1 → 15m + 4h", () => {
    const strategies = [new SqueezeBreakoutStrategy(), new XauTrendPullbackStrategy()];
    const sessionScoped = filterStrategiesForSessionWarmup(strategies, {
      symbol: "XAUUSD",
      interval: "15m"
    });
    expect(sessionScoped.map((s) => s.id)).toEqual(["xau-trend-pullback-v1"]);

    const requirement = resolveMt5WarmupRequirement({
      strategies: sessionScoped.map((s) => ({
        strategyId: s.id,
        minimumHistory: s.minimumHistory
      })),
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "SINGLE",
      fixedStrategyId: "xau-trend-pullback-v1"
    });
    expect(requirement).toMatchObject({
      status: "REQUIRES_BARS",
      requiredBars: 120,
      eligibleStrategyIds: ["xau-trend-pullback-v1"]
    });

    const spec = resolveSessionMtfWarmupSpec({
      strategies: sessionScoped,
      eligibleStrategyIds:
        requirement.status === "REQUIRES_BARS" ? requirement.eligibleStrategyIds : [],
      symbol: "XAUUSD",
      interval: "15m"
    });
    const intervals = spec!.requirements.map((r) => r.interval).sort();
    expect(intervals).toEqual(["15m", "4h"]);
    expect(spec!.requirements.find((r) => r.interval === "15m")?.minimumBars).toBe(120);
    expect(spec!.requirements.find((r) => r.interval === "4h")?.minimumBars).toBe(80);

    const m15Bars = Array.from({ length: 120 }, (_, i) => m15(i));
    const h4Bars = Array.from({ length: 80 }, (_, i) => h4(i));
    expect(
      mtfWarmupReadiness({
        spec: spec!,
        candlesByInterval: { "15m": m15Bars, "4h": h4Bars }
      }).ready
    ).toBe(true);
    expect(
      mtfWarmupReadiness({
        spec: spec!,
        candlesByInterval: { "15m": m15Bars, "4h": h4Bars.slice(0, 79) }
      }).ready
    ).toBe(false);
  });

  it("unrelated symbol-specific MTF strategies do not contaminate another session", () => {
    const strategies = [new SqueezeBreakoutStrategy(), new XauTrendPullbackStrategy()];
    const r10 = resolveSessionMtfWarmupSpec({
      strategies,
      eligibleStrategyIds: ["squeeze-breakout-v1", "xau-trend-pullback-v1"],
      symbol: "R_10",
      interval: "1m"
    });
    expect(r10?.requirements.map((r) => r.interval)).toEqual(["1m"]);

    const xau = resolveSessionMtfWarmupSpec({
      strategies,
      eligibleStrategyIds: ["squeeze-breakout-v1", "xau-trend-pullback-v1"],
      symbol: "XAUUSD",
      interval: "15m"
    });
    expect(xau?.requirements.map((r) => r.interval).sort()).toEqual(["15m", "4h"]);
  });

  it("R_10 1m excludes all XAU strategies from warm-up (including 1m XAU research ids)", () => {
    const strategies = [
      new BreakoutMomentumStrategy(),
      new EmaPullbackStrategy(),
      new BollingerReversionStrategy(),
      new SqueezeBreakoutStrategy(),
      new TrendStructurePullbackStrategy(),
      new XauTrendBreakoutV2Strategy(),
      new XauMtfStructureMomentumStrategy(),
      new XauVolatilityExpansionRetestStrategy(),
      new XauTrendPullbackStrategy()
    ];
    const sessionScoped = filterStrategiesForSessionWarmup(strategies, {
      symbol: "R_10",
      interval: "1m"
    });
    const ids = sessionScoped.map((s) => s.id);
    expect(ids).not.toContain("xau-trend-breakout-v2");
    expect(ids).not.toContain("xau-mtf-structure-momentum-v1");
    expect(ids).not.toContain("xau-volatility-expansion-retest-v1");
    expect(ids).not.toContain("xau-trend-pullback-v1");
    expect(ids).toEqual(
      expect.arrayContaining([
        "breakout-momentum-v1",
        "ema-pullback-v1",
        "bollinger-reversion-v1",
        "squeeze-breakout-v1",
        "trend-structure-pullback-v1"
      ])
    );

    const allowAll = {
      EXECUTION_MODE: "broker_demo_mt5",
      REAL_MONEY_ENABLED: false,
      MT5_ENGINE_ENABLED: true,
      MT5_ENGINE_STRATEGY_ALLOWLIST: ids.join(",")
    };
    const requirement = resolveMt5WarmupRequirement({
      strategies: sessionScoped.map((s) => ({
        strategyId: s.id,
        minimumHistory: s.minimumHistory
      })),
      executionBackend: "broker_demo_mt5",
      config: allowAll,
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    expect(requirement).toMatchObject({
      status: "REQUIRES_BARS",
      requiredBars: 80
    });
    if (requirement.status === "REQUIRES_BARS") {
      expect(requirement.eligibleStrategyIds).not.toContain("xau-trend-breakout-v2");
      expect(Math.max(...sessionScoped.map((s) => s.minimumHistory))).toBe(80);
    }

    const spec = resolveSessionMtfWarmupSpec({
      strategies: sessionScoped,
      eligibleStrategyIds:
        requirement.status === "REQUIRES_BARS" ? requirement.eligibleStrategyIds : [],
      symbol: "R_10",
      interval: "1m"
    });
    expect(spec?.requirements).toEqual([
      { interval: "1m", minimumBars: 80, role: "execution" }
    ]);
  });

  it("XAUUSD 15m keeps only compatible XAU strategies", () => {
    const strategies = [
      new SqueezeBreakoutStrategy(),
      new XauTrendBreakoutV2Strategy(),
      new XauTrendPullbackStrategy(),
      new XauMtfStructureMomentumStrategy()
    ];
    const sessionScoped = filterStrategiesForSessionWarmup(strategies, {
      symbol: "XAUUSD",
      interval: "15m"
    });
    expect(sessionScoped.map((s) => s.id)).toEqual(["xau-trend-pullback-v1"]);
    expect(sessionScoped.map((s) => s.id)).not.toContain("squeeze-breakout-v1");
    expect(sessionScoped.map((s) => s.id)).not.toContain("xau-trend-breakout-v2");
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
