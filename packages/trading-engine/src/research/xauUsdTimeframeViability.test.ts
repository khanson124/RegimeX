import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { aggregateContiguousResearchCandles } from "./candleResample.js";
import {
  assertProductionIntervalsUnchanged,
  researchCandleOpenTime,
  researchIntervalMs,
  RESEARCH_CANDLE_INTERVALS
} from "./researchCandleInterval.js";
import {
  candlesForResearchTimeframe,
  classifyTimeframeViability,
  assertNoStrategyParameterMutation
} from "./xauUsdTimeframeViability.js";
import { listBenchmarkStrategies } from "./crossStrategyBenchmark.js";
import { SQUEEZE_BREAKOUT_DEFAULTS } from "../strategies/squeezeBreakout.js";
import { candleIntervalSchema } from "@regimex/shared";

function m1(
  minuteOffset: number,
  opts?: Partial<Candle>,
  base = Date.UTC(2026, 0, 1, 12, 0, 0)
): Candle {
  const openTime = base + minuteOffset * 60_000;
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime,
    closeTime: openTime + 60_000,
    open: 2000 + minuteOffset,
    high: 2001 + minuteOffset,
    low: 1999 + minuteOffset,
    close: 2000.5 + minuteOffset,
    tickCount: 10,
    isComplete: true,
    source: "HISTORY_API",
    ...opts
  };
}

describe("research-only 15m aggregation", () => {
  it("locks production CandleInterval contracts to 1m/5m/15m", () => {
    assertProductionIntervalsUnchanged();
    expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
    expect(RESEARCH_CANDLE_INTERVALS).toContain("15m");
    expect(candleIntervalSchema.parse("15m")).toBe("15m");
    expect(candleIntervalSchema.parse("5m")).toBe("5m");
  });

  it("accepts exactly 15 contiguous 1m bars", () => {
    const bars = Array.from({ length: 15 }, (_, i) => m1(i));
    const r = aggregateContiguousResearchCandles(bars, "15m");
    expect(r.expectedSourceBarsPerBucket).toBe(15);
    expect(r.validCount).toBe(1);
    expect(r.validBars[0]!.open).toBe(bars[0]!.open);
    expect(r.validBars[0]!.close).toBe(bars[14]!.close);
    expect(r.validBars[0]!.high).toBe(Math.max(...bars.map((b) => b.high)));
    expect(String(r.validBars[0]!.interval)).toBe("15m");
  });

  it("rejects incomplete 15m buckets (session boundary / short count)", () => {
    const bars = Array.from({ length: 14 }, (_, i) => m1(i));
    const r = aggregateContiguousResearchCandles(bars, "15m");
    expect(r.validCount).toBe(0);
    expect(r.excluded[0]!.reason).toBe("INCOMPLETE_COUNT");
  });

  it("does not bridge gaps across session closures", () => {
    // 12:00–12:14 then jump past maintenance into next 15m bucket with only partial fill
    const early = Array.from({ length: 15 }, (_, i) => m1(i));
    const afterGap = Array.from({ length: 10 }, (_, i) =>
      m1(i, undefined, Date.UTC(2026, 0, 1, 14, 0, 0))
    );
    const r = aggregateContiguousResearchCandles([...early, ...afterGap], "15m");
    expect(r.validCount).toBe(1);
    expect(r.excluded.some((e) => e.reason === "INCOMPLETE_COUNT")).toBe(true);
  });

  it("rejects missing interior minute (no gap bridging)", () => {
    const bars = [
      ...Array.from({ length: 7 }, (_, i) => m1(i)),
      ...Array.from({ length: 7 }, (_, i) => m1(i + 8)) // skip minute 7
    ];
    const r = aggregateContiguousResearchCandles(bars, "15m");
    expect(r.validCount).toBe(0);
  });

  it("is deterministic and lookahead-safe across buckets", () => {
    const early = Array.from({ length: 15 }, (_, i) => m1(i));
    const late = Array.from({ length: 15 }, (_, i) =>
      m1(i + 15, { high: 9999 })
    );
    const a = aggregateContiguousResearchCandles(early, "15m");
    const b = aggregateContiguousResearchCandles([...early, ...late], "15m");
    expect(a.validBars[0]!.high).toBe(b.validBars[0]!.high);
    expect(b.validBars[0]!.high).toBeLessThan(9999);
    expect(researchCandleOpenTime(early[0]!.openTime, "15m")).toBe(early[0]!.openTime);
    expect(researchIntervalMs("15m")).toBe(900_000);
  });

  it("candlesForResearchTimeframe resets independently per segment input", () => {
    const segA = Array.from({ length: 15 }, (_, i) => m1(i));
    const segB = Array.from({ length: 15 }, (_, i) =>
      m1(i, undefined, Date.UTC(2026, 0, 8, 12, 0, 0))
    );
    const a = candlesForResearchTimeframe(segA, "15m");
    const b = candlesForResearchTimeframe(segB, "15m");
    const both = candlesForResearchTimeframe([...segA, ...segB], "15m");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(both).toHaveLength(2);
    expect(a[0]!.openTime).not.toBe(b[0]!.openTime);
  });
});

describe("timeframe viability classification + no mutation", () => {
  it("does not mutate strategy defaults", () => {
    assertNoStrategyParameterMutation();
    expect(listBenchmarkStrategies(["squeeze-breakout-v1"])[0]!.parameters).toEqual(
      SQUEEZE_BREAKOUT_DEFAULTS
    );
  });

  it("classifies TOO_SPARSE and NO_EDGE", () => {
    const sparse = classifyTimeframeViability({
      pooledObserved: {
        weeks: 2,
        positiveWeekCount: 0,
        positiveWeekPct: 0,
        medianWeeklyExpectancyR: 0,
        bestWeek: null,
        worstWeek: null,
        longestLosingWeekStreak: 0,
        totalTrades: 5,
        winRate: 0,
        profitFactor: null,
        expectancyR: 0.1,
        netR: 0.5,
        buyTrades: 2,
        sellTrades: 3,
        buyExpectancyR: null,
        sellExpectancyR: null,
        byRegime: {},
        sampleSize: "VERY_LOW_SAMPLE"
      },
      zeroExpectancyR: 0.2,
      holdoutTrades: 3,
      holdoutExpectancyR: 0.1,
      holdoutProfitFactor: 1.1,
      positiveWeekPct: 0.5,
      wfPositivePct: 0.5,
      survivesAssumedSlip010: true
    });
    expect(sparse.classification).toBe("TOO_SPARSE");

    const noEdge = classifyTimeframeViability({
      pooledObserved: {
        weeks: 15,
        positiveWeekCount: 5,
        positiveWeekPct: 0.33,
        medianWeeklyExpectancyR: -0.01,
        bestWeek: null,
        worstWeek: null,
        longestLosingWeekStreak: 3,
        totalTrades: 200,
        winRate: 0.4,
        profitFactor: 0.98,
        expectancyR: -0.01,
        netR: -2,
        buyTrades: 100,
        sellTrades: 100,
        buyExpectancyR: -0.06,
        sellExpectancyR: 0.04,
        byRegime: {},
        sampleSize: "INFORMATIVE"
      },
      zeroExpectancyR: 0.02,
      holdoutTrades: 50,
      holdoutExpectancyR: -0.04,
      holdoutProfitFactor: 0.92,
      positiveWeekPct: 0.33,
      wfPositivePct: 0.3,
      survivesAssumedSlip010: false
    });
    expect(noEdge.classification).toBe("RAW_EDGE_COST_SENSITIVE");
  });
});
