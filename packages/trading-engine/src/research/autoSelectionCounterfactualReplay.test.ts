import { describe, expect, it } from "vitest";
import { type Candle, type MarketRegime, type StrategyDecision } from "@regimex/shared";
import { type TradingStrategy, type StrategyContext } from "../strategies/types.js";
import { syntheticCandles } from "../testing/fixtures.js";
import {
  formatAutoSelectionReplayMarkdown,
  replayForwardTrialBlockReason,
  runAutoSelectionCounterfactualReplay,
  type ReplayStrategyDefinition
} from "./autoSelectionCounterfactualReplay.js";

function holdLike(
  strategy: Pick<TradingStrategy, "id" | "version">,
  timestamp: number,
  action: StrategyDecision["action"],
  reasons: string[]
): StrategyDecision {
  return {
    action,
    confidence: action === "HOLD" ? 0 : 0.8,
    entryReason: action === "HOLD" ? [] : reasons,
    invalidationReason: action === "HOLD" ? reasons : [],
    proposedStake: null,
    expiryDuration: null,
    expiryUnit: null,
    signalTimestamp: timestamp,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    metadata: {}
  };
}

function mockStrategy(input: {
  id: string;
  kind: TradingStrategy["kind"];
  supportedRegimes: MarketRegime[];
  action: StrategyDecision["action"];
  cooldownCandles?: number;
}): TradingStrategy {
  const cooldown = input.cooldownCandles ?? 0;
  return {
    id: input.id,
    name: input.id,
    version: "1",
    kind: input.kind,
    supportedRegimes: input.supportedRegimes,
    minimumHistory: 5,
    eligibility: { minimumRegimeConfidence: 0.1 },
    validateParameters: (raw) => raw as Record<string, number | boolean | string>,
    evaluate(ctx: StrategyContext): StrategyDecision {
      const ts = ctx.candles[ctx.candles.length - 1]?.closeTime ?? 0;
      if (cooldown > 0 && ctx.candlesSinceLastSignal < cooldown) {
        return holdLike(this, ts, "HOLD", [`Cooldown ${ctx.candlesSinceLastSignal}/${cooldown}`]);
      }
      return holdLike(this, ts, input.action, [`mock-${input.action}`]);
    }
  };
}

function defs(strategies: TradingStrategy[]): ReplayStrategyDefinition[] {
  return strategies.map((strategy) => ({
    strategy,
    parameters: {},
    enabled: true
  }));
}

describe("autoSelectionCounterfactualReplay", () => {
  it("ignores incomplete candles and reports closed-candle integrity", () => {
    const base = syntheticCandles({ count: 120, seed: 3, drift: 0.4, volatility: 2 });
    const incomplete = {
      ...base[base.length - 1]!,
      openTime: base[base.length - 1]!.openTime + 60_000,
      closeTime: base[base.length - 1]!.closeTime + 60_000,
      isComplete: false
    } satisfies Candle;
    const candles = [...base, incomplete];
    const analysisStartMs = base[80]!.openTime;
    const analysisEndMs = base[base.length - 1]!.openTime + 60_000;

    const holder = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND"],
      action: "HOLD"
    });
    const buyer = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: [
        "STRONG_UPTREND",
        "WEAK_UPTREND",
        "STRONG_DOWNTREND",
        "WEAK_DOWNTREND",
        "BREAKOUT_EXPANSION",
        "RANGE_LOW_VOLATILITY",
        "RANGE_HIGH_VOLATILITY",
        "VOLATILITY_COMPRESSION"
      ],
      action: "BUY"
    });

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([holder, buyer])
    });

    expect(report.coverage.completeCandles).toBe(base.length);
    expect(report.limitations.some((l) => l.includes("isComplete=false"))).toBe(true);
    expect(report.bars.every((b) => b.openTimeMs <= base[base.length - 1]!.openTime)).toBe(true);
  });

  it("Pass A evaluates only the winner while Pass B evaluates every eligible strategy", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[140]!.openTime + 60_000;

    // Narrow supportedRegimes → higher bootstrap regimeFit → preferred production winner.
    const productionWinner = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "HOLD"
    });
    const shadowBuyer = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: [
        "STRONG_UPTREND",
        "WEAK_UPTREND",
        "STRONG_DOWNTREND",
        "WEAK_DOWNTREND",
        "BREAKOUT_EXPANSION",
        "RANGE_LOW_VOLATILITY",
        "RANGE_HIGH_VOLATILITY",
        "VOLATILITY_COMPRESSION",
        "TRANSITION",
        "UNKNOWN"
      ],
      action: "BUY"
    });

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([productionWinner, shadowBuyer])
    });

    expect(report.counts.analysisBars).toBeGreaterThan(0);
    const withBothEligible = report.bars.filter((b) => b.eligibleStrategyIds.length >= 2);
    expect(withBothEligible.length).toBeGreaterThan(0);

    for (const bar of withBothEligible) {
      // Pass A: only one evaluation (the selected winner)
      expect(bar.production.evaluation).not.toBeNull();
      expect(bar.production.evaluation?.strategyId).toBe(bar.production.selectedStrategyId);
      // Pass B: every eligible strategy evaluated
      expect(bar.shadow.map((s) => s.strategyId).sort()).toEqual([...bar.eligibleStrategyIds].sort());
    }

    const missed = report.bars.filter((b) => b.missedBuyOpportunity);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((b) => b.production.evaluation?.action !== "BUY")).toBe(true);
    expect(missed.every((b) => b.shadow.some((s) => s.action === "BUY"))).toBe(true);
    expect(report.counts.missedBuyOpportunityBars).toBe(missed.length);
  });

  it("does not look ahead: appending a future closed candle leaves earlier bar decisions unchanged", () => {
    const candles = syntheticCandles({ count: 150, seed: 5, drift: 0.45, volatility: 2 });
    const analysisStartMs = candles[110]!.openTime;
    const mid = candles[120]!;
    const analysisEndMs = mid.openTime + 60_000;

    const strategies = defs([
      mockStrategy({
        id: "breakout-momentum-v1",
        kind: "breakout-momentum",
        supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
        action: "HOLD"
      }),
      mockStrategy({
        id: "ema-pullback-v1",
        kind: "ema-pullback",
        supportedRegimes: [
          "STRONG_UPTREND",
          "WEAK_UPTREND",
          "STRONG_DOWNTREND",
          "WEAK_DOWNTREND",
          "BREAKOUT_EXPANSION",
          "RANGE_LOW_VOLATILITY",
          "RANGE_HIGH_VOLATILITY",
          "VOLATILITY_COMPRESSION"
        ],
        action: "BUY"
      })
    ]);

    const cfg = {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP" as const,
      executionBackend: "paper_cfd" as const,
      strategyAllowlist: [] as string[],
      strategies
    };

    const before = runAutoSelectionCounterfactualReplay(candles.slice(0, 121), cfg);
    const future = {
      ...candles[121]!,
      openTime: mid.openTime + 60_000,
      closeTime: mid.closeTime + 60_000,
      close: mid.close + 50
    };
    const after = runAutoSelectionCounterfactualReplay([...candles.slice(0, 121), future], cfg);

    expect(before.bars).toHaveLength(after.bars.length);
    for (let i = 0; i < before.bars.length; i++) {
      expect(after.bars[i]!.regime).toBe(before.bars[i]!.regime);
      expect(after.bars[i]!.production.selectedStrategyId).toBe(
        before.bars[i]!.production.selectedStrategyId
      );
      expect(after.bars[i]!.production.evaluation?.action).toBe(
        before.bars[i]!.production.evaluation?.action
      );
      expect(after.bars[i]!.shadow.map((s) => s.action)).toEqual(
        before.bars[i]!.shadow.map((s) => s.action)
      );
    }
  });

  it("marks repeated missed BUY setups across consecutive bars vs independent starts", () => {
    const candles = syntheticCandles({ count: 140, seed: 9, drift: 0.6, volatility: 1.5 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[110]!.openTime + 60_000;

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([
        mockStrategy({
          id: "breakout-momentum-v1",
          kind: "breakout-momentum",
          supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
          action: "HOLD"
        }),
        mockStrategy({
          id: "ema-pullback-v1",
          kind: "ema-pullback",
          supportedRegimes: [
            "STRONG_UPTREND",
            "WEAK_UPTREND",
            "STRONG_DOWNTREND",
            "WEAK_DOWNTREND",
            "BREAKOUT_EXPANSION",
            "RANGE_LOW_VOLATILITY",
            "RANGE_HIGH_VOLATILITY",
            "VOLATILITY_COMPRESSION"
          ],
          action: "BUY",
          cooldownCandles: 0
        })
      ])
    });

    const missed = report.bars.filter((b) => b.missedBuyOpportunity);
    if (missed.length >= 2) {
      expect(report.counts.independentMissedBuyBars).toBeGreaterThanOrEqual(1);
      expect(
        report.counts.independentMissedBuyBars + report.counts.repeatedMissedBuyBars
      ).toBe(report.counts.missedBuyOpportunityBars);
    }
  });

  it("mirrors R10 squeeze forward-trial block reason", () => {
    expect(
      replayForwardTrialBlockReason({
        executionBackend: "broker_demo_mt5",
        symbol: "R_10",
        interval: "1m",
        strategyId: "squeeze-breakout-v1",
        action: "BUY"
      })
    ).toBeNull();
    expect(
      replayForwardTrialBlockReason({
        executionBackend: "broker_demo_mt5",
        symbol: "R_10",
        interval: "1m",
        strategyId: "squeeze-breakout-v1",
        action: "SELL"
      })
    ).toBe("R10_SQUEEZE_FORWARD_TRIAL_1M_BUY_ONLY");
  });

  it("formats a markdown report with counts and limitations", () => {
    const candles = syntheticCandles({ count: 80, seed: 1, drift: 0.2 });
    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[60]!.openTime,
      analysisEndMs: candles[70]!.openTime + 60_000,
      selectionMode: "BOOTSTRAP",
      executionBackend: "broker_demo_mt5",
      strategyAllowlist: [],
      strategies: defs([
        mockStrategy({
          id: "squeeze-breakout-v1",
          kind: "squeeze-breakout",
          supportedRegimes: ["VOLATILITY_COMPRESSION", "BREAKOUT_EXPANSION"],
          action: "HOLD"
        })
      ])
    });
    const md = formatAutoSelectionReplayMarkdown(report);
    expect(md).toContain("AUTO selection counterfactual replay");
    expect(md).toContain("Limitations");
    expect(md).toContain("Counts");
  });
});
