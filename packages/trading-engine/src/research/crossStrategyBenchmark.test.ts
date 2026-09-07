import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  classifyCostEdgeCase,
  classifyStrategyFamily,
  computeWalkForwardStability,
  costDragExpectancyR,
  researchVerdict,
  sampleSizeFlag,
  summarizeTrades
} from "./benchmarkMetrics.js";
import { inspectCandleDataQuality } from "./dataQuality.js";
import { aggregateCompletedCandles } from "./candleResample.js";
import {
  DEFAULT_CROSS_STRATEGY_BENCHMARK_CONFIG,
  listBenchmarkStrategies,
  runCrossStrategyBenchmark
} from "./crossStrategyBenchmark.js";
import { CFD_CAPABLE_STRATEGY_IDS } from "../strategies/cfdCapability.js";
import { EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { splitHoldout } from "./holdoutSplit.js";

function candle(i: number, overrides: Partial<Candle> = {}): Candle {
  const t = Date.UTC(2026, 0, 1) + i * 60_000;
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: t,
    closeTime: t + 60_000,
    open: 100 + i * 0.01,
    high: 100.5 + i * 0.01,
    low: 99.5 + i * 0.01,
    close: 100.1 + i * 0.01,
    tickCount: 10,
    isComplete: true,
    source: "SEED",
    ...overrides
  };
}

describe("benchmarkMetrics", () => {
  it("computes costDrag as zeroCost - realistic", () => {
    expect(costDragExpectancyR(0.4, -0.2)).toBe(0.6);
  });

  it("classifies cost edge cases", () => {
    expect(
      classifyCostEdgeCase({
        holdoutTradesRealistic: 5,
        holdoutTradesZero: 5,
        zeroCostHoldoutExpR: 1,
        realisticHoldoutExpR: 1
      })
    ).toBe("TOO_SPARSE_INCONCLUSIVE");
    expect(
      classifyCostEdgeCase({
        holdoutTradesRealistic: 30,
        holdoutTradesZero: 30,
        zeroCostHoldoutExpR: 0.2,
        realisticHoldoutExpR: -0.1
      })
    ).toBe("RAW_EDGE_KILLED_BY_COSTS");
    expect(
      classifyCostEdgeCase({
        holdoutTradesRealistic: 30,
        holdoutTradesZero: 30,
        zeroCostHoldoutExpR: -0.1,
        realisticHoldoutExpR: -0.3
      })
    ).toBe("NO_EDGE_EVEN_BEFORE_COSTS");
    expect(
      classifyCostEdgeCase({
        holdoutTradesRealistic: 30,
        holdoutTradesZero: 30,
        zeroCostHoldoutExpR: 0.2,
        realisticHoldoutExpR: 0.1
      })
    ).toBe("PROMISING");
  });

  it("flags sample sizes", () => {
    expect(sampleSizeFlag(10)).toBe("VERY_LOW_SAMPLE");
    expect(sampleSizeFlag(30)).toBe("LOW_SAMPLE");
    expect(sampleSizeFlag(50)).toBe("INFORMATIVE");
  });

  it("walk-forward stability detects single-window domination", () => {
    const st = computeWalkForwardStability([
      { expectancyR: 4, profitFactor: 5, trades: 20, netR: 80 },
      { expectancyR: -1, profitFactor: 0.5, trades: 20, netR: -10 },
      { expectancyR: -1, profitFactor: 0.5, trades: 20, netR: -10 }
    ]);
    expect(st.percentPositiveExpectancy).toBeCloseTo(1 / 3, 4);
    expect(st.singleWindowDominated).toBe(true);
  });

  it("researchVerdict is explicit", () => {
    expect(
      researchVerdict({
        costCase: "TOO_SPARSE_INCONCLUSIVE",
        wf: computeWalkForwardStability([]),
        holdoutTrades: 5
      })
    ).toBe("TOO_SPARSE");
    expect(
      researchVerdict({
        costCase: "RAW_EDGE_KILLED_BY_COSTS",
        wf: computeWalkForwardStability([
          { expectancyR: 0.2, profitFactor: 1.2, trades: 10, netR: 2 }
        ]),
        holdoutTrades: 40
      })
    ).toBe("RAW_EDGE_BUT_COST_SENSITIVE");
  });

  it("summarizeTrades is deterministic", () => {
    const trades = [
      {
        action: "BUY",
        outcome: "WIN",
        netR: 2,
        netPnl: 10,
        regime: "STRONG_UPTREND"
      },
      {
        action: "SELL",
        outcome: "LOSS",
        netR: -1,
        netPnl: -5,
        regime: "STRONG_DOWNTREND"
      }
    ] as never;
    expect(summarizeTrades(trades)).toEqual(summarizeTrades(trades));
  });
});

describe("dataQuality + resample", () => {
  it("detects duplicate and non-monotonic timestamps", () => {
    const candles = [candle(0), candle(1), candle(1), candle(0, { openTime: candle(0).openTime - 1 })];
    // fix third as duplicate of second, fourth as non-monotonic relative to third
    const bad = [
      candle(0),
      candle(1),
      { ...candle(2), openTime: candle(1).openTime },
      { ...candle(3), openTime: candle(1).openTime - 60_000 }
    ];
    const r = inspectCandleDataQuality(bad, { expectedIntervalMs: 60_000 });
    expect(r.duplicateCount).toBeGreaterThan(0);
    expect(r.nonMonotonicCount).toBeGreaterThan(0);
  });

  it("aggregates 1m → 5m without lookahead (complete buckets only)", () => {
    const m1 = Array.from({ length: 12 }, (_, i) => candle(i));
    const m5 = aggregateCompletedCandles(m1, "5m");
    expect(m5.length).toBeGreaterThanOrEqual(2);
    expect(m5.every((c) => c.interval === "5m")).toBe(true);
    expect(m5.every((c) => c.isComplete)).toBe(true);
    for (const c of m5) {
      expect(c.closeTime).toBeGreaterThan(c.openTime);
    }
  });
});

describe("crossStrategyBenchmark catalogue", () => {
  it("lists all CFD-capable IDs in deterministic order", () => {
    const specs = listBenchmarkStrategies();
    expect(specs.map((s) => s.strategyId)).toEqual(
      [...CFD_CAPABLE_STRATEGY_IDS].sort((a, b) => a.localeCompare(b))
    );
    expect(specs.map((s) => s.strategyId)).toEqual(
      [...specs.map((s) => s.strategyId)].sort((a, b) => a.localeCompare(b))
    );
  });

  it("does not mutate strategy default parameter objects", () => {
    const before = JSON.stringify(EMA_PULLBACK_DEFAULTS);
    listBenchmarkStrategies(["ema-pullback-v1"]);
    expect(JSON.stringify(EMA_PULLBACK_DEFAULTS)).toBe(before);
  });

  it("classifies families", () => {
    expect(classifyStrategyFamily("ema-pullback-v1")).toBe("trend_pullback");
    expect(classifyStrategyFamily("bollinger-reversion-v1")).toBe("mean_reversion");
    expect(classifyStrategyFamily("squeeze-breakout-v1")).toBe("breakout_momentum");
  });

  it("uses identical holdout split for all strategies and never tunes on holdout", async () => {
    const candles = Array.from({ length: 2600 }, (_, i) => {
      const base = 1000 + Math.sin(i / 17) * 5 + i * 0.002;
      return candle(i, {
        open: base,
        high: base + 1,
        low: base - 1,
        close: base + 0.2,
        symbol: "R_10",
        interval: "1m"
      });
    });
    const split = splitHoldout(candles, 0.3);
    const report = await runCrossStrategyBenchmark(candles, {
      ...DEFAULT_CROSS_STRATEGY_BENCHMARK_CONFIG,
      strategyIds: ["ema-pullback-v1", "bollinger-reversion-v1"],
      walkForward: { trainWindow: 800, testWindow: 200, stepSize: 200, windowMode: "rolling" },
      maxHoldBars: 20
    });
    expect(report.holdoutUsedForParameterSelection).toBe(false);
    expect(report.developmentCount).toBe(split.development.length);
    expect(report.holdoutCount).toBe(split.holdout.length);
    expect(report.strategies).toHaveLength(2);
    expect(report.notes.deployed).toBe(false);
    expect(report.notes.emaPullbackRemainsSuspended).toBe(true);
    // cost-aware vs zero-cost both present
    for (const s of report.strategies) {
      expect(s.realistic.spreadBps).toBe(8);
      expect(s.zeroCost.spreadBps).toBe(0);
      expect(typeof s.costDrag.holdoutExpectancyR).toBe("number");
    }
  }, 120_000);
});
