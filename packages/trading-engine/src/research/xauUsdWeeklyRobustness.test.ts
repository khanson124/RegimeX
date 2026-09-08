import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  aggregateWeeklyResults,
  assertSegmentBoundaryIntegrity,
  buildXauUsdCostProfiles,
  classifySqueezeRobustness,
  compareOverlappingCandleCloses,
  inventoryXauUsdWeeklySegments,
  leaveOneWeekOut,
  utcWeekStartMs,
  weekDominanceShare,
  type WeeklyStrategyResult
} from "./xauUsdWeeklyRobustness.js";
import { sampleSizeFlag } from "./benchmarkMetrics.js";

function bar(t: number, close = 4400): Candle {
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime: t,
    closeTime: t + 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    tickCount: 1,
    isComplete: true,
    source: "HISTORY_API"
  };
}

function fillRange(start: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => bar(start + i * 60_000, 4400 + i * 0.01));
}

describe("XAUUSD weekly segment inventory", () => {
  it("splits on weekend gaps and groups by UTC week", () => {
    // Mon Jun 8 2026 00:00 UTC
    const week1 = Date.UTC(2026, 5, 8, 0, 0, 0);
    const week2 = Date.UTC(2026, 5, 15, 0, 0, 0);
    const candles = [
      ...fillRange(week1, 600),
      // weekend gap ~55h then next week
      ...fillRange(week2, 600)
    ];
    const inv = inventoryXauUsdWeeklySegments(candles, { minBars1m: 500 });
    expect(inv.length).toBeGreaterThanOrEqual(2);
    expect(inv.every((w) => w.bars1m >= 500)).toBe(true);
    expect(inv.filter((w) => w.usable).length).toBeGreaterThanOrEqual(2);
    assertSegmentBoundaryIntegrity(inv);
    expect(utcWeekStartMs(week1 + 3 * 3600_000)).toBe(week1);
    for (const w of inv.filter((w) => w.usable)) {
      expect(w.bars15m).toBeGreaterThanOrEqual(0);
      expect(w.bars5m).toBeGreaterThan(0);
    }
  });

  it("marks short weeks unusable", () => {
    const start = Date.UTC(2026, 5, 8, 0, 0, 0);
    const inv = inventoryXauUsdWeeklySegments(fillRange(start, 100), { minBars1m: 500 });
    expect(inv[0]!.usable).toBe(false);
    expect(inv[0]!.reason).toContain("TOO_SHORT");
  });
});

describe("weekly aggregation / leave-one-out / classification", () => {
  function fakeWeek(
    id: string,
    exp: number,
    trades: number,
    netR: number
  ): WeeklyStrategyResult {
    return {
      segmentId: id,
      weekStartIso: `2026-06-${id.slice(-2)}T00:00:00.000Z`,
      strategyId: "squeeze-breakout-v1",
      costProfileId: "OBSERVED_SPREAD_ONLY",
      metrics: {
        trades,
        wins: Math.max(0, Math.floor(trades * 0.55)),
        losses: Math.max(0, Math.ceil(trades * 0.45)),
        winRate: 0.55,
        profitFactor: 1.2,
        expectancyR: exp,
        averageWinR: 1,
        averageLossR: -1,
        netR,
        netPnl: netR * 10,
        maxDrawdown: null,
        maxDrawdownPercent: null,
        longestLossStreak: null,
        averageBarsHeld: 5,
        averageHoldingMs: null,
        buyTrades: Math.floor(trades / 2),
        sellTrades: Math.ceil(trades / 2),
        buyExpectancyR: exp,
        sellExpectancyR: exp,
        buyWinRate: 0.5,
        sellWinRate: 0.5,
        byRegime: { BREAKOUT_EXPANSION: { trades, winRate: 0.5, expectancyR: exp } },
        sampleSize: sampleSizeFlag(trades)
      }
    };
  }

  it("aggregates weeks and leave-one-out without depending on one week", () => {
    const rows = [
      fakeWeek("W01_08", 0.1, 20, 2),
      fakeWeek("W02_15", 0.05, 22, 1.1),
      fakeWeek("W03_22", 0.08, 18, 1.4),
      fakeWeek("W04_29", -0.02, 15, -0.3)
    ];
    const pooled = aggregateWeeklyResults(rows, "squeeze-breakout-v1", "OBSERVED_SPREAD_ONLY");
    expect(pooled.weeks).toBe(4);
    expect(pooled.positiveWeekCount).toBe(3);
    expect(pooled.totalTrades).toBe(75);
    const loo = leaveOneWeekOut(rows, "squeeze-breakout-v1", "OBSERVED_SPREAD_ONLY");
    expect(loo).toHaveLength(4);
    expect(loo.every((r) => r.remainingWeeks === 3)).toBe(true);
    expect(weekDominanceShare(rows, "squeeze-breakout-v1", "OBSERVED_SPREAD_ONLY")).toBeLessThan(0.6);
  });

  it("detects single-week dominance", () => {
    const rows = [
      fakeWeek("W01_08", 0.5, 40, 20),
      fakeWeek("W02_15", 0.01, 10, 0.1),
      fakeWeek("W03_22", -0.1, 10, -1)
    ];
    expect(weekDominanceShare(rows, "squeeze-breakout-v1", "OBSERVED_SPREAD_ONLY")).toBeGreaterThan(0.6);
  });

  it("classifies PROMISING only when gates pass", () => {
    const ok = classifySqueezeRobustness({
      pooledObserved: {
        weeks: 4,
        positiveWeekCount: 3,
        positiveWeekPct: 0.75,
        medianWeeklyExpectancyR: 0.05,
        bestWeek: null,
        worstWeek: null,
        longestLosingWeekStreak: 1,
        totalTrades: 80,
        winRate: 0.55,
        profitFactor: 1.15,
        expectancyR: 0.04,
        netR: 3.2,
        buyTrades: 40,
        sellTrades: 40,
        buyExpectancyR: 0.04,
        sellExpectancyR: 0.04,
        byRegime: {},
        sampleSize: "INFORMATIVE"
      },
      finalHoldoutTrades: 55,
      finalHoldoutExpectancyR: 0.03,
      leaveOneOutMinExpectancyR: 0.02,
      positiveWeekPct: 0.75,
      parityVerdict: "MATCH_APPROXIMATE",
      survivesAssumedSlip025: true,
      singleWeekDominates: false
    });
    expect(ok.classification).toBe("PROMISING_FOR_FORWARD_DEMO_RESEARCH");

    const blocked = classifySqueezeRobustness({
      pooledObserved: {
        weeks: 4,
        positiveWeekCount: 3,
        positiveWeekPct: 0.75,
        medianWeeklyExpectancyR: 0.05,
        bestWeek: null,
        worstWeek: null,
        longestLosingWeekStreak: 1,
        totalTrades: 80,
        winRate: 0.55,
        profitFactor: 1.15,
        expectancyR: 0.04,
        netR: 3.2,
        buyTrades: 40,
        sellTrades: 40,
        buyExpectancyR: 0.04,
        sellExpectancyR: 0.04,
        byRegime: {},
        sampleSize: "INFORMATIVE"
      },
      finalHoldoutTrades: 55,
      finalHoldoutExpectancyR: 0.03,
      leaveOneOutMinExpectancyR: 0.02,
      positiveWeekPct: 0.75,
      parityVerdict: "MATERIAL_MISMATCH",
      survivesAssumedSlip025: true,
      singleWeekDominates: false
    });
    expect(blocked.classification).toBe("FEED_PARITY_BLOCKED");
  });

  it("labels cost profiles correctly", () => {
    const profiles = buildXauUsdCostProfiles(0.61);
    expect(profiles).toHaveLength(6);
    expect(profiles.find((p) => p.id === "OBSERVED_SPREAD_ONLY")?.label).toBe(
      "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST"
    );
    expect(profiles.filter((p) => p.label === "ASSUMED")).toHaveLength(4);
  });
});

describe("overlap parity comparison", () => {
  it("returns INSUFFICIENT_OVERLAP when few pairs", () => {
    const t0 = Date.UTC(2026, 5, 8);
    const hist = fillRange(t0, 10);
    const live = fillRange(t0, 10).map((c) => ({ ...c, source: "MT5_LIVE_TICKS" as const }));
    expect(compareOverlappingCandleCloses(hist, live).verdict).toBe("INSUFFICIENT_OVERLAP");
  });

  it("MATCH_GOOD when closes nearly identical", () => {
    const t0 = Date.UTC(2026, 5, 8);
    const hist = fillRange(t0, 40);
    const live = hist.map((c) => ({ ...c, close: c.close * 1.00005, source: "MT5_LIVE_TICKS" as const }));
    const r = compareOverlappingCandleCloses(hist, live);
    expect(["MATCH_GOOD", "MATCH_APPROXIMATE"]).toContain(r.verdict);
  });
});
