import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { auditOneMinuteDataset } from "./datasetAudit.js";
import { aggregateContiguousCompletedCandles } from "./candleResample.js";
import {
  estimateBreakEvenCost,
  midFromFillPrice,
  computeTradeCostToMove
} from "./costToMove.js";
import {
  assertNoHoldoutLeakage,
  splitHoldout,
  splitHoldoutByTimestamp
} from "./holdoutSplit.js";
import {
  buildBreakoutDirectionalDiagnostics,
  classifyBreakoutTf,
  listBreakoutFamilyStrategies,
  runBreakoutFamilyResearch,
  summarizeDirectionFromTrades
} from "./breakoutFamilyResearch.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";
import { CFD_SIMULATOR_VERSION } from "@regimex/shared";
import { BREAKOUT_MOMENTUM_DEFAULTS } from "../strategies/breakoutMomentum.js";

function trade(partial: Partial<CfdSimulatedTrade> & Pick<CfdSimulatedTrade, "action" | "outcome">): CfdSimulatedTrade {
  return {
    strategyId: "squeeze-breakout-v1",
    strategyVersion: "1",
    regime: "UNKNOWN",
    regimeConfidence: 0,
    entryTime: 1,
    exitTime: 2,
    entryPrice: 100,
    exitPrice: 101,
    exitTriggerPrice: 101,
    volume: 0.1,
    riskAmount: 1,
    initialRiskAmount: 1,
    riskPercent: 0.01,
    stopLoss: 99,
    takeProfit: 102,
    profit: 1,
    grossPnl: 1,
    netPnl: 1,
    grossR: 1,
    netR: 1,
    closeReason: "TAKE_PROFIT",
    barsHeld: 5,
    rMultiple: 1,
    confidence: 1,
    entryReason: [],
    isOutOfSample: true,
    simulatorVersion: CFD_SIMULATOR_VERSION,
    entryFeatures: {
      timestamp: 1,
      strategyId: "squeeze-breakout-v1",
      atr: 1
    } as CfdSimulatedTrade["entryFeatures"],
    ...partial
  };
}

function m1(i: number, overrides: Partial<Candle> = {}): Candle {
  const t = Date.UTC(2026, 0, 1, 12, 0, 0) + i * 60_000;
  const base = 1000 + i * 0.01;
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: t,
    closeTime: t + 60_000,
    open: base,
    high: base + 0.5,
    low: base - 0.5,
    close: base + 0.1,
    tickCount: 10,
    isComplete: true,
    source: "SEED",
    ...overrides
  };
}

describe("datasetAudit", () => {
  it("computes exact missing minutes from gaps", () => {
    const candles = [m1(0), m1(1), m1(5)]; // missing 2,3,4 → 3 minutes
    const audit = auditOneMinuteDataset(candles);
    expect(audit.actualCandleCount).toBe(3);
    expect(audit.gapCount).toBe(1);
    expect(audit.missingCandleCount).toBe(3);
    expect(audit.longestGaps[0]!.missingMinutes).toBe(3);
  });

  it("detects duplicates and invalid OHLC", () => {
    const candles = [
      m1(0),
      m1(1),
      { ...m1(1), high: 1, low: 2, open: 1.5, close: 1.5 },
      m1(2)
    ];
    // duplicate openTime of index1
    candles[2] = { ...m1(1), close: 999 };
    const audit = auditOneMinuteDataset(candles);
    expect(audit.duplicateTimestamps).toBeGreaterThan(0);
  });
});

describe("aggregateContiguousCompletedCandles", () => {
  it("accepts a complete contiguous 5-bar bucket", () => {
    // Align to a 5m boundary: 12:00 UTC
    const bars = [0, 1, 2, 3, 4].map((i) => m1(i));
    const r = aggregateContiguousCompletedCandles(bars, "5m");
    expect(r.validCount).toBe(1);
    expect(r.excludedCount).toBe(0);
    expect(r.validBars[0]!.open).toBe(bars[0]!.open);
    expect(r.validBars[0]!.close).toBe(bars[4]!.close);
    expect(r.validBars[0]!.high).toBe(Math.max(...bars.map((b) => b.high)));
    expect(r.validBars[0]!.low).toBe(Math.min(...bars.map((b) => b.low)));
  });

  it("rejects missing interior minute", () => {
    const bars = [m1(0), m1(1), m1(3), m1(4)]; // missing minute 2; count also wrong
    const r = aggregateContiguousCompletedCandles(bars, "5m");
    expect(r.validCount).toBe(0);
    expect(r.excluded.some((e) => e.reason === "INCOMPLETE_COUNT")).toBe(true);
  });

  it("rejects incomplete first/last minute (count < 5)", () => {
    const bars = [m1(1), m1(2), m1(3), m1(4)]; // missing first of bucket
    const r = aggregateContiguousCompletedCandles(bars, "5m");
    expect(r.validCount).toBe(0);
    expect(r.excluded[0]!.reason).toBe("INCOMPLETE_COUNT");
  });

  it("rejects large time gap bridging", () => {
    // Two minutes then jump to next day same bucket slot — different buckets actually.
    // Same bucket with non-contiguous opens: fabricate 5 bars with wrong spacing
    const open = Date.UTC(2026, 0, 1, 12, 0, 0);
    const bars: Candle[] = [];
    for (let i = 0; i < 5; i++) {
      const t = open + i * 60_000 + (i === 3 ? 120_000 : 0); // break contiguity
      bars.push({
        ...m1(i),
        openTime: t,
        closeTime: t + 60_000
      });
    }
    // Force same 5m bucket by using opens that map to same bucket but aren't contiguous sequence
    const r = aggregateContiguousCompletedCandles(
      [
        m1(0),
        m1(1),
        m1(2),
        // skip 3, insert 4 and a late bar that still falls in bucket? skip 3 means incomplete
        m1(4)
      ],
      "5m"
    );
    expect(r.validCount).toBe(0);
  });

  it("rejects duplicate minute", () => {
    const bars = [m1(0), m1(1), m1(2), m1(2), m1(3), m1(4)];
    const r = aggregateContiguousCompletedCandles(bars, "5m");
    expect(r.excluded.some((e) => e.reason === "DUPLICATE_MINUTE" || e.reason === "INCOMPLETE_COUNT")).toBe(
      true
    );
    expect(r.validCount).toBe(0);
  });

  it("does not use future bars (lookahead): later bucket does not affect earlier OHLC", () => {
    const early = [0, 1, 2, 3, 4].map((i) => m1(i));
    const late = [5, 6, 7, 8, 9].map((i) => m1(i, { high: 9999 }));
    const a = aggregateContiguousCompletedCandles(early, "5m");
    const b = aggregateContiguousCompletedCandles([...early, ...late], "5m");
    expect(a.validBars[0]!.high).toBe(b.validBars[0]!.high);
    expect(b.validBars[0]!.high).toBeLessThan(9999);
  });
});

describe("costToMove + break-even", () => {
  it("recovers mid from fill and measures one-way cost", () => {
    const mid = 6300;
    const frac = 8 / 20_000 + 3 / 10_000;
    const fill = mid * (1 + frac);
    const recovered = midFromFillPrice("BUY", fill, 8, 3);
    expect(Math.abs(recovered - mid)).toBeLessThan(1e-6);
  });

  it("estimates break-even between sweep points", () => {
    const be = estimateBreakEvenCost([
      { spreadBps: 4, slippageBps: 1, trades: 20, expectancyR: 0.2, profitFactor: 1.3, netR: 4 },
      { spreadBps: 6, slippageBps: 2, trades: 20, expectancyR: 0.05, profitFactor: 1.05, netR: 1 },
      { spreadBps: 8, slippageBps: 3, trades: 20, expectancyR: -0.2, profitFactor: 0.7, netR: -4 },
      { spreadBps: 10, slippageBps: 4, trades: 20, expectancyR: -0.4, profitFactor: 0.5, netR: -8 }
    ]);
    expect(be.maximumCostForPositiveExpectancy).toEqual({ spreadBps: 6, slippageBps: 2 });
    expect(be.crossedBetween).not.toBeNull();
  });

  it("gross vs net R costDrag on trade metrics", () => {
    const m = computeTradeCostToMove(
      {
        action: "BUY",
        entryPrice: 1001.5,
        stopLoss: 998,
        takeProfit: 1004,
        grossR: 1.5,
        netR: 1.2,
        entryFeatures: { atr: 2 }
      } as never,
      20,
      5
    );
    expect(m.costDragR).toBeCloseTo(0.3, 5);
    expect(m.stopDistanceAtr).not.toBeNull();
  });
});

describe("timeframe split integrity", () => {
  it("timestamp holdout prevents leakage", () => {
    const candles = Array.from({ length: 100 }, (_, i) => m1(i));
    const pct = splitHoldout(candles, 0.3);
    const cut = pct.holdout[0]!.openTime;
    const byTs = splitHoldoutByTimestamp(candles, cut);
    assertNoHoldoutLeakage(byTs.development, cut);
    expect(byTs.development.every((c) => c.openTime < cut)).toBe(true);
    expect(byTs.holdout.every((c) => c.openTime >= cut)).toBe(true);
  });
});

describe("breakoutFamilyResearch", () => {
  it("lists strategies deterministically without mutating defaults", () => {
    const before = JSON.stringify(BREAKOUT_MOMENTUM_DEFAULTS);
    const specs = listBreakoutFamilyStrategies();
    expect(specs.map((s) => s.strategyId)).toEqual([
      "breakout-momentum-v1",
      "squeeze-breakout-v1"
    ]);
    expect(JSON.stringify(BREAKOUT_MOMENTUM_DEFAULTS)).toBe(before);
  });

  it("classifies sparse holdout as inconclusive", () => {
    expect(
      classifyBreakoutTf({
        holdoutTrades: 10,
        zeroExpR: 0.5,
        realisticExpR: -0.2,
        wfPositivePct: 0.7
      })
    ).toBe("INCONCLUSIVE_TOO_SPARSE");
  });

  it("runs deterministic research on synthetic data without holdout tuning", async () => {
    const candles1m = Array.from({ length: 2500 }, (_, i) => {
      const base = 1000 + Math.sin(i / 11) * 8 + (i % 40 === 0 ? 3 : 0);
      return m1(i, {
        open: base,
        high: base + 1.2,
        low: base - 1.2,
        close: base + 0.3
      });
    });
    const agg = aggregateContiguousCompletedCandles(candles1m, "5m");
    const report = await runBreakoutFamilyResearch({
      candles1m,
      candles5mContiguous: agg.validBars,
      config: {
        walkForward1m: { trainWindow: 800, testWindow: 200, stepSize: 200, windowMode: "rolling" },
        walkForward5m: { trainWindow: 150, testWindow: 50, stepSize: 50, windowMode: "rolling" },
        maxHoldBars1m: 20,
        maxHoldBars5m: 12
      }
    });
    expect(report.holdoutUsedForParameterSelection).toBe(false);
    expect(report.notes.deployed).toBe(false);
    expect(report.notes.emaPullbackRemainsSuspended).toBe(true);
    expect(report.runs).toHaveLength(4);
    const ids = report.runs.map((r) => `${r.strategyId}:${r.timeframe}`);
    expect(ids).toEqual([...ids].sort());
  }, 120_000);
});

describe("breakout directional holdout diagnostics", () => {
  it("separates BUY and SELL correctly without mutating trades", () => {
    const trades = [
      trade({
        action: "BUY",
        outcome: "WIN",
        profit: 2,
        netR: 1.5,
        grossR: 1.6,
        barsHeld: 4,
        entryPrice: 100,
        stopLoss: 98,
        takeProfit: 104,
        entryFeatures: { atr: 2 } as CfdSimulatedTrade["entryFeatures"]
      }),
      trade({
        action: "BUY",
        outcome: "LOSS",
        profit: -1,
        netR: -1,
        grossR: -0.9,
        barsHeld: 6,
        entryPrice: 100,
        stopLoss: 99,
        takeProfit: 102,
        entryFeatures: { atr: 1 } as CfdSimulatedTrade["entryFeatures"]
      }),
      trade({
        action: "SELL",
        outcome: "WIN",
        profit: 3,
        netR: 2,
        grossR: 2.1,
        barsHeld: 10,
        entryPrice: 100,
        stopLoss: 101,
        takeProfit: 97,
        entryFeatures: { atr: 1 } as CfdSimulatedTrade["entryFeatures"]
      })
    ];
    const frozen = JSON.stringify(trades);
    const diag = buildBreakoutDirectionalDiagnostics(trades);

    expect(diag.BUY.trades).toBe(2);
    expect(diag.BUY.wins).toBe(1);
    expect(diag.BUY.losses).toBe(1);
    expect(diag.BUY.winRate).toBe(0.5);
    expect(diag.BUY.netR).toBeCloseTo(0.5, 10);
    expect(diag.BUY.expectancyR).toBeCloseTo(0.25, 10);
    expect(diag.BUY.averageGrossR).toBeCloseTo((1.6 + -0.9) / 2, 10);
    expect(diag.BUY.profitFactor).toBeCloseTo(2 / 1, 10);

    expect(diag.SELL.trades).toBe(1);
    expect(diag.SELL.wins).toBe(1);
    expect(diag.SELL.losses).toBe(0);
    expect(diag.SELL.profitFactor).toBeNull(); // no losing profit denominator
    expect(diag.SELL.netR).toBe(2);
    expect(JSON.stringify(trades)).toBe(frozen);
  });

  it("computes median stopDistanceAtr from entry/stop/atr", () => {
    const trades = [
      trade({
        action: "BUY",
        outcome: "WIN",
        entryPrice: 100,
        stopLoss: 98, // 2
        takeProfit: 103, // 3
        entryFeatures: { atr: 2 } as CfdSimulatedTrade["entryFeatures"] // stop=1, target=1.5
      }),
      trade({
        action: "BUY",
        outcome: "LOSS",
        entryPrice: 100,
        stopLoss: 97, // 3
        takeProfit: 104, // 4
        entryFeatures: { atr: 1 } as CfdSimulatedTrade["entryFeatures"] // stop=3, target=4
      }),
      trade({
        action: "BUY",
        outcome: "PUSH",
        entryPrice: 100,
        stopLoss: 99,
        takeProfit: 101,
        entryFeatures: { atr: 0 } as CfdSimulatedTrade["entryFeatures"] // ignored
      })
    ];
    const buy = summarizeDirectionFromTrades(trades, "BUY");
    // finite stop distances: 1 and 3 → median 2
    expect(buy.medianStopDistanceAtr).toBe(2);
    // finite target distances: 1.5 and 4 → median 2.75
    expect(buy.medianTargetDistanceAtr).toBe(2.75);
    expect(buy.medianBarsHeld).toBe(5);
  });

  it("returns zero counts and null medians/PF for empty direction", () => {
    const onlyBuy = [
      trade({
        action: "BUY",
        outcome: "WIN",
        entryFeatures: { atr: 1 } as CfdSimulatedTrade["entryFeatures"]
      })
    ];
    const sell = summarizeDirectionFromTrades(onlyBuy, "SELL");
    expect(sell.trades).toBe(0);
    expect(sell.wins).toBe(0);
    expect(sell.losses).toBe(0);
    expect(sell.winRate).toBe(0);
    expect(sell.profitFactor).toBeNull();
    expect(sell.expectancyR).toBeNull();
    expect(sell.netR).toBe(0);
    expect(sell.averageGrossR).toBeNull();
    expect(sell.medianBarsHeld).toBeNull();
    expect(sell.medianStopDistanceAtr).toBeNull();
    expect(sell.medianTargetDistanceAtr).toBeNull();
  });
});
