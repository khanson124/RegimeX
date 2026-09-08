import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  assertHoldoutUntouched,
  assignQuintileBucket,
  computeQuintileEdges,
  splitWeeksForDiscovery
} from "./xauFeatureDiscoveryBins.js";
import { attachForwardOutcomes, buildFeatureRows } from "./xauFeatureDiscoveryFeatures.js";
import {
  bootstrapMeanCi,
  createSeededRng,
  assessPracticalEdge,
  PREDEFINED_INTERACTIONS
} from "./xauFeatureDiscoveryAnalysis.js";
import type { EdgeCandidate } from "./xauFeatureDiscoveryTypes.js";
import { runFeatureDiscovery } from "./xauFeatureDiscovery.js";
import { inventoryXauUsdWeeklySegments } from "./xauUsdWeeklyRobustness.js";
import { CFD_CAPABLE_STRATEGY_IDS } from "../strategies/cfdCapability.js";
import { STRATEGY_KINDS } from "@regimex/shared";

function m1(i: number, px: number, base = Date.UTC(2026, 5, 8, 0, 0, 0)): Candle {
  const openTime = base + i * 60_000;
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime,
    closeTime: openTime + 60_000,
    open: px,
    high: px + 0.3,
    low: px - 0.3,
    close: px + 0.05,
    tickCount: 2,
    isComplete: true,
    source: "HISTORY_API"
  };
}

function weekCandles(start: number, n: number, drift = 0.02): Candle[] {
  const out: Candle[] = [];
  let px = 2000;
  for (let i = 0; i < n; i++) {
    px += drift + Math.sin(i / 20) * 0.05;
    out.push(m1(i, px, start));
  }
  return out;
}

describe("xau feature discovery — practical significance", () => {
  it("rejects calendar-only and sub-cost holdout effects for strategy recommendation", () => {
    const weakHour: EdgeCandidate = {
      rank: 1,
      description: "hourUtc in bucket H5 (LONG) on 5m @ +120m",
      direction: "long",
      timeframe: "5m",
      horizon: "+120m",
      sampleSize: 400,
      discoveryEffect: 0.001,
      validationEffect: 0.0004,
      holdoutEffect: 0.00006,
      positiveWeekPct: 1,
      costAdjustedEffect: 0.0009,
      warnings: [],
      source: "univariate"
    };
    const a = assessPracticalEdge(weakHour, { spreadBps: 0.61, assumedSlipBps: 0.25 });
    expect(a.practical).toBe(false);
    expect(a.strategyWorthy).toBe(false);

    const okish: EdgeCandidate = {
      ...weakHour,
      description: "emaFastSlope in bucket Q5 (LONG) on 5m @ +120m",
      holdoutEffect: 0.0008,
      costAdjustedEffect: 0.0004,
      positiveWeekPct: 0.7
    };
    const b = assessPracticalEdge(okish, { spreadBps: 0.61, assumedSlipBps: 0.25 });
    // Clears soft practical bar but not strategy-design floor (15 bps hold / 8 bps net).
    expect(b.practical).toBe(true);
    expect(b.strategyWorthy).toBe(false);

    const strong: EdgeCandidate = {
      ...okish,
      holdoutEffect: 0.002,
      costAdjustedEffect: 0.0012
    };
    const c = assessPracticalEdge(strong, { spreadBps: 0.61, assumedSlipBps: 0.25 });
    expect(c.strategyWorthy).toBe(true);
  });
});

describe("xau feature discovery — bins & splits", () => {
  it("uses deterministic quintile edges and buckets", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i);
    const e1 = computeQuintileEdges(vals);
    const e2 = computeQuintileEdges(vals);
    expect(e1).toEqual(e2);
    expect(assignQuintileBucket(0, e1)).toBe("Q1");
    expect(assignQuintileBucket(99, e1)).toBe("Q5");
  });

  it("splits weeks chronologically without holdout leakage", () => {
    const weeks = [];
    for (let w = 0; w < 10; w++) {
      const start = Date.UTC(2026, 5, 1 + w * 7, 0, 0, 0);
      const candles = weekCandles(start, 600);
      const inv = inventoryXauUsdWeeklySegments(candles, { minBars1m: 500 });
      weeks.push(...inv.filter((x) => x.usable));
    }
    // merge into synthetic list with unique ids
    const usable = weeks.map((w, i) => ({
      ...w,
      segmentId: `W${i}`,
      startOpenTime: w.startOpenTime + i * 1e9
    }));
    usable.sort((a, b) => a.startOpenTime - b.startOpenTime);
    const split = splitWeeksForDiscovery(usable);
    expect(split.discovery.length).toBeGreaterThan(0);
    expect(split.holdout.length).toBeGreaterThan(0);
    expect(split.discovery.at(-1)!.startOpenTime).toBeLessThan(
      split.holdout[0]!.startOpenTime
    );
    assertHoldoutUntouched(
      split.discovery.map((w) => w.segmentId),
      new Set(split.holdout.map((w) => w.segmentId))
    );
    expect(() =>
      assertHoldoutUntouched([split.holdout[0]!.segmentId], new Set(split.holdout.map((w) => w.segmentId)))
    ).toThrow(/Holdout leakage/);
  });

  it("limits predefined interactions (no brute force)", () => {
    expect(PREDEFINED_INTERACTIONS.length).toBeLessThanOrEqual(12);
  });
});

describe("xau feature discovery — features & outcomes", () => {
  it("computes features without lookahead and forward outcomes with horizon alignment", () => {
    const start = Date.UTC(2026, 5, 8, 0, 0, 0);
    const candles = weekCandles(start, 800, 0.03);
    const rows = buildFeatureRows({
      candles1m: candles,
      timeframe: "5m",
      weekId: "WTEST",
      split: "DISCOVERY",
      stride: 1,
      minHistory: 80
    });
    expect(rows.length).toBeGreaterThan(10);
    // Feature timestamp uses completed bar only
    for (const r of rows) {
      expect(r.closeTime).toBeGreaterThan(r.openTime);
    }

    const withOut = attachForwardOutcomes(rows, candles, "5m", 0.61, 0.25);
    const sample = withOut.find((r) => r.outcomes["+15m"]?.forwardReturn != null);
    expect(sample).toBeTruthy();
    // Cost-adjusted long return should be <= gross when spread/slip > 0
    const o = sample!.outcomes["+15m"]!;
    expect(o.netLongReturn!).toBeLessThanOrEqual(o.forwardReturn! + 1e-12);
  });

  it("bootstrap CI is deterministic with seed", () => {
    const vals = Array.from({ length: 50 }, (_, i) => Math.sin(i));
    const a = bootstrapMeanCi(vals, 123, 100);
    const b = bootstrapMeanCi(vals, 123, 100);
    expect(a).toEqual(b);
    const rng1 = createSeededRng(1);
    const rng2 = createSeededRng(1);
    expect([rng1(), rng1()]).toEqual([rng2(), rng2()]);
  });
});

describe("xau feature discovery — no strategy registration", () => {
  it("does not add strategy kinds or CFD ids for feature discovery", () => {
    expect(STRATEGY_KINDS).not.toContain("xau-feature-discovery" as never);
    expect(CFD_CAPABLE_STRATEGY_IDS as readonly string[]).not.toContain(
      "xau-feature-discovery-v1"
    );
  });

  it("runs end-to-end discovery on synthetic multi-week data", () => {
    const usable = [];
    for (let w = 0; w < 8; w++) {
      const start = Date.UTC(2026, 5, 1 + w * 7, 0, 0, 0);
      const candles = weekCandles(start, 700, w % 2 === 0 ? 0.04 : -0.03);
      const inv = inventoryXauUsdWeeklySegments(candles, { minBars1m: 500 });
      for (const seg of inv.filter((s) => s.usable)) {
        usable.push({ ...seg, segmentId: `SYN_W${w}_${seg.segmentId}` });
      }
    }
    expect(usable.length).toBeGreaterThanOrEqual(3);
    const report = runFeatureDiscovery({
      usableWeeks: usable,
      spreadBps: 0.61,
      spreadStatus: "PRELIMINARY",
      timeframes: ["5m"],
      seed: 11
    });
    expect(report.safety.noStrategyCreated).toBe(true);
    expect(report.featureInventory.length).toBeGreaterThan(10);
    expect(report.splits.holdoutWeeks.length).toBeGreaterThan(0);
    expect(report.multipleTesting.univariateTests).toBeGreaterThanOrEqual(0);
  });
});
