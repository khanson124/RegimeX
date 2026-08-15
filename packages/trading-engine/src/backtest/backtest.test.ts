import { describe, expect, it } from "vitest";
import { RiseFallContractSimulator } from "./contractSimulator.js";
import { computeSummary, type SimulatedTrade } from "./metrics.js";
import { Backtester } from "./backtester.js";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "../strategies/breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "../strategies/emaPullback.js";
import { syntheticCandles } from "../testing/fixtures.js";

describe("RiseFallContractSimulator", () => {
  const sim = new RiseFallContractSimulator();

  it("CALL wins when exit > entry", () => {
    const r = sim.simulate({ direction: "CALL", entryPrice: 100, exitPrice: 101, stake: 1, assumedPayoutRatio: 0.95 });
    expect(r.outcome).toBe("WIN");
    expect(r.profit).toBe(0.95);
    expect(r.payout).toBe(1.95);
    expect(r.simulated).toBe(true);
  });

  it("CALL loses when exit < entry", () => {
    const r = sim.simulate({ direction: "CALL", entryPrice: 100, exitPrice: 99, stake: 1, assumedPayoutRatio: 0.95 });
    expect(r.outcome).toBe("LOSS");
    expect(r.profit).toBe(-1);
    expect(r.payout).toBe(0);
  });

  it("PUT wins when exit < entry", () => {
    const r = sim.simulate({ direction: "PUT", entryPrice: 100, exitPrice: 99, stake: 2, assumedPayoutRatio: 0.9 });
    expect(r.outcome).toBe("WIN");
    expect(r.profit).toBe(1.8);
  });

  it("equal prices push and return the stake", () => {
    const r = sim.simulate({ direction: "CALL", entryPrice: 100, exitPrice: 100, stake: 1, assumedPayoutRatio: 0.95 });
    expect(r.outcome).toBe("PUSH");
    expect(r.profit).toBe(0);
    expect(r.payout).toBe(1);
  });
});

describe("computeSummary — known dataset exact results", () => {
  function trade(profit: number, outcome: "WIN" | "LOSS", t: number): SimulatedTrade {
    return {
      strategyId: "s1",
      strategyVersion: "1",
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8,
      action: "BUY",
      entryTime: t,
      exitTime: t + 300_000,
      entryPrice: 100,
      exitPrice: outcome === "WIN" ? 101 : 99,
      stake: 1,
      payout: outcome === "WIN" ? 1 + profit : 0,
      profit,
      outcome,
      confidence: 0.7,
      entryReason: [],
      isOutOfSample: false
    };
  }

  it("computes exact metrics for W,W,L,W,L,L", () => {
    const trades = [
      trade(0.95, "WIN", 1),
      trade(0.95, "WIN", 2),
      trade(-1, "LOSS", 3),
      trade(0.95, "WIN", 4),
      trade(-1, "LOSS", 5),
      trade(-1, "LOSS", 6)
    ];
    const { summary, equityCurve } = computeSummary(trades, 100);
    expect(summary.totalTrades).toBe(6);
    expect(summary.winningTrades).toBe(3);
    expect(summary.losingTrades).toBe(3);
    expect(summary.winRate).toBeCloseTo(0.5, 10);
    expect(summary.grossProfit).toBe(2.85);
    expect(summary.grossLoss).toBe(3);
    expect(summary.netProfit).toBe(-0.15);
    expect(summary.profitFactor).toBeCloseTo(0.95, 4);
    expect(summary.longestWinStreak).toBe(2);
    expect(summary.longestLossStreak).toBe(2);
    expect(summary.endingBalance).toBe(99.85);
    expect(summary.expectancy).toBeCloseTo(-0.025, 10);
    expect(equityCurve).toHaveLength(6);
    // Max drawdown: peak 101.9 (after trade 2) → 99.85 at the end = 2.05
    expect(summary.maxDrawdown).toBe(2.05);
  });
});

describe("Backtester", () => {
  const strategies = [
    { strategy: new BreakoutMomentumStrategy(), parameters: { ...BREAKOUT_MOMENTUM_DEFAULTS } },
    { strategy: new EmaPullbackStrategy(), parameters: { ...EMA_PULLBACK_DEFAULTS } }
  ];

  const config = {
    startingBalance: 1000,
    stakeAmount: 1,
    contractDurationCandles: 5,
    assumedPayoutRatio: 0.95,
    testSplit: 0.3,
    selectionMode: "AUTO" as const,
    strategies
  };

  it("is deterministic: identical inputs produce identical results", async () => {
    const candles = syntheticCandles({ count: 600, seed: 7, drift: 0.4, volatility: 3 });
    const a = await new Backtester(config).run(candles);
    const b = await new Backtester(config).run(candles);
    expect(a.summary).toEqual(b.summary);
    expect(a.trades).toEqual(b.trades);
  });

  it("has no look-ahead bias: changing future candles does not change earlier decisions", async () => {
    const base = syntheticCandles({ count: 600, seed: 7, drift: 0.4, volatility: 3 });
    const resultFull = await new Backtester({ ...config, testSplit: 0 }).run(base);

    // Mutate the last 50 candles drastically.
    const mutated = base.map((c, i) =>
      i >= 550 ? { ...c, open: c.open * 2, high: c.high * 2.2, low: c.low * 1.9, close: c.close * 2.1 } : c
    );
    const resultMutated = await new Backtester({ ...config, testSplit: 0 }).run(mutated);

    const cutoff = base[540]!.closeTime;
    const earlyFull = resultFull.trades.filter((t) => t.entryTime < cutoff && t.exitTime < cutoff);
    const earlyMutated = resultMutated.trades.filter((t) => t.entryTime < cutoff && t.exitTime < cutoff);
    expect(earlyMutated).toEqual(earlyFull);
  });

  it("marks trades in the test split as out-of-sample and reports validation", async () => {
    const candles = syntheticCandles({ count: 800, seed: 3, drift: 0.5, volatility: 3 });
    const result = await new Backtester(config).run(candles);
    expect(result.validation).not.toBeNull();
    const splitTime = candles[Math.floor(800 * 0.7)]!.closeTime;
    for (const t of result.trades) {
      if (t.entryTime >= splitTime) expect(t.isOutOfSample).toBe(true);
    }
  });

  it("supports cancellation through the progress hook", async () => {
    const candles = syntheticCandles({ count: 2000, seed: 5, drift: 0.3, volatility: 3 });
    const result = await new Backtester(config).run(candles, {
      chunkSize: 100,
      onProgress: (p) => p.processed < 200
    });
    expect(result.cancelled).toBe(true);
  });

  it("records regime timeline and per-regime performance", async () => {
    const candles = syntheticCandles({ count: 800, seed: 11, drift: 0.4, volatility: 3 });
    const result = await new Backtester(config).run(candles);
    expect(result.regimeTimeline.length).toBeGreaterThan(0);
    const totalCounted = result.regimeTimeline.reduce((a, r) => a + r.count, 0);
    expect(totalCounted).toBeGreaterThan(0);
  });
});
