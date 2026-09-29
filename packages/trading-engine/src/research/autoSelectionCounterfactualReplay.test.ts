import { describe, expect, it } from "vitest";
import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type StrategyDecision
} from "@regimex/shared";
import { type TradingStrategy, type StrategyContext } from "../strategies/types.js";
import { syntheticCandles } from "../testing/fixtures.js";
import {
  extractFeatures,
  minimumCandlesForFeatures,
  DEFAULT_FEATURE_CONFIG
} from "../features/featureExtractor.js";
import {
  aggregatePassEconomicMetrics,
  buildEmaFallbackFromHoldDiagnostics,
  buildEmaTradeDiagnostic,
  computeExcursions,
  computeFavorableBeforeStop,
  extensionBucket,
  formatEmaFallbackFromHoldMarkdown,
  stopDistanceBucket,
  buildFallbackFromHoldDiagnostics,
  computeWarmupNeed,
  formatAutoSelectionReplayMarkdown,
  formatFallbackFromHoldDiagnosticsMarkdown,
  replayForwardTrialBlockReason,
  runAutoSelectionCounterfactualReplay,
  simulatePassEconomicOutcomes,
  simulateStopTargetWalk,
  strategiesForWarmupNeed,
  type ReplaySimulatedTrade,
  type ReplayStrategyDefinition
} from "./autoSelectionCounterfactualReplay.js";
import { buildReplayTradePlan } from "./autoSelectionReplayOutcomes.js";

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
      supportedRegimes: input.supportedRegimes,
      requiredIndicators: [],
      minimumHistory: input.minimumHistory ?? 5,
      minimumRegimeConfidence: 0.1,
      minimumStrategyConfidence: 0,
      allowedSymbols: input.allowedSymbols ?? [],
      allowedIntervals: input.allowedIntervals ?? [],
      cooldownCandles: cooldown
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

  it("formats a markdown report with production, fallback, missed BUY/SELL, and Pass A vs C economics", () => {
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
    expect(md).toContain("Pass A vs Pass C (economic R)");
    expect(md).toContain("## Pass C fallback-from-HOLD diagnostics");
    expect(md).toContain("R-multiple comparison only");
    expect(report.economic).toBeDefined();
    expect(report.economic.entryConvention).toBe("NEXT_CANDLE_OPEN");
  });
});

function candleAt(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number
): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime,
    closeTime: openTime + 60_000,
    open,
    high,
    low,
    close,
    tickCount: 10,
    isComplete: true,
    source: "SEED"
  };
}

describe("autoSelectionReplayOutcomes", () => {
  it("BUY target hit before stop", () => {
    const walk = simulateStopTargetWalk({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      forwardBars: [
        candleAt(0, 100, 105, 99, 104),
        candleAt(60_000, 104, 111, 103, 110)
      ]
    });
    expect(walk.outcome).toBe("TARGET");
    expect(walk.exitPrice).toBe(110);
    expect(walk.realizedR).toBe(2);
    expect(walk.barsHeld).toBe(2);
  });

  it("BUY stop hit before target", () => {
    const walk = simulateStopTargetWalk({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      forwardBars: [candleAt(0, 100, 101, 94, 96)]
    });
    expect(walk.outcome).toBe("STOP");
    expect(walk.exitPrice).toBe(95);
    expect(walk.realizedR).toBe(-1);
  });

  it("SELL target hit before stop", () => {
    const walk = simulateStopTargetWalk({
      direction: "SELL",
      entryPrice: 100,
      stopLoss: 105,
      takeProfit: 90,
      forwardBars: [
        candleAt(0, 100, 101, 97, 98),
        candleAt(60_000, 98, 99, 89, 90)
      ]
    });
    expect(walk.outcome).toBe("TARGET");
    expect(walk.realizedR).toBe(2);
  });

  it("SELL stop hit before target", () => {
    const walk = simulateStopTargetWalk({
      direction: "SELL",
      entryPrice: 100,
      stopLoss: 105,
      takeProfit: 90,
      forwardBars: [candleAt(0, 100, 106, 99, 104)]
    });
    expect(walk.outcome).toBe("STOP");
    expect(walk.realizedR).toBe(-1);
  });

  it("both stop and target touched in same candle => AMBIGUOUS", () => {
    const walk = simulateStopTargetWalk({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      forwardBars: [candleAt(0, 100, 111, 94, 100)]
    });
    expect(walk.outcome).toBe("AMBIGUOUS");
    expect(walk.realizedR).toBeNull();
    expect(walk.exitPrice).toBeNull();
  });

  it("open trade at analysis end => OPEN_AT_END", () => {
    const walk = simulateStopTargetWalk({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 90,
      takeProfit: 120,
      forwardBars: [
        candleAt(0, 100, 105, 98, 103),
        candleAt(60_000, 103, 106, 101, 104)
      ]
    });
    expect(walk.outcome).toBe("OPEN_AT_END");
    expect(walk.realizedR).toBeNull();
    expect(walk.exitPrice).toBe(104);
  });

  it("missing stop/target => UNSCORABLE via buildReplayTradePlan", () => {
    const features = {
      atr: null,
      donchianLow: null,
      donchianHigh: null
    } as MarketFeatureSnapshot;
    const plan = buildReplayTradePlan({
      strategyId: "squeeze-breakout-v1",
      action: "BUY",
      confidence: 0.8,
      signalTimestampMs: 1,
      entryPrice: 100,
      features,
      candles: [],
      metadata: {},
      tickSize: 0.01
    });
    expect(plan.scorable).toBe(false);
    expect(plan.unscorableReason).toBe("CFD_STOP_TARGET_UNAVAILABLE");
  });

  it("uses next-candle-open entry convention", () => {
    const candles = [
      candleAt(0, 10, 11, 9, 10.5),
      candleAt(60_000, 10.5, 11, 10, 10.8),
      candleAt(120_000, 42, 50, 40, 45), // entry open = 42
      candleAt(180_000, 45, 80, 44, 70) // target path with wide range
    ];
    // Force a scorable plan by using features with ATR for squeeze
    const richFeatures = {
      atr: 2,
      donchianLow: 35,
      donchianHigh: 50
    } as MarketFeatureSnapshot;

    // Unit-level: build plan at next open
    const plan = buildReplayTradePlan({
      strategyId: "squeeze-breakout-v1",
      action: "BUY",
      confidence: 0.9,
      signalTimestampMs: candles[1]!.closeTime,
      entryPrice: candles[2]!.open,
      features: richFeatures,
      candles: candles.slice(0, 2),
      metadata: { squeezeLow: 35, squeezeHigh: 50 },
      tickSize: 0.01
    });
    expect(plan.scorable).toBe(true);
    expect(plan.entryPrice).toBe(42);

    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals: [
        {
          pass: "A",
          signalCandleIndex: 1,
          evaluation: {
            strategyId: "squeeze-breakout-v1",
            action: "BUY",
            confidence: 0.9,
            signalTimestampMs: candles[1]!.closeTime,
            decisionMetadata: { squeezeLow: 35, squeezeHigh: 50 }
          },
          fromProductionHold: false
        }
      ],
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01
    });
    const trade = comparison.trades.find((t) => t.pass === "A");
    expect(trade).toBeDefined();
    expect(trade!.entryPrice).toBe(42);
    expect(trade!.entryCandleIndex).toBe(2);
    expect(comparison.entryConvention).toBe("NEXT_CANDLE_OPEN");
  });

  it("Pass A and Pass C position state are independent", () => {
    // Narrow stop/target so each pass can score independently
    const candlesResolved = [
      candleAt(0, 100, 101, 99, 100),
      candleAt(60_000, 100, 101, 99, 100),
      candleAt(120_000, 100, 101, 99, 100), // entry for both at open 100
      candleAt(180_000, 100, 112, 99, 110) // BUY target 110 if stop 95
    ];

    const evalBuy = {
      strategyId: "squeeze-breakout-v1",
      action: "BUY" as const,
      confidence: 0.8,
      signalTimestampMs: candlesResolved[1]!.closeTime,
      decisionMetadata: { squeezeLow: 95, squeezeHigh: 105 }
    };
    const comparison = simulatePassEconomicOutcomes({
      candles: candlesResolved,
      signals: [
        { pass: "A", signalCandleIndex: 1, evaluation: evalBuy, fromProductionHold: false },
        {
          pass: "C",
          signalCandleIndex: 1,
          evaluation: { ...evalBuy, strategyId: "ema-pullback-v1" },
          fromProductionHold: true
        }
      ],
      parametersByStrategyId: new Map([
        ["squeeze-breakout-v1", {}],
        ["ema-pullback-v1", {}]
      ]),
      tickSize: 0.01
    });

    const a = comparison.trades.filter((t) => t.pass === "A");
    const c = comparison.trades.filter((t) => t.pass === "C");
    expect(a.length).toBe(1);
    expect(c.length).toBe(1);
    expect(a[0]!.entryCandleIndex).toBe(c[0]!.entryCandleIndex);
    // Both can be open/resolved without blocking each other
    expect(a[0]!.outcome === "UNSCORABLE" || a[0]!.entryPrice != null).toBe(true);
    expect(c[0]!.outcome === "UNSCORABLE" || c[0]!.entryPrice != null).toBe(true);
  });

  it("cumulative R and max drawdown math", () => {
    const mk = (
      outcome: ReplaySimulatedTrade["outcome"],
      realizedR: number | null
    ): ReplaySimulatedTrade => ({
      pass: "A",
      strategyId: "ema-pullback-v1",
      direction: "BUY",
      signalCandleIndex: 0,
      signalTimeMs: 0,
      entryCandleIndex: 1,
      entryTimeMs: 1,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      exitCandleIndex: 2,
      exitTimeMs: 2,
      exitPrice: 110,
      outcome,
      realizedR,
      barsHeld: 1,
      tradePlan: {
        action: "BUY",
        strategyId: "ema-pullback-v1",
        signalTimestampMs: 0,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        stopDistance: 5,
        targetDistance: 10,
        riskRewardRatio: 2,
        stopMethod: "test",
        targetMethod: "test",
        confidence: 1,
        scorable: true,
        unscorableReason: null,
        proposalReasons: []
      },
      fromProductionHold: false,
      regime: null,
      confidence: 1
    });

    const metrics = aggregatePassEconomicMetrics([
      mk("TARGET", 2),
      mk("STOP", -1),
      mk("TARGET", 2),
      mk("AMBIGUOUS", null),
      mk("STOP", -1)
    ]);
    // Cumulative R path: 2 → 1 → 3 → (skip amb) → 2; peak 3; dd = 3-2 = 1 after last stop? 
    // After T2: cum=2 peak=2 dd=0
    // After S-1: cum=1 peak=2 dd=1
    // After T2: cum=3 peak=3 dd=1
    // Ambiguous skipped
    // After S-1: cum=2 peak=3 dd=1
    expect(metrics.totalRealizedR).toBe(2);
    expect(metrics.targetHits).toBe(2);
    expect(metrics.stopHits).toBe(2);
    expect(metrics.ambiguous).toBe(1);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.maxDrawdownR).toBe(1);
    expect(metrics.longestLosingStreak).toBe(1);
  });

  it("fallback trade from production HOLD is attributed correctly", () => {
    const candles = [
      candleAt(0, 100, 101, 99, 100),
      candleAt(60_000, 100, 101, 99, 100),
      candleAt(120_000, 100, 101, 99, 100),
      candleAt(180_000, 100, 112, 99, 110)
    ];
    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals: [
        {
          pass: "C",
          signalCandleIndex: 1,
          evaluation: {
            strategyId: "squeeze-breakout-v1",
            action: "BUY",
            confidence: 0.8,
            signalTimestampMs: candles[1]!.closeTime,
            decisionMetadata: { squeezeLow: 95, squeezeHigh: 105 }
          },
          fromProductionHold: true
        }
      ],
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01
    });
    expect(comparison.passC.fromProductionHoldSignals).toBe(1);
    const t = comparison.trades[0]!;
    expect(t.fromProductionHold).toBe(true);
    if (t.outcome === "TARGET" || t.outcome === "STOP") {
      expect(comparison.passC.fromProductionHoldResolvedTrades).toBe(1);
      expect(comparison.passC.fromProductionHoldResolvedR).toBe(t.realizedR);
    }
  });

  it("no-lookahead still holds with economic fields present", () => {
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
      expect(after.bars[i]!.fallback.action).toBe(before.bars[i]!.fallback.action);
      expect(after.bars[i]!.production.evaluation?.action).toBe(
        before.bars[i]!.production.evaluation?.action
      );
    }
    // Signal-side decisions unchanged; economic may differ only for trades that need the future entry/exit candle
    expect(before.economic.entryConvention).toBe(after.economic.entryConvention);
  });
});

function diagTrade(input: {
  strategyId: string;
  direction: "BUY" | "SELL";
  regime: MarketRegime | null;
  outcome: ReplaySimulatedTrade["outcome"];
  realizedR?: number | null;
  fromProductionHold?: boolean;
  pass?: "A" | "C";
}): ReplaySimulatedTrade {
  const resolved = input.outcome === "TARGET" || input.outcome === "STOP";
  return {
    pass: input.pass ?? "C",
    strategyId: input.strategyId,
    direction: input.direction,
    signalCandleIndex: 0,
    signalTimeMs: 0,
    entryCandleIndex: 1,
    entryTimeMs: 1,
    entryPrice: 100,
    stopPrice: 95,
    targetPrice: 110,
    exitCandleIndex: 2,
    exitTimeMs: 2,
    exitPrice: resolved ? 110 : null,
    outcome: input.outcome,
    realizedR: resolved ? (input.realizedR ?? 0) : null,
    barsHeld: input.outcome === "UNSCORABLE" ? null : 3,
    tradePlan: {
      action: input.direction,
      strategyId: input.strategyId,
      signalTimestampMs: 0,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      stopDistance: 5,
      targetDistance: 10,
      riskRewardRatio: 2,
      stopMethod: "test",
      targetMethod: "test",
      confidence: 1,
      scorable: input.outcome !== "UNSCORABLE",
      unscorableReason: input.outcome === "UNSCORABLE" ? "TEST" : null,
      proposalReasons: []
    },
    fromProductionHold: input.fromProductionHold ?? true,
    regime: input.regime,
    confidence: 1
  };
}

function diagnosticFixture(): ReplaySimulatedTrade[] {
  const ema = "ema-pullback-v1";
  const sq = "squeeze-breakout-v1";
  return [
    diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "TARGET", realizedR: 2 }),
    diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "STOP", realizedR: -1 }),
    diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "AMBIGUOUS" }),
    diagTrade({ strategyId: ema, direction: "BUY", regime: "WEAK_UPTREND", outcome: "STOP", realizedR: -1 }),
    diagTrade({ strategyId: ema, direction: "BUY", regime: "WEAK_UPTREND", outcome: "OPEN_AT_END" }),
    diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "STOP", realizedR: -1 }),
    diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "STOP", realizedR: -1 }),
    diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "UNSCORABLE" }),
    diagTrade({ strategyId: sq, direction: "BUY", regime: "BREAKOUT_EXPANSION", outcome: "TARGET", realizedR: 2 }),
    diagTrade({ strategyId: sq, direction: "BUY", regime: "BREAKOUT_EXPANSION", outcome: "TARGET", realizedR: 2 }),
    // Excluded: Pass C but production was not HOLD
    diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "STOP", realizedR: -1, fromProductionHold: false }),
    // Excluded: Pass A
    diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "STOP", realizedR: -1, pass: "A" })
  ];
}

describe("Pass C fallback-from-HOLD diagnostics", () => {
  it("fallback-from-HOLD trade retains the signal-candle regime", () => {
    const candles = [
      candleAt(0, 100, 101, 99, 100),
      candleAt(60_000, 100, 101, 99, 100),
      candleAt(120_000, 100, 101, 99, 100),
      candleAt(180_000, 100, 112, 99, 110)
    ];
    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals: [
        {
          pass: "C",
          signalCandleIndex: 1,
          evaluation: {
            strategyId: "squeeze-breakout-v1",
            action: "BUY",
            confidence: 0.8,
            signalTimestampMs: candles[1]!.closeTime,
            decisionMetadata: { squeezeLow: 95, squeezeHigh: 105 }
          },
          fromProductionHold: true,
          regime: "VOLATILITY_COMPRESSION"
        }
      ],
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01
    });
    expect(comparison.trades[0]!.regime).toBe("VOLATILITY_COMPRESSION");
    expect(
      comparison.passCFallbackFromHold.byStrategyDirectionRegime["squeeze-breakout-v1"]?.BUY?.[
        "VOLATILITY_COMPRESSION"
      ]?.trades
    ).toBe(1);
  });

  it("full replay attributes each fallback-from-HOLD trade to its signal bar's regime", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[100]!.openTime,
      analysisEndMs: candles[140]!.openTime + 60_000,
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
          action: "BUY"
        })
      ])
    });
    const fromHold = report.economic.trades.filter((t) => t.pass === "C" && t.fromProductionHold);
    expect(fromHold.length).toBeGreaterThan(0);
    for (const t of fromHold) {
      const bar = report.bars.find((b) => b.candleIndex === t.signalCandleIndex);
      expect(bar).toBeDefined();
      expect(t.regime).toBe(bar!.regime);
    }
    expect(report.economic.passCFallbackFromHold.totals.trades).toBe(fromHold.length);
  });

  it("separates BUY and SELL and excludes non-HOLD / Pass A trades", () => {
    const d = buildFallbackFromHoldDiagnostics(diagnosticFixture());
    const ema = d.byStrategyDirection["ema-pullback-v1"]!;
    expect(ema.BUY!.trades).toBe(5);
    expect(ema.SELL!.trades).toBe(3);
    expect(ema.BUY!.totalR).toBe(0);
    expect(ema.SELL!.totalR).toBe(-2);
    expect(d.byStrategyDirection["squeeze-breakout-v1"]!.SELL).toBeUndefined();
    expect(d.totals.trades).toBe(10);
  });

  it("aggregates strategy / direction / regime math", () => {
    const d = buildFallbackFromHoldDiagnostics(diagnosticFixture());

    const ema = d.byStrategy["ema-pullback-v1"]!;
    expect(ema.trades).toBe(8);
    expect(ema.resolvedTrades).toBe(5);
    expect(ema.wins).toBe(1);
    expect(ema.losses).toBe(4);
    expect(ema.totalR).toBe(-2);
    expect(ema.avgR).toBeCloseTo(-0.4);
    expect(ema.winRate).toBeCloseTo(0.2);

    const sq = d.byStrategy["squeeze-breakout-v1"]!;
    expect(sq.totalR).toBe(4);
    expect(sq.winRate).toBe(1);

    const strongUp = d.byStrategyDirectionRegime["ema-pullback-v1"]!.BUY!["STRONG_UPTREND"]!;
    expect(strongUp).toMatchObject({
      trades: 3,
      resolvedTrades: 2,
      wins: 1,
      losses: 1,
      winRate: 0.5,
      totalR: 1,
      avgR: 0.5,
      ambiguous: 1,
      openAtEnd: 0,
      unscorable: 0,
      avgBarsHeld: 3
    });
    const weakUp = d.byStrategyDirectionRegime["ema-pullback-v1"]!.BUY!["WEAK_UPTREND"]!;
    expect(weakUp.openAtEnd).toBe(1);
    expect(weakUp.resolvedTrades).toBe(1);
  });

  it("counts resolved separately from ambiguous / open-at-end / unscorable", () => {
    const d = buildFallbackFromHoldDiagnostics(diagnosticFixture());
    expect(d.totals.resolvedTrades).toBe(7);
    expect(d.totals.ambiguous).toBe(1);
    expect(d.totals.openAtEnd).toBe(1);
    expect(d.totals.unscorable).toBe(1);
    expect(
      d.totals.resolvedTrades + d.totals.ambiguous + d.totals.openAtEnd + d.totals.unscorable
    ).toBe(d.totals.trades);
    // Unresolved outcomes contribute no R
    expect(d.totals.totalR).toBe(2);
    const sell = d.byStrategyDirectionRegime["ema-pullback-v1"]!.SELL!["STRONG_DOWNTREND"]!;
    expect(sell.unscorable).toBe(1);
    expect(sell.avgBarsHeld).toBe(3);
  });

  it("sorts worst groups by total R ascending and best groups descending", () => {
    const d = buildFallbackFromHoldDiagnostics(diagnosticFixture());
    expect(d.worstGroups.map((g) => `${g.strategyId}|${g.direction}|${g.regime}`)).toEqual([
      "ema-pullback-v1|SELL|STRONG_DOWNTREND",
      "ema-pullback-v1|BUY|STRONG_UPTREND",
      "squeeze-breakout-v1|BUY|BREAKOUT_EXPANSION"
    ]);
    expect(d.bestGroups.map((g) => `${g.strategyId}|${g.direction}|${g.regime}`)).toEqual([
      "squeeze-breakout-v1|BUY|BREAKOUT_EXPANSION",
      "ema-pullback-v1|BUY|STRONG_UPTREND",
      "ema-pullback-v1|SELL|STRONG_DOWNTREND"
    ]);
    expect(d.worstGroups[0]).toMatchObject({ resolvedTrades: 2, wins: 0, losses: 2, totalR: -2, avgR: -1 });
    expect(buildFallbackFromHoldDiagnostics(diagnosticFixture(), { rankingLimit: 1 }).worstGroups).toHaveLength(1);
  });

  it("applies the minimum-2-resolved-trade threshold to rankings", () => {
    const d = buildFallbackFromHoldDiagnostics(diagnosticFixture());
    expect(d.minResolvedForRanking).toBe(2);
    const keys = [...d.worstGroups, ...d.bestGroups].map((g) => g.regime);
    // WEAK_UPTREND has only 1 resolved trade → excluded from rankings but present in JSON breakdown
    expect(keys).not.toContain("WEAK_UPTREND");
    expect(d.byStrategyDirectionRegime["ema-pullback-v1"]!.BUY!["WEAK_UPTREND"]).toBeDefined();
    expect(d.worstGroups.every((g) => g.resolvedTrades >= 2)).toBe(true);

    const strict = buildFallbackFromHoldDiagnostics(diagnosticFixture(), { minResolvedForRanking: 3 });
    expect(strict.worstGroups).toHaveLength(0);
    expect(strict.bestGroups).toHaveLength(0);
  });

  it("keeps signal-bar regime attribution unchanged when a future candle is appended", () => {
    const candles = syntheticCandles({ count: 150, seed: 5, drift: 0.45, volatility: 2 });
    const mid = candles[120]!;
    const cfg = {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[110]!.openTime,
      analysisEndMs: mid.openTime + 60_000,
      selectionMode: "BOOTSTRAP" as const,
      executionBackend: "paper_cfd" as const,
      strategyAllowlist: [] as string[],
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
          action: "BUY"
        })
      ])
    };
    const before = runAutoSelectionCounterfactualReplay(candles.slice(0, 121), cfg);
    const future = {
      ...candles[121]!,
      openTime: mid.openTime + 60_000,
      closeTime: mid.closeTime + 60_000,
      close: mid.close + 50
    };
    const after = runAutoSelectionCounterfactualReplay([...candles.slice(0, 121), future], cfg);

    const regimeBySignal = (r: typeof before) =>
      new Map(
        r.economic.trades
          .filter((t) => t.pass === "C")
          .map((t) => [t.signalCandleIndex, t.regime] as const)
      );
    const b = regimeBySignal(before);
    const a = regimeBySignal(after);
    for (const [idx, regime] of b) {
      if (a.has(idx)) expect(a.get(idx)).toBe(regime);
    }
    for (let i = 0; i < before.bars.length; i++) {
      expect(after.bars[i]!.regime).toBe(before.bars[i]!.regime);
    }
  });

  it("renders the diagnostics section in markdown", () => {
    const md = formatFallbackFromHoldDiagnosticsMarkdown(
      buildFallbackFromHoldDiagnostics(diagnosticFixture())
    ).join("\n");
    expect(md).toContain("## Pass C fallback-from-HOLD diagnostics");
    expect(md).toContain("### By strategy");
    expect(md).toContain("### By strategy + direction");
    expect(md).toContain("### Worst groups");
    expect(md).toContain("### Best groups");
    expect(md).toContain("ema-pullback-v1 SELL STRONG_DOWNTREND");
    expect(md).not.toContain("WEAK_UPTREND: resolved");
  });
});

function signalFeatures(overrides: Partial<MarketFeatureSnapshot>): MarketFeatureSnapshot {
  return {
    symbol: "R_10",
    interval: "1m",
    timestamp: 0,
    close: 100,
    emaFast: null,
    emaSlow: null,
    emaLong: null,
    emaFastSlope: null,
    emaSlowSlope: null,
    rsi: null,
    atr: null,
    atrPercent: null,
    adx: null,
    macd: null,
    macdSignal: null,
    macdHistogram: null,
    bollingerUpper: null,
    bollingerMiddle: null,
    bollingerLower: null,
    bollingerWidth: null,
    priceDistanceFromEma: null,
    recentReturn: null,
    higherHighCount: 0,
    lowerLowCount: 0,
    donchianHigh: null,
    donchianLow: null,
    trendDirection: 1,
    volatilityPercentile: null,
    momentumScore: null,
    trendScore: null,
    rangeScore: null,
    breakoutScore: null,
    ...overrides
  };
}

describe("EMA fallback-from-HOLD diagnostics", () => {
  it("computes BUY MFE/MAE in price, R and ATR", () => {
    const x = computeExcursions({
      direction: "BUY",
      entryPrice: 100,
      stopDistance: 5,
      atr: 2,
      bars: [
        { high: 104, low: 98 },
        { high: 103, low: 97 }
      ]
    });
    expect(x).toEqual({ mfePrice: 4, maePrice: 3, mfeR: 0.8, maeR: 0.6, mfeAtr: 2, maeAtr: 1.5 });
  });

  it("computes SELL MFE/MAE mirrored", () => {
    const x = computeExcursions({
      direction: "SELL",
      entryPrice: 100,
      stopDistance: 5,
      atr: 2,
      bars: [
        { high: 102, low: 95 },
        { high: 103, low: 97 }
      ]
    });
    expect(x.mfePrice).toBe(5);
    expect(x.maePrice).toBe(3);
    expect(x.mfeR).toBe(1);
    expect(x.maeAtr).toBe(1.5);
  });

  it("uses only entry→exit candles for MFE/MAE", () => {
    const candles = [
      candleAt(0, 100, 100, 100, 100),
      candleAt(60_000, 100, 500, 1, 100), // signal candle spike — must be ignored
      candleAt(120_000, 100, 104, 98, 101), // entry
      candleAt(180_000, 101, 103, 95, 96), // exit (stop)
      candleAt(240_000, 96, 900, 1, 100) // after exit — must be ignored
    ];
    const trade = diagTrade({
      strategyId: "ema-pullback-v1",
      direction: "BUY",
      regime: "STRONG_UPTREND",
      outcome: "STOP",
      realizedR: -1
    });
    trade.signalCandleIndex = 1;
    trade.entryCandleIndex = 2;
    trade.exitCandleIndex = 3;
    const d = buildEmaTradeDiagnostic({
      trade,
      candles,
      context: { features: signalFeatures({ atr: 2 }), decisionMetadata: {}, regimeConfidence: 0.7 }
    });
    expect(d.mfePrice).toBe(4);
    expect(d.maePrice).toBe(5);
    expect(d.mfeR).toBeCloseTo(0.8);
    expect(d.maeR).toBeCloseTo(1);
    expect(d.regimeConfidence).toBe(0.7);
  });

  it("reports favorable-before-stop thresholds from bars before the stop bar", () => {
    const fav = computeFavorableBeforeStop({
      direction: "BUY",
      entryPrice: 100,
      stopDistance: 5,
      bars: [
        { high: 101.5, low: 99 },
        { high: 103, low: 99 },
        { high: 106, low: 94 } // stop bar: its 1.2R high is intrabar-ambiguous and excluded
      ]
    });
    expect(fav.maxFavorableRBeforeStop).toBeCloseTo(0.6);
    expect(fav).toMatchObject({ reached025R: true, reached05R: true, reached10R: false });

    const exact = computeFavorableBeforeStop({
      direction: "SELL",
      entryPrice: 100,
      stopDistance: 4,
      bars: [{ high: 100.5, low: 99 }, { high: 105, low: 99.5 }]
    });
    expect(exact.maxFavorableRBeforeStop).toBe(0.25);
    expect(exact.reached025R).toBe(true);
    expect(exact.reached05R).toBe(false);

    const immediate = computeFavorableBeforeStop({
      direction: "BUY",
      entryPrice: 100,
      stopDistance: 5,
      bars: [{ high: 110, low: 90 }]
    });
    expect(immediate.maxFavorableRBeforeStop).toBe(0);
    expect(immediate.reached025R).toBe(false);
  });

  it("normalizes geometry and EMA distances by signal-candle ATR", () => {
    const candles = [
      candleAt(0, 100, 100, 100, 100),
      candleAt(60_000, 100, 100, 100, 100),
      candleAt(120_000, 100, 101, 99, 100),
      candleAt(180_000, 100, 110, 99, 110)
    ];
    const trade = diagTrade({
      strategyId: "ema-pullback-v1",
      direction: "BUY",
      regime: "STRONG_UPTREND",
      outcome: "TARGET",
      realizedR: 2
    });
    trade.signalCandleIndex = 1;
    trade.entryCandleIndex = 2;
    trade.exitCandleIndex = 3;
    const d = buildEmaTradeDiagnostic({
      trade,
      candles,
      context: {
        features: signalFeatures({
          atr: 2,
          emaFast: 98,
          emaSlow: 96,
          emaLong: 90,
          emaFastSlope: 0.001,
          emaSlowSlope: 0.0005,
          adx: 25,
          rsi: 52,
          donchianHigh: 105,
          donchianLow: 90
        }),
        decisionMetadata: { pullbackLow: 97, pullbackHigh: 101 },
        regimeConfidence: 0.8
      }
    });
    expect(d.stopDistanceAtr).toBe(2.5);
    expect(d.targetDistanceAtr).toBe(5);
    expect(d.riskRewardRatio).toBe(2);
    expect(d.entryMinusEmaFastAtr).toBe(1);
    expect(d.entryMinusEmaSlowAtr).toBe(2);
    expect(d.entryMinusEmaLongAtr).toBe(5);
    expect(d.extensionFromFastAtr).toBe(1);
    expect(d.extensionFromSlowAtr).toBe(2);
    expect(d.expectedSideOfEmaFast).toBe(true);
    expect(d.pullbackDepthFastAtr).toBe(0.5);
    expect(d.distanceFromPullbackExtremeAtr).toBe(1.5);
    expect(d.distanceToDonchianHighAtr).toBe(2.5);
    expect(d.distanceToDonchianLowAtr).toBe(5);
    expect(d.emaFastSlope).toBe(0.001);
    expect(d.adx).toBe(25);
    expect(d.extensionBucket).toBe("0.5-1.0");
    expect(d.stopDistanceBucket).toBe(">2.0");

    const sell = diagTrade({
      strategyId: "ema-pullback-v1",
      direction: "SELL",
      regime: "STRONG_DOWNTREND",
      outcome: "STOP",
      realizedR: -1
    });
    sell.stopPrice = 104;
    sell.targetPrice = 92;
    const s = buildEmaTradeDiagnostic({
      trade: sell,
      candles,
      context: {
        features: signalFeatures({ atr: 2, emaFast: 101, emaSlow: 99 }),
        decisionMetadata: { pullbackHigh: 102 },
        regimeConfidence: null
      }
    });
    expect(s.extensionFromFastAtr).toBe(0.5);
    expect(s.expectedSideOfEmaFast).toBe(true);
    expect(s.expectedSideOfEmaSlow).toBe(false);
    expect(s.extensionFromSlowAtr).toBe(-0.5);
    expect(s.pullbackDepthFastAtr).toBe(0.5);
    expect(s.stopDistanceAtr).toBe(2);
  });

  it("buckets extension at the documented boundaries", () => {
    expect(extensionBucket(-0.3)).toBe("<=0.25");
    expect(extensionBucket(0.25)).toBe("<=0.25");
    expect(extensionBucket(0.2501)).toBe("0.25-0.5");
    expect(extensionBucket(0.5)).toBe("0.25-0.5");
    expect(extensionBucket(1.0)).toBe("0.5-1.0");
    expect(extensionBucket(1.5)).toBe("1.0-1.5");
    expect(extensionBucket(1.5001)).toBe(">1.5");
    expect(extensionBucket(null)).toBe("UNKNOWN");
    expect(extensionBucket(Number.NaN)).toBe("UNKNOWN");
  });

  it("buckets stop distance at the documented boundaries", () => {
    expect(stopDistanceBucket(0.5)).toBe("<=0.5");
    expect(stopDistanceBucket(0.5001)).toBe("0.5-1.0");
    expect(stopDistanceBucket(1.0)).toBe("0.5-1.0");
    expect(stopDistanceBucket(1.5)).toBe("1.0-1.5");
    expect(stopDistanceBucket(2.0)).toBe("1.5-2.0");
    expect(stopDistanceBucket(2.0001)).toBe(">2.0");
    expect(stopDistanceBucket(null)).toBe("UNKNOWN");
  });

  it("stores null / UNKNOWN when signal features are missing", () => {
    const candles = [
      candleAt(0, 100, 100, 100, 100),
      candleAt(60_000, 100, 102, 99, 101),
      candleAt(120_000, 101, 103, 94, 95)
    ];
    const trade = diagTrade({
      strategyId: "ema-pullback-v1",
      direction: "BUY",
      regime: null,
      outcome: "STOP",
      realizedR: -1
    });
    for (const features of [null, signalFeatures({ atr: 0, emaFast: 99 })]) {
      const d = buildEmaTradeDiagnostic({
        trade,
        candles,
        context: { features, decisionMetadata: {}, regimeConfidence: null }
      });
      expect(d.atr).toBeNull();
      expect(d.stopDistanceAtr).toBeNull();
      expect(d.extensionFromFastAtr).toBeNull();
      expect(d.pullbackDepthFastAtr).toBeNull();
      expect(d.mfeAtr).toBeNull();
      expect(d.extensionBucket).toBe("UNKNOWN");
      expect(d.stopDistanceBucket).toBe("UNKNOWN");
      // R-based excursions still work without ATR
      expect(d.mfeR).not.toBeNull();
    }
    const noFeatures = buildEmaTradeDiagnostic({
      trade,
      candles,
      context: { features: null, decisionMetadata: {}, regimeConfidence: null }
    });
    expect(noFeatures.emaFast).toBeNull();
    expect(noFeatures.expectedSideOfEmaFast).toBeNull();
    expect(noFeatures.adx).toBeNull();

    const unscorable = buildEmaTradeDiagnostic({
      trade: { ...trade, outcome: "UNSCORABLE", entryPrice: null, stopPrice: null, targetPrice: null },
      candles,
      context: { features: null, decisionMetadata: {}, regimeConfidence: null }
    });
    expect(unscorable.mfeR).toBeNull();
    expect(unscorable.favorableBeforeStop).toBeNull();
  });

  it("aggregates by direction, regime and direction+regime, scoped to EMA fallback-from-HOLD", () => {
    const candles = [
      candleAt(0, 100, 100, 100, 100),
      candleAt(60_000, 100, 102, 99, 101),
      candleAt(120_000, 101, 103, 94, 95)
    ];
    const ema = "ema-pullback-v1";
    const d = buildEmaFallbackFromHoldDiagnostics({
      candles,
      contextBySignal: new Map(),
      trades: [
        diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "TARGET", realizedR: 2 }),
        diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "STOP", realizedR: -1 }),
        diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "STOP", realizedR: -1 }),
        diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "AMBIGUOUS" }),
        diagTrade({ strategyId: "squeeze-breakout-v1", direction: "BUY", regime: "BREAKOUT_EXPANSION", outcome: "STOP", realizedR: -1 }),
        diagTrade({ strategyId: ema, direction: "BUY", regime: "STRONG_UPTREND", outcome: "STOP", realizedR: -1, fromProductionHold: false }),
        diagTrade({ strategyId: ema, direction: "SELL", regime: "STRONG_DOWNTREND", outcome: "STOP", realizedR: -1, pass: "A" })
      ]
    });

    expect(d.trades).toHaveLength(4);
    expect(d.overall).toMatchObject({
      trades: 4,
      resolvedTrades: 3,
      wins: 1,
      losses: 2,
      totalR: 0,
      stoppedTrades: 2,
      stoppedReached025RPct: 0.5,
      stoppedReached05RPct: 0,
      stoppedReached10RPct: 0
    });
    expect(d.overall.avgMfeR).toBeCloseTo(0.9);
    expect(d.overall.medianMfeR).toBeCloseTo(0.9);
    expect(d.byDirection.BUY).toMatchObject({ trades: 2, totalR: 1, wins: 1, losses: 1 });
    expect(d.byDirection.SELL).toMatchObject({ trades: 2, totalR: -1, stoppedReached025RPct: 0 });
    expect(d.byRegime["STRONG_UPTREND"]!.trades).toBe(2);
    expect(d.byRegime["BREAKOUT_EXPANSION"]).toBeUndefined();
    expect(d.byDirectionRegime.SELL!["STRONG_DOWNTREND"]).toMatchObject({ trades: 2, resolvedTrades: 1 });
    expect(d.byDirectionRegime.BUY!["STRONG_DOWNTREND"]).toBeUndefined();
    expect(d.byExtensionBucket.UNKNOWN!.trades).toBe(4);
    expect(d.byStopDistanceBucket.UNKNOWN!.trades).toBe(4);
  });

  it("is populated by the full replay using signal-time features only (no lookahead)", () => {
    const candles = syntheticCandles({ count: 160, seed: 11, drift: 0.5, volatility: 2 });
    const mid = candles[130]!;
    const cfg = {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[100]!.openTime,
      analysisEndMs: mid.openTime + 60_000,
      selectionMode: "BOOTSTRAP" as const,
      executionBackend: "paper_cfd" as const,
      strategyAllowlist: [] as string[],
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
          action: "BUY"
        })
      ])
    };
    const before = runAutoSelectionCounterfactualReplay(candles.slice(0, 131), cfg);
    const scoped = before.economic.trades.filter(
      (t) => t.pass === "C" && t.fromProductionHold && t.strategyId === "ema-pullback-v1"
    );
    expect(scoped.length).toBeGreaterThan(0);
    const diag = before.economic.emaFallbackFromHold;
    expect(diag.trades).toHaveLength(scoped.length);
    for (const rec of diag.trades) {
      const expected = extractFeatures(candles.slice(0, rec.signalCandleIndex + 1), DEFAULT_FEATURE_CONFIG).at(-1)!;
      expect(rec.emaFast).toBe(expected.emaFast);
      expect(rec.atr).toBe(expected.atr);
      const bar = before.bars.find((b) => b.candleIndex === rec.signalCandleIndex)!;
      expect(rec.regime).toBe(bar.regime);
      expect(rec.regimeConfidence).toBe(bar.regimeConfidence);
    }

    const future = {
      ...candles[131]!,
      openTime: mid.openTime + 60_000,
      closeTime: mid.closeTime + 60_000,
      close: mid.close + 500,
      high: mid.close + 500
    };
    const after = runAutoSelectionCounterfactualReplay([...candles.slice(0, 131), future], cfg);
    const afterBySignal = new Map(
      after.economic.emaFallbackFromHold.trades.map((r) => [r.signalCandleIndex, r] as const)
    );
    for (const rec of diag.trades) {
      const other = afterBySignal.get(rec.signalCandleIndex);
      if (!other) continue;
      expect(other.emaFast).toBe(rec.emaFast);
      expect(other.emaSlow).toBe(rec.emaSlow);
      expect(other.atr).toBe(rec.atr);
      expect(other.extensionFromFastAtr).toBe(rec.extensionFromFastAtr);
      expect(other.regime).toBe(rec.regime);
    }

    const md = formatEmaFallbackFromHoldMarkdown(diag).join("\n");
    expect(md).toContain("## EMA fallback-from-HOLD diagnostics");
    expect(md).toContain("### BUY vs SELL");
    expect(md).toContain("### By regime");
    expect(md).toContain("### By direction + regime");
    expect(md).toContain("### Extension from fast EMA");
    expect(md).toContain("### Stop distance (ATR)");
    expect(md).toContain("### Favorable-before-stop");
    expect(formatAutoSelectionReplayMarkdown(before)).toContain("## EMA fallback-from-HOLD diagnostics");
  });
});
