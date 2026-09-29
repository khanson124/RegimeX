import { describe, expect, it } from "vitest";
import { type Candle, type MarketRegime, type StrategyDecision } from "@regimex/shared";
import { type TradingStrategy, type StrategyContext } from "../strategies/types.js";
import { syntheticCandles } from "../testing/fixtures.js";
import { minimumCandlesForFeatures, DEFAULT_FEATURE_CONFIG } from "../features/featureExtractor.js";
import {
  computeWarmupNeed,
  formatAutoSelectionReplayMarkdown,
  replayForwardTrialBlockReason,
  runAutoSelectionCounterfactualReplay,
  strategiesForWarmupNeed,
  type ReplayStrategyDefinition
} from "./autoSelectionCounterfactualReplay.js";

const ALL_REGIMES: MarketRegime[] = [
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
];

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
  action:
    | StrategyDecision["action"]
    | ((ctx: StrategyContext) => StrategyDecision["action"]);
  cooldownCandles?: number;
  minimumHistory?: number;
  allowedSymbols?: string[];
  allowedIntervals?: string[];
}): TradingStrategy {
  const cooldown = input.cooldownCandles ?? 0;
  return {
    id: input.id,
    name: input.id,
    version: "1",
    kind: input.kind,
    supportedRegimes: input.supportedRegimes,
    minimumHistory: input.minimumHistory ?? 5,
    eligibility: {
      minimumRegimeConfidence: 0.1,
      ...(input.allowedSymbols ? { allowedSymbols: input.allowedSymbols } : {}),
      ...(input.allowedIntervals ? { allowedIntervals: input.allowedIntervals } : {})
    },
    validateParameters: (raw) => raw as Record<string, number | boolean | string>,
    evaluate(ctx: StrategyContext): StrategyDecision {
      const ts = ctx.candles[ctx.candles.length - 1]?.closeTime ?? 0;
      if (cooldown > 0 && ctx.candlesSinceLastSignal < cooldown) {
        return holdLike(this, ts, "HOLD", [`Cooldown ${ctx.candlesSinceLastSignal}/${cooldown}`]);
      }
      const action =
        typeof input.action === "function" ? input.action(ctx) : input.action;
      return holdLike(this, ts, action, [`mock-${action}`]);
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
      supportedRegimes: ALL_REGIMES,
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

    const productionWinner = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "HOLD"
    });
    const shadowBuyer = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
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
      expect(bar.production.evaluation).not.toBeNull();
      expect(bar.production.evaluation?.strategyId).toBe(bar.production.selectedStrategyId);
      expect(bar.shadow.map((s) => s.strategyId).sort()).toEqual([...bar.eligibleStrategyIds].sort());
      expect(bar.fallback.rankingOrder[0]).toBe(bar.production.selectedStrategyId);
    }

    const missed = report.bars.filter((b) => b.missedBuyOpportunity);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((b) => b.production.evaluation?.action !== "BUY")).toBe(true);
    expect(missed.every((b) => b.shadow.some((s) => s.action === "BUY"))).toBe(true);
    expect(report.counts.missedBuyOpportunityBars).toBe(missed.length);
  });

  it("Pass C falls through when rank #1 HOLDs and rank #2 BUYs", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[140]!.openTime + 60_000;

    const rank1 = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "HOLD"
    });
    const rank2 = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
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
      strategies: defs([rank1, rank2])
    });

    const fallthrough = report.bars.filter(
      (b) =>
        b.eligibleStrategyIds.length >= 2 &&
        b.production.selectedStrategyId === "breakout-momentum-v1" &&
        b.production.evaluation?.action === "HOLD" &&
        b.fallback.action === "BUY" &&
        b.fallback.selectedStrategyId === "ema-pullback-v1"
    );
    expect(fallthrough.length).toBeGreaterThan(0);
    const sample = fallthrough[0]!;
    expect(sample.fallback.rankingOrder[0]).toBe("breakout-momentum-v1");
    expect(sample.fallback.triedEvaluations.map((e) => e.strategyId)).toEqual([
      "breakout-momentum-v1",
      "ema-pullback-v1"
    ]);
    expect(report.counts.fallbackBuy).toBeGreaterThan(0);
    expect(report.counts.fallbackFromProductionHold).toBeGreaterThan(0);
    expect(report.counts.fallbackByStrategy["ema-pullback-v1"]).toBeGreaterThan(0);
  });

  it("Pass C does not fall through when rank #1 already BUYs", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[140]!.openTime + 60_000;

    const rank1 = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "BUY"
    });
    const rank2 = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
      action: "SELL"
    });

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([rank1, rank2])
    });

    const winnerBuys = report.bars.filter(
      (b) =>
        b.eligibleStrategyIds.length >= 2 &&
        b.production.selectedStrategyId === "breakout-momentum-v1" &&
        b.production.evaluation?.action === "BUY"
    );
    expect(winnerBuys.length).toBeGreaterThan(0);
    for (const bar of winnerBuys) {
      expect(bar.fallback.selectedStrategyId).toBe("breakout-momentum-v1");
      expect(bar.fallback.action).toBe("BUY");
      expect(bar.fallback.triedEvaluations).toHaveLength(1);
      expect(bar.fallback.triedEvaluations[0]!.strategyId).toBe("breakout-momentum-v1");
    }
  });

  it("Pass C skips forward-trial-blocked actionable signal and continues to next ranked strategy", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[140]!.openTime + 60_000;

    // Narrow regimes → rank #1; SELL blocked by R10 squeeze FT on 5m.
    const blocked = mockStrategy({
      id: "squeeze-breakout-v1",
      kind: "squeeze-breakout",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION", "VOLATILITY_COMPRESSION"],
      action: "SELL"
    });
    const next = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
      action: "BUY"
    });

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "5m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "broker_demo_mt5",
      strategyAllowlist: ["squeeze-breakout-v1", "ema-pullback-v1"],
      strategies: defs([blocked, next])
    });

    const skipped = report.bars.filter(
      (b) =>
        b.production.selectedStrategyId === "squeeze-breakout-v1" &&
        b.fallback.triedEvaluations.some(
          (e) =>
            e.strategyId === "squeeze-breakout-v1" &&
            e.action === "SELL" &&
            e.forwardTrialBlocked
        ) &&
        b.fallback.selectedStrategyId === "ema-pullback-v1" &&
        b.fallback.action === "BUY"
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.fallback.triedEvaluations.length).toBeGreaterThanOrEqual(2);
  });

  it("Pass C cooldown state is independent of Pass A/B", () => {
    const candles = syntheticCandles({ count: 160, seed: 17, drift: 0.55, volatility: 2 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[130]!.openTime + 60_000;

    const rank1 = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "HOLD"
    });
    // Medium regime fit → typically alternatives[0]
    const mid = mockStrategy({
      id: "squeeze-breakout-v1",
      kind: "squeeze-breakout",
      supportedRegimes: [
        "STRONG_UPTREND",
        "WEAK_UPTREND",
        "BREAKOUT_EXPANSION",
        "VOLATILITY_COMPRESSION",
        "RANGE_LOW_VOLATILITY"
      ],
      action: "BUY",
      cooldownCandles: 50
    });
    // Broad → lower score; Pass B advances it on bar1, Pass C does not until mid cools.
    const broad = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
      action: "BUY",
      cooldownCandles: 50
    });

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([rank1, mid, broad])
    });

    const withThree = report.bars.filter((b) => b.eligibleStrategyIds.length >= 3);
    expect(withThree.length).toBeGreaterThanOrEqual(2);

    const first = withThree[0]!;
    expect(first.fallback.selectedStrategyId).toBe("squeeze-breakout-v1");
    expect(first.fallback.action).toBe("BUY");
    // Pass B also buys both mid and broad on first bar
    expect(first.shadow.find((s) => s.strategyId === "ema-pullback-v1")?.action).toBe("BUY");

    const second = withThree[1]!;
    // Pass B: broad cooled down after bar1 → HOLD
    expect(second.shadow.find((s) => s.strategyId === "ema-pullback-v1")?.action).toBe("HOLD");
    // Pass C: never advanced broad on bar1 → can still BUY broad after mid is on cooldown
    expect(second.fallback.selectedStrategyId).toBe("ema-pullback-v1");
    expect(second.fallback.action).toBe("BUY");
    expect(
      second.fallback.triedEvaluations.find((e) => e.strategyId === "squeeze-breakout-v1")?.action
    ).toBe("HOLD");
  });

  it("counts missed SELL opportunities symmetrically with missed BUYs", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const analysisStartMs = candles[100]!.openTime;
    const analysisEndMs = candles[140]!.openTime + 60_000;

    const productionWinner = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "HOLD"
    });
    const shadowSeller = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
      action: "SELL"
    });

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs,
      analysisEndMs,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([productionWinner, shadowSeller])
    });

    const missed = report.bars.filter((b) => b.missedSellOpportunity);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((b) => b.production.evaluation?.action !== "SELL")).toBe(true);
    expect(missed.every((b) => b.shadow.some((s) => s.action === "SELL"))).toBe(true);
    expect(report.counts.missedSellOpportunityBars).toBe(missed.length);
    expect(report.counts.missedSellByStrategy["ema-pullback-v1"]).toBeGreaterThan(0);
    expect(
      report.counts.independentMissedSellBars + report.counts.repeatedMissedSellBars
    ).toBe(report.counts.missedSellOpportunityBars);
    expect(report.counts.missedSellPassingForwardTrial).toBeGreaterThan(0);
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
        supportedRegimes: ALL_REGIMES,
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
      expect(after.bars[i]!.fallback.selectedStrategyId).toBe(
        before.bars[i]!.fallback.selectedStrategyId
      );
      expect(after.bars[i]!.fallback.action).toBe(before.bars[i]!.fallback.action);
      expect(after.bars[i]!.fallback.rankingOrder).toEqual(before.bars[i]!.fallback.rankingOrder);
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
          supportedRegimes: ALL_REGIMES,
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

  it("mirrors R10 squeeze forward-trial block reason (1m BUY|SELL allowed)", () => {
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
    ).toBeNull();
    expect(
      replayForwardTrialBlockReason({
        executionBackend: "broker_demo_mt5",
        symbol: "R_10",
        interval: "5m",
        strategyId: "squeeze-breakout-v1",
        action: "SELL"
      })
    ).toBe("R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY");
  });

  it("irrelevant high-minimumHistory strategies outside R_10 allowlist do not inflate warmupNeed", () => {
    const featureFloor = minimumCandlesForFeatures(DEFAULT_FEATURE_CONFIG);
    const r10 = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      supportedRegimes: ALL_REGIMES,
      action: "HOLD",
      minimumHistory: 80
    });
    const xauOnly = mockStrategy({
      id: "xau-trend-pullback-v1",
      kind: "xau-trend-pullback",
      supportedRegimes: ALL_REGIMES,
      action: "HOLD",
      minimumHistory: 10_000,
      allowedSymbols: ["XAUUSD"],
      allowedIntervals: ["15m"]
    });
    const allowlist = [
      "breakout-momentum-v1",
      "ema-pullback-v1",
      "squeeze-breakout-v1",
      "bollinger-reversion-v1"
    ];
    const cfg = {
      symbol: "R_10",
      interval: "1m",
      executionBackend: "broker_demo_mt5" as const,
      strategyAllowlist: allowlist
    };

    const scoped = strategiesForWarmupNeed(defs([r10, xauOnly]), cfg);
    expect(scoped.map((s) => s.strategy.id)).toEqual(["ema-pullback-v1"]);
    expect(computeWarmupNeed(defs([r10, xauOnly]), cfg)).toBe(Math.max(featureFloor, 80));
    expect(computeWarmupNeed(defs([r10, xauOnly]), cfg)).toBeLessThan(10_000);

    // Allowlist alone also excludes out-of-scope high-history strategies without symbol gates.
    const xauListedElsewhere = mockStrategy({
      id: "xau-trend-breakout-v2",
      kind: "xau-trend-breakout",
      supportedRegimes: ALL_REGIMES,
      action: "HOLD",
      minimumHistory: 10_000
    });
    expect(computeWarmupNeed(defs([r10, xauListedElsewhere]), cfg)).toBe(Math.max(featureFloor, 80));
  });

  it("formats a markdown report with production, fallback, and missed BUY/SELL counts", () => {
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
    expect(md).toContain("Production trades:");
    expect(md).toContain("Fallback (Pass C) trades:");
    expect(md).toContain("Missed BUY opportunity bars");
    expect(md).toContain("Missed SELL opportunity bars");
    expect(md).toContain("Fallback by strategy:");
    expect(md).toContain("Selector-mechanics only");
  });
});
