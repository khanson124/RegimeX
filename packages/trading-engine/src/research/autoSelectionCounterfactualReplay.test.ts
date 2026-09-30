import { execFileSync } from "node:child_process";
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
  analyzeCandleContinuity,
  describeExitGap,
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
  EMA_GEOMETRY_UNAVAILABLE,
  PASS_C_VARIANTS,
  PASS_C_VARIANT_IDS,
  gateGeometry,
  runPassCResearchVariants,
  buildPassCVariantWeeklyReport,
  buildReplayEconomicSignals,
  buildWeeklyEconomicBreakdown,
  type PassCVariantDefinition,
  type PassCVariantResult,
  type ReplaySimulatedTrade,
  type ReplayStrategyDefinition
} from "./autoSelectionCounterfactualReplay.js";
import { utcWeekStartMs } from "./xauUsdWeeklyRobustness.js";
import {
  FORWARD_VARIANTS,
  FORWARD_VARIANT_IDS,
  R10_FORWARD_START_ISO,
  formatR10ForwardValidationMarkdown,
  runR10AutoForwardValidation,
  type ForwardVariantSummary
} from "./autoSelectionForwardValidation.js";
import {
  buildReplayTradePlan,
  type ReplayEconomicSignal,
  type ReplayEntryGate,
  type ReplayEntryGateContext
} from "./autoSelectionReplayOutcomes.js";

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

function flatCandles(count: number, price = 100, source: Candle["source"] = "SEED"): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    ...candleAt(i * 60_000, price, price + 0.5, price - 0.5, price),
    source
  }));
}

function squeezeSignal(
  index: number,
  candles: Candle[],
  action: "BUY" | "SELL",
  metadata: Record<string, unknown>,
  pass: "A" | "C" = "C"
) {
  return {
    pass,
    signalCandleIndex: index,
    evaluation: {
      strategyId: "squeeze-breakout-v1",
      action,
      confidence: 0.8,
      signalTimestampMs: candles[index]!.closeTime,
      decisionMetadata: metadata
    },
    fromProductionHold: true
  };
}

describe("economic simulator diagnostics", () => {
  it("one never-resolving position blocks thousands of later signals and is reported", () => {
    const n = 3000;
    const candles = flatCandles(n);
    // squeezeLow far below price → stop ≈ 50, target ≈ 200; flat bars never reach either.
    const wide = { squeezeLow: 50, squeezeHigh: 101 };
    const signals = [squeezeSignal(1, candles, "BUY", wide), squeezeSignal(1, candles, "SELL", wide)];
    for (let i = 2; i < n - 1; i++) signals.push(squeezeSignal(i, candles, i % 2 ? "SELL" : "BUY", wide));

    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals,
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01,
      featureLookback: 50
    });
    const d = comparison.simulationDiagnostics.C;

    expect(d.executableSignalsSeen).toBe(signals.length);
    expect(d.signalsAcceptedAsPending).toBe(1);
    expect(d.signalsSkippedPendingAlreadyExists).toBe(1);
    expect(d.signalsSkippedOpenPosition).toBe(n - 3);
    expect(d.executableSignalsSeen).toBe(
      d.signalsAcceptedAsPending + d.signalsSkippedPendingAlreadyExists + d.signalsSkippedOpenPosition
    );
    expect(d.entriesOpened).toBe(1);
    expect(d.tradesResolved).toBe(0);
    expect(d.tradesOpenAtEnd).toBe(1);
    expect(d.unscorableEntries).toBe(0);

    expect(d.maxBarsHeld).toBe(n - 2);
    expect(d.longHeldCounts).toEqual({ ">100": 1, ">500": 1, ">1000": 1, ">5000": 0 });
    expect(d.longestTrade?.outcome).toBe("OPEN_AT_END");
    expect(d.longestTrade?.stopPrice).toBeLessThan(51);
    expect(d.longestTrade?.targetPrice).toBeGreaterThan(199);

    expect(d.blockingPositions).toHaveLength(1);
    const b = d.blockingPositions[0]!;
    expect(b.skippedSignals).toBe(n - 3);
    expect(b.openDirection).toBe("BUY");
    expect(b.openEntryCandleIndex).toBe(2);
    expect(b.openEntryPrice).toBe(100);
    expect(b.maxBarsHeldWhenSkipping).toBe(n - 3);

    const first = d.skippedWhileOpen[0]!;
    expect(first).toMatchObject({
      skippedSignalCandleIndex: 2,
      skippedSignalTimeMs: candles[2]!.closeTime,
      openStrategyId: "squeeze-breakout-v1",
      openDirection: "BUY",
      openEntryTimeMs: candles[2]!.openTime,
      openEntryPrice: 100,
      barsHeldSoFar: 1
    });
    expect(first.openStopPrice).toBe(b.openStopPrice);
    expect(first.openTargetPrice).toBe(b.openTargetPrice);
    expect(d.skippedWhileOpen).toHaveLength(n - 3);
    expect(d.skippedWhileOpenTruncated).toBe(false);

    // Pass A untouched.
    expect(comparison.simulationDiagnostics.A.executableSignalsSeen).toBe(0);
  });

  it("gap through BUY stop: fill stays at stop level, gap is flagged with R-at-open", () => {
    const candles = [...flatCandles(3), candleAt(180_000, 80, 81, 79, 80)];
    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals: [squeezeSignal(1, candles, "BUY", { squeezeLow: 95, squeezeHigh: 101 })],
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01
    });
    const t = comparison.trades[0]!;
    expect(t.outcome).toBe("STOP");
    expect(t.exitPrice).toBe(t.stopPrice);
    expect(t.realizedR).toBe(-1);
    expect(t.exitGap?.gapThroughStop).toBe(true);
    expect(t.exitGap?.barEntirelyBeyondStop).toBe(true);
    expect(t.exitGap?.rIfFilledAtOpen).toBeCloseTo((80 - 100) / (100 - t.stopPrice!), 6);
    const g = comparison.simulationDiagnostics.C.exitGaps;
    expect(g.stopExits).toBe(1);
    expect(g.stopExitsGappedThrough).toBe(1);
    expect(g.worstStopRIfFilledAtOpen).toBeLessThan(-3.9);
  });

  it("gap through SELL stop: fill stays at stop level, gap is flagged", () => {
    const candles = [...flatCandles(3), candleAt(180_000, 120, 121, 119, 120)];
    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals: [squeezeSignal(1, candles, "SELL", { squeezeLow: 99, squeezeHigh: 105 })],
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01
    });
    const t = comparison.trades[0]!;
    expect(t.outcome).toBe("STOP");
    expect(t.exitPrice).toBe(t.stopPrice);
    expect(t.exitGap?.gapThroughStop).toBe(true);
    expect(t.exitGap?.rIfFilledAtOpen).toBeCloseTo((100 - 120) / (t.stopPrice! - 100), 6);
    expect(comparison.simulationDiagnostics.C.exitGaps.stopExitsGappedThrough).toBe(1);
  });

  it("gap through BUY target: fill stays at target level, gap is flagged", () => {
    const candles = [...flatCandles(3), candleAt(180_000, 130, 131, 129, 130)];
    const comparison = simulatePassEconomicOutcomes({
      candles,
      signals: [squeezeSignal(1, candles, "BUY", { squeezeLow: 95, squeezeHigh: 101 })],
      parametersByStrategyId: new Map([["squeeze-breakout-v1", {}]]),
      tickSize: 0.01
    });
    const t = comparison.trades[0]!;
    expect(t.outcome).toBe("TARGET");
    expect(t.exitPrice).toBe(t.targetPrice);
    expect(t.realizedR).toBeCloseTo(2, 9);
    expect(t.exitGap?.gapThroughTarget).toBe(true);
    expect(t.exitGap?.gapThroughStop).toBe(false);
    expect(t.exitGap?.rIfFilledAtOpen).toBeGreaterThan(2);
    const g = comparison.simulationDiagnostics.C.exitGaps;
    expect(g.targetExits).toBe(1);
    expect(g.targetExitsGappedThrough).toBe(1);
  });

  it("describeExitGap: non-gapped stop touch is not flagged", () => {
    const g = describeExitGap({
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      exitBar: { open: 99, high: 100, low: 94 }
    });
    expect(g.gapThroughStop).toBe(false);
    expect(g.barEntirelyBeyondStop).toBe(false);
    expect(g.rIfFilledAtOpen).toBeCloseTo(-0.2, 6);
  });

  it("detects abnormal cross-source price jumps (e.g. ~9450 → ~4790 → ~9450)", () => {
    const candles = [
      ...flatCandles(3, 9452.56, "HISTORY_API"),
      { ...candleAt(180_000, 4789, 4790, 4788, 4789.68), source: "LIVE_TICKS" as const },
      { ...candleAt(240_000, 9450, 9451, 9449, 9450.04), source: "HISTORY_API" as const },
      { ...candleAt(300_000, 9450, 9451, 9449, 9460), source: "HISTORY_API" as const }
    ];
    const c = analyzeCandleContinuity(candles);
    expect(c.sources).toEqual({ HISTORY_API: 5, LIVE_TICKS: 1 });
    expect(c.jumpCounts).toEqual({ ">10%": 2, ">25%": 2, ">40%": 2, ">50%": 1 });
    expect(c.crossSourceJumps).toBe(2);
    expect(c.jumps).toHaveLength(2);
    expect(c.jumps[0]).toMatchObject({
      index: 3,
      beforeClose: 9452.56,
      afterClose: 4789.68,
      beforeSource: "HISTORY_API",
      afterSource: "LIVE_TICKS",
      crossSource: true
    });
    expect(c.jumps[0]!.returnPct).toBeCloseTo(-49.33, 1);
    expect(c.jumps[1]!.returnPct).toBeGreaterThan(97);
    expect(c.maxAbsReturnPct).toBeGreaterThan(97);
  });

  it("report exposes simulator + continuity diagnostics and preserves no-lookahead", () => {
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
        mockStrategy({ id: "ema-pullback-v1", kind: "ema-pullback", supportedRegimes: ALL_REGIMES, action: "BUY" })
      ])
    };
    const before = runAutoSelectionCounterfactualReplay(candles.slice(0, 121), cfg);
    const future = { ...candles[121]!, openTime: mid.openTime + 60_000, closeTime: mid.closeTime + 60_000, close: mid.close * 3 };
    const after = runAutoSelectionCounterfactualReplay([...candles.slice(0, 121), future], cfg);

    const sim = before.economic.simulationDiagnostics.C;
    expect(sim.executableSignalsSeen).toBe(
      sim.signalsAcceptedAsPending + sim.signalsSkippedPendingAlreadyExists + sim.signalsSkippedOpenPosition
    );
    expect(sim.signalsAcceptedAsPending).toBe(sim.entriesOpened + sim.unscorableEntries);
    expect(before.candleContinuity.candles).toBe(before.coverage.completeCandles);

    // A future candle cannot change which signals the simulator saw on earlier bars.
    expect(after.economic.simulationDiagnostics.C.executableSignalsSeen).toBe(sim.executableSignalsSeen);
    expect(after.economic.simulationDiagnostics.A.executableSignalsSeen).toBe(
      before.economic.simulationDiagnostics.A.executableSignalsSeen
    );
    expect(after.candleContinuity.jumpCounts[">10%"]).toBeGreaterThan(0);
    expect(after.limitations.some((l) => l.startsWith("DATA QUALITY"))).toBe(true);

    const md = formatAutoSelectionReplayMarkdown(before);
    expect(md).toContain("## Economic simulator diagnostics (single position per pass)");
    expect(md).toContain("## Candle continuity (close-to-close)");
    expect(md).toContain("Gap handling: STOP/TARGET exits are filled at the stop/target level");
  });
});

const EMA_ID = "ema-pullback-v1";
const SQ_ID = "squeeze-breakout-v1";
const variantById = (id: string) => PASS_C_VARIANTS.find((v) => v.id === id)!;
const C0 = variantById("C0_BASELINE");
const C1 = variantById("C1_EMA_MAX_EXTENSION_0_5");
const C2 = variantById("C2_EMA_EXTENSION_0_25_TO_0_5");
const C3 = variantById("C3_EMA_MAX_EXTENSION_0_5_AND_STOP_0_5_TO_1_0");

function gateCtx(input: {
  direction?: "BUY" | "SELL";
  entryPrice: number;
  stopLoss?: number | null;
  atr?: number | null;
  emaFast?: number | null;
  strategyId?: string;
  fromProductionHold?: boolean;
  pass?: "A" | "C";
}): ReplayEntryGateContext {
  const direction = input.direction ?? "BUY";
  const stopLoss = input.stopLoss === undefined ? input.entryPrice - 1 : input.stopLoss;
  return {
    pass: input.pass ?? "C",
    strategyId: input.strategyId ?? EMA_ID,
    direction,
    fromProductionHold: input.fromProductionHold ?? true,
    signalCandleIndex: 10,
    entryCandleIndex: 11,
    entryPrice: input.entryPrice,
    plan: {
      action: direction,
      strategyId: input.strategyId ?? EMA_ID,
      signalTimestampMs: 0,
      entryPrice: input.entryPrice,
      stopLoss,
      takeProfit: null,
      stopDistance: stopLoss == null ? null : Math.abs(input.entryPrice - stopLoss),
      targetDistance: null,
      riskRewardRatio: 2,
      stopMethod: "test",
      targetMethod: "test",
      confidence: 1,
      scorable: true,
      unscorableReason: null,
      proposalReasons: []
    },
    signalFeatures: {
      atr: input.atr === undefined ? 1 : input.atr,
      emaFast: input.emaFast === undefined ? 100 : input.emaFast
    } as MarketFeatureSnapshot
  };
}

function emaSignal(
  index: number,
  candles: Candle[],
  opts: { fromProductionHold?: boolean; strategyId?: string; action?: "BUY" | "SELL"; pass?: "A" | "C" } = {}
): ReplayEconomicSignal {
  return {
    pass: opts.pass ?? "C",
    signalCandleIndex: index,
    evaluation: {
      strategyId: opts.strategyId ?? EMA_ID,
      action: opts.action ?? "BUY",
      confidence: 0.8,
      signalTimestampMs: candles[index]!.closeTime,
      // Far structure stops → trades stay open on the flat tail unless a gate drops them.
      decisionMetadata: { pullbackLow: 90, pullbackHigh: 110, squeezeLow: 90, squeezeHigh: 110 }
    },
    fromProductionHold: opts.fromProductionHold ?? true
  };
}

/** 300 flat warm-up bars at 100 (ATR≈1, fast EMA≈100), with an entry bar gapping to `entryOpen`. */
function gapEntrySeries(entryIndex: number, entryOpen: number, count = 320): Candle[] {
  const candles = flatCandles(count);
  candles[entryIndex] = candleAt(entryIndex * 60_000, entryOpen, entryOpen + 0.2, entryOpen - 0.2, entryOpen);
  return candles;
}

const runVariants = (
  candles: Candle[],
  signals: ReplayEconomicSignal[],
  variants = PASS_C_VARIANTS
) =>
  runPassCResearchVariants({
    candles,
    signals,
    parametersByStrategyId: new Map([
      [EMA_ID, {}],
      [SQ_ID, {}]
    ]),
    tickSize: 0.01,
    variants
  });

describe("Pass C research variants (EMA fallback entry gates)", () => {
  it("extension boundaries: 0.25 and 0.5 ATR (direction-signed)", () => {
    const decide = (gate: ReplayEntryGate, entryPrice: number, direction: "BUY" | "SELL" = "BUY") =>
      gate(gateCtx({ entryPrice, direction, stopLoss: direction === "BUY" ? entryPrice - 0.75 : entryPrice + 0.75 }));

    // C1: reject only when extension > 0.5.
    expect(decide(C1.gate!, 100.5).reject).toBe(false);
    expect(decide(C1.gate!, 100.5001).reason).toBe("EMA_EXTENSION_GT_0_5");
    expect(decide(C1.gate!, 99.5, "SELL").reject).toBe(false);
    expect(decide(C1.gate!, 99.4999, "SELL").reason).toBe("EMA_EXTENSION_GT_0_5");
    // Negative extension (entry on the wrong side of the fast EMA) is not > 0.5.
    expect(decide(C1.gate!, 99, "BUY").reject).toBe(false);

    // C2: allow only 0.25 < extension <= 0.5.
    expect(decide(C2.gate!, 100.25).reason).toBe("EMA_EXTENSION_LE_0_25");
    expect(decide(C2.gate!, 100.2501).reject).toBe(false);
    expect(decide(C2.gate!, 100.5).reject).toBe(false);
    expect(decide(C2.gate!, 100.5001).reason).toBe("EMA_EXTENSION_GT_0_5");
    expect(decide(C2.gate!, 99.75, "SELL").reason).toBe("EMA_EXTENSION_LE_0_25");
    expect(decide(C2.gate!, 99.6, "SELL").reject).toBe(false);

    // Gate geometry equals the EMA diagnostic definition.
    const g = gateGeometry(gateCtx({ entryPrice: 100.4, atr: 2, emaFast: 100, stopLoss: 99.4 }));
    expect(g.extensionFromFastAtr).toBeCloseTo(0.2, 12);
    expect(g.stopDistanceAtr).toBeCloseTo(0.5, 12);
    expect(extensionBucket(g.extensionFromFastAtr)).toBe("<=0.25");
  });

  it("stop-distance boundaries are inclusive at 0.5 and 1.0 ATR (C3)", () => {
    const decide = (stopLoss: number, entryPrice = 100) =>
      C3.gate!(gateCtx({ entryPrice, stopLoss, atr: 2, emaFast: 100 }));
    expect(decide(99).reject).toBe(false); // exactly 0.5 ATR
    expect(decide(98).reject).toBe(false); // exactly 1.0 ATR
    expect(decide(99.01).reason).toBe("EMA_STOP_LT_0_5_ATR");
    expect(decide(97.99).reason).toBe("EMA_STOP_GT_1_0_ATR");
    // Extension rule still applies: entry 101.01 vs EMA 100, ATR 2 → 0.505 ATR.
    expect(decide(99.51, 101.01).reason).toBe("EMA_EXTENSION_GT_0_5");
    expect(decide(100, 101).reject).toBe(false); // ext 0.5, stop 0.5
  });

  it("gates only touch Pass C EMA fallback-from-HOLD; missing geometry is rejected in scope", () => {
    const huge = { entryPrice: 110 }; // extension 10 ATR
    for (const v of [C1, C2, C3]) {
      expect(v.gate!(gateCtx({ ...huge })).reject).toBe(true);
      expect(v.gate!(gateCtx({ ...huge, fromProductionHold: false })).reject).toBe(false);
      expect(v.gate!(gateCtx({ ...huge, strategyId: SQ_ID })).reject).toBe(false);
      expect(v.gate!(gateCtx({ ...huge, pass: "A" })).reject).toBe(false);
      expect(v.gate!(gateCtx({ entryPrice: 100.3, atr: null })).reason).toBe(EMA_GEOMETRY_UNAVAILABLE);
    }
    expect(C0.gate).toBeNull();
  });

  it("rejecting an early trade allows a later signal to execute", () => {
    // EMA entry gaps to 101 (≈1 ATR above fast EMA) and never resolves; squeeze signal comes later.
    const candles = gapEntrySeries(251, 101);
    const signals = [emaSignal(250, candles), emaSignal(270, candles, { strategyId: SQ_ID })];
    const report = runVariants(candles, signals, [C0, C1]);
    const [c0, c1] = report.variants as [PassCVariantResult, PassCVariantResult];

    expect(c0.entriesOpened).toBe(1);
    expect(c0.signalsSkippedOpenPosition).toBe(1);
    expect(c0.trades.map((t) => t.strategyId)).toEqual([EMA_ID]);

    expect(c1.signalsRejectedByResearchGate).toBe(1);
    expect(c1.rejectionsByReason).toEqual({ EMA_EXTENSION_GT_0_5: 1 });
    expect(c1.rejections[0]).toMatchObject({ signalCandleIndex: 250, entryCandleIndex: 251, strategyId: EMA_ID });
    expect(c1.entriesOpened).toBe(1);
    expect(c1.signalsSkippedOpenPosition).toBe(0);
    expect(c1.trades.map((t) => [t.strategyId, t.entryCandleIndex])).toEqual([[SQ_ID, 271]]);
  });

  it("a signal on the rejected entry bar can become the next pending entry", () => {
    const candles = gapEntrySeries(251, 101);
    const signals = [emaSignal(250, candles), emaSignal(251, candles, { strategyId: SQ_ID })];
    const [c0, c1] = runVariants(candles, signals, [C0, C1]).variants as [PassCVariantResult, PassCVariantResult];
    expect(c0.trades.map((t) => t.strategyId)).toEqual([EMA_ID]);
    expect(c1.trades.map((t) => [t.strategyId, t.entryCandleIndex])).toEqual([[SQ_ID, 252]]);
  });

  it("variants have independent position state and ignore Pass A signals", () => {
    const candles = gapEntrySeries(251, 101);
    const signals = [
      emaSignal(250, candles),
      emaSignal(270, candles, { strategyId: SQ_ID }),
      emaSignal(240, candles, { pass: "A", strategyId: SQ_ID })
    ];
    const both = runVariants(candles, signals, [C0, C1, C0]).variants;
    const alone = runVariants(candles, signals, [C0]).variants;
    // Running C1 in between must not leak state into the second C0 run.
    expect(both[0]!.trades).toEqual(alone[0]!.trades);
    expect(both[2]!.trades).toEqual(alone[0]!.trades);
    expect(both[1]!.trades).not.toEqual(both[0]!.trades);
    for (const v of both) {
      expect(v.signalsConsidered).toBe(2);
      expect(v.trades.every((t) => t.pass === "C")).toBe(true);
    }
  });

  it("C0 exactly reproduces the current Pass C economic results", () => {
    const candles = gapEntrySeries(251, 101, 400);
    const signals = [
      emaSignal(250, candles),
      emaSignal(255, candles, { strategyId: SQ_ID }),
      squeezeSignal(300, candles, "BUY", { squeezeLow: 99.6, squeezeHigh: 101 }),
      squeezeSignal(301, candles, "SELL", { squeezeLow: 99, squeezeHigh: 100.6 }, "A"),
      emaSignal(350, candles, { fromProductionHold: false })
    ];
    const current = simulatePassEconomicOutcomes({
      candles,
      signals,
      parametersByStrategyId: new Map([
        [EMA_ID, {}],
        [SQ_ID, {}]
      ]),
      tickSize: 0.01
    });
    const c0 = runVariants(candles, signals, [C0]).variants[0]!;
    expect(c0.trades).toEqual(current.trades.filter((t) => t.pass === "C"));
    expect(c0.metrics).toEqual(current.passC);
    expect(c0.signalsConsidered).toBe(current.simulationDiagnostics.C.executableSignalsSeen);
    expect(c0.signalsSkippedOpenPosition).toBe(current.simulationDiagnostics.C.signalsSkippedOpenPosition);
    expect(c0.maxBarsHeld).toBe(current.simulationDiagnostics.C.maxBarsHeld);
    expect(c0.signalsRejectedByResearchGate).toBe(0);
  });

  it("production-selected EMA trades and non-EMA fallbacks are unaffected", () => {
    const candles = gapEntrySeries(251, 101);
    for (const signal of [
      emaSignal(250, candles, { fromProductionHold: false }),
      emaSignal(250, candles, { strategyId: SQ_ID })
    ]) {
      const [c0, ...gated] = runVariants(candles, [signal]).variants;
      expect(c0!.trades).toHaveLength(1);
      for (const v of gated) {
        expect(v.signalsRejectedByResearchGate).toBe(0);
        expect(v.trades).toEqual(c0!.trades);
        expect(v.metrics).toEqual(c0!.metrics);
      }
    }
  });

  it("gate decisions use no candle after the entry open (no lookahead)", () => {
    const candles = gapEntrySeries(251, 101);
    const signals = [emaSignal(250, candles), emaSignal(270, candles, { strategyId: SQ_ID })];
    const seen: ReplayEntryGateContext[] = [];
    const spy: PassCVariantDefinition = {
      ...C1,
      gate: (ctx) => {
        seen.push(ctx);
        return C1.gate!(ctx);
      }
    };
    const base = runVariants(candles, signals, [spy]).variants[0]!;
    const expectedFeatures = extractFeatures(candles.slice(0, 251), DEFAULT_FEATURE_CONFIG).at(-1)!;
    expect(seen[0]!.signalFeatures).toEqual(expectedFeatures);
    expect(seen[0]!.entryPrice).toBe(candles[251]!.open);

    // Rewrite every candle after the EMA entry bar; the EMA gate decision must not move.
    const future = candles.map((c, i) =>
      i > 251 ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 } : c
    );
    const mutated = runVariants(future, signals, [C1]).variants[0]!;
    expect(mutated.rejections[0]).toEqual(base.rejections[0]);
  });

  it("report + markdown include the variant comparison and C0 matches report Pass C", () => {
    const candles = syntheticCandles({ count: 150, seed: 5, drift: 0.45, volatility: 2 });
    const report = runAutoSelectionCounterfactualReplay(candles.slice(0, 140), {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[100]!.openTime,
      analysisEndMs: candles[139]!.openTime + 60_000,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([
        mockStrategy({ id: EMA_ID, kind: "ema-pullback", supportedRegimes: ALL_REGIMES, action: "BUY" })
      ])
    });
    expect(report.passCVariants.variants.map((v) => v.id)).toEqual([...PASS_C_VARIANT_IDS]);
    const c0 = report.passCVariants.variants[0]!;
    expect(c0.metrics).toEqual(report.economic.passC);
    expect(c0.trades).toEqual(report.economic.trades.filter((t) => t.pass === "C"));

    const md = formatAutoSelectionReplayMarkdown(report);
    expect(md).toContain("## Pass C research variants (EMA fallback-from-HOLD entry gates)");
    expect(md).toContain("| Pass A |");
    for (const v of PASS_C_VARIANTS) expect(md).toContain(`| ${v.label} |`);
    expect(md).toContain("### EMA fallback-from-HOLD by variant");
    expect(md).toContain("### By strategy and direction");
  });
});

/** 1970-01-05 is a Monday: the first UTC week boundary after the epoch. */
const MONDAY_MS = Date.UTC(1970, 0, 5);
const WEEK_MS_TEST = 7 * 86_400_000;

/** Flat 1m bars at 100 starting 30 minutes before the Monday boundary. */
function boundaryCandles(count = 120): Candle[] {
  const start = MONDAY_MS - 30 * 60_000;
  return Array.from({ length: count }, (_, i) =>
    candleAt(start + i * 60_000, 100, 100.3, 99.7, 100)
  );
}

function weeklyTrade(entryTimeMs: number, exitTimeMs: number, outcome: ReplaySimulatedTrade["outcome"], realizedR: number | null) {
  return {
    ...diagTrade({ strategyId: EMA_ID, direction: "BUY", regime: null, outcome, realizedR }),
    entryTimeMs,
    exitTimeMs
  };
}

describe("Pass C research variants — weekly robustness", () => {
  it("groups by ENTRY week, not exit week (Monday 00:00 UTC boundary)", () => {
    expect(utcWeekStartMs(MONDAY_MS - 1)).toBe(MONDAY_MS - WEEK_MS_TEST);
    expect(utcWeekStartMs(MONDAY_MS)).toBe(MONDAY_MS);

    const trades = [
      weeklyTrade(MONDAY_MS - 60_000, MONDAY_MS + 3 * 86_400_000, "STOP", -1),
      weeklyTrade(MONDAY_MS + 60_000, MONDAY_MS + 2 * WEEK_MS_TEST, "TARGET", 2),
      weeklyTrade(MONDAY_MS + 120_000, MONDAY_MS + 3 * WEEK_MS_TEST, "OPEN_AT_END", null)
    ];
    const b = buildWeeklyEconomicBreakdown(trades);
    expect(b.weeks.map((w) => w.weekStartIso)).toEqual(["1969-12-29", "1970-01-05"]);
    expect(b.weeks[0]).toMatchObject({ entries: 1, resolvedTrades: 1, wins: 0, losses: 1, totalR: -1 });
    expect(b.weeks[1]).toMatchObject({ entries: 2, resolvedTrades: 1, wins: 1, totalR: 2, openAtEnd: 1 });
  });

  it("tick-rounding residue weeks count as flat, not negative", () => {
    const b = buildWeeklyEconomicBreakdown([
      weeklyTrade(MONDAY_MS + 60_000, MONDAY_MS + 120_000, "TARGET", 1.9999999918410447),
      weeklyTrade(MONDAY_MS + 180_000, MONDAY_MS + 240_000, "STOP", -1),
      weeklyTrade(MONDAY_MS + 300_000, MONDAY_MS + 360_000, "STOP", -1)
    ]);
    expect(b.weeks[0]!.totalR).toBeLessThan(0);
    expect(b.stability).toMatchObject({ flatWeeks: 1, negativeWeeks: 0, positiveWeeks: 0 });
  });

  it("a simulated trade spanning the week boundary stays in its entry week", () => {
    const candles = boundaryCandles();
    // Exit bar 40 is 10 minutes after the Monday boundary; entry (bar 6) is before it.
    candles[40] = candleAt(candles[40]!.openTime, 100, 100.1, 99, 99.2);
    const signals = [squeezeSignal(5, candles, "BUY", { squeezeLow: 99.6, squeezeHigh: 100.3 })];
    const c0 = runVariants(candles, signals, [C0]).variants[0]!;
    const t = c0.trades[0]!;
    expect(t.outcome).toBe("STOP");
    expect(t.entryTimeMs!).toBeLessThan(MONDAY_MS);
    expect(t.exitTimeMs!).toBeGreaterThan(MONDAY_MS);

    const weekly = buildPassCVariantWeeklyReport({
      variants: [c0],
      analysisStartMs: candles[0]!.openTime,
      analysisEndMs: candles.at(-1)!.closeTime
    });
    const [prior, monday] = weekly.variants[0]!.all.weeks;
    expect(prior).toMatchObject({ weekStartIso: "1969-12-29", entries: 1, losses: 1, totalR: -1 });
    expect(monday).toMatchObject({ weekStartIso: "1970-01-05", entries: 0, totalR: 0 });
    expect(weekly.variants[0]!.all.stability).toMatchObject({
      weeks: 2,
      weeksWithNoEntries: 1,
      negativeWeeks: 1,
      flatWeeks: 1,
      positiveWeeks: 0
    });
  });

  it("does not reset simulator state at week boundaries", () => {
    const candles = boundaryCandles();
    // Wide stop: the week-1 position never resolves and keeps blocking the week-2 signal.
    const signals = [
      squeezeSignal(5, candles, "BUY", { squeezeLow: 90, squeezeHigh: 110 }),
      squeezeSignal(60, candles, "BUY", { squeezeLow: 99.6, squeezeHigh: 100.3 })
    ];
    const c0 = runVariants(candles, signals, [C0]).variants[0]!;
    expect(c0.signalsSkippedOpenPosition).toBe(1);
    const weeks = buildWeeklyEconomicBreakdown(c0.trades).weeks;
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ weekStartIso: "1969-12-29", entries: 1, openAtEnd: 1 });

    // Contrast: an isolated week-2 run would have opened the second signal.
    const isolated = runVariants(candles, [signals[1]!], [C0]).variants[0]!;
    expect(isolated.entriesOpened).toBe(1);
    expect(utcWeekStartMs(isolated.trades[0]!.entryTimeMs!)).toBe(MONDAY_MS);
  });

  it("weekly R sums to each variant's total R; C0 aggregates unchanged; C1−C0 delta per week", () => {
    const candles = syntheticCandles({ count: 150, seed: 5, drift: 0.45, volatility: 2 });
    const report = runAutoSelectionCounterfactualReplay(candles.slice(0, 140), {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[100]!.openTime,
      analysisEndMs: candles[139]!.openTime + 60_000,
      selectionMode: "BOOTSTRAP",
      executionBackend: "paper_cfd",
      strategyAllowlist: [],
      strategies: defs([
        mockStrategy({ id: EMA_ID, kind: "ema-pullback", supportedRegimes: ALL_REGIMES, action: "BUY" })
      ])
    });
    const before = structuredClone(report.passCVariants);
    const weekly = buildPassCVariantWeeklyReport({
      variants: report.passCVariants.variants,
      analysisStartMs: candles[100]!.openTime,
      analysisEndMs: candles[139]!.openTime + 60_000
    });
    expect(report.passCVariants).toEqual(before);
    expect(report.passCVariants.variants[0]!.metrics).toEqual(report.economic.passC);
    expect(report.passCVariantWeekly).toEqual(weekly);

    report.passCVariants.variants.forEach((v, i) => {
      const w = weekly.variants[i]!;
      const sumAll = w.all.weeks.reduce((a, b) => a + b.totalR, 0);
      expect(sumAll).toBeCloseTo(v.totalR, 9);
      expect(w.all.stability.totalR).toBeCloseTo(v.totalR, 9);
      expect(w.all.weeks.reduce((a, b) => a + b.entries, 0)).toBe(
        v.trades.filter((t) => t.outcome !== "UNSCORABLE" && t.entryTimeMs != null).length
      );
      expect(w.emaFallbackFromHold.stability.totalR).toBeCloseTo(v.emaFallbackFromHold.stats.totalR, 9);
    });

    const c0 = weekly.variants[0]!.all.weeks;
    const c1 = weekly.variants[1]!.all.weeks;
    expect(weekly.c1VsC0).toHaveLength(c0.length);
    weekly.c1VsC0!.forEach((row, i) => {
      expect(row.deltaR).toBeCloseTo(c1[i]!.totalR - c0[i]!.totalR, 12);
    });

    const md = formatAutoSelectionReplayMarkdown(report);
    expect(md).toContain("## Pass C research variants by entry week (UTC)");
    expect(md).toContain("### Weekly stability — all Pass C trades");
    expect(md).toContain("### Weekly stability — EMA fallback-from-HOLD");
    expect(md).toContain("### C1 vs C0 delta R by entry week");
  });
});

const FWD_START_MS = Date.parse(R10_FORWARD_START_ISO);
const FWD_WARMUP_BARS = 100;

/** Synthetic uptrend whose bar FWD_WARMUP_BARS opens exactly at `forwardStartMs`. */
function forwardCandles(count = 160, forwardStartMs = FWD_START_MS): Candle[] {
  return syntheticCandles({
    count,
    seed: 11,
    drift: 0.5,
    volatility: 2,
    startTime: forwardStartMs - FWD_WARMUP_BARS * 60_000
  });
}

/** Production rank #1 HOLDs; EMA falls through (fallback-from-HOLD) when `emaAction` says so. */
function forwardStrategies(
  emaAction: (ctx: StrategyContext) => StrategyDecision["action"] = () => "BUY"
): ReplayStrategyDefinition[] {
  return defs([
    mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "BREAKOUT_EXPANSION"],
      action: "HOLD"
    }),
    mockStrategy({ id: EMA_ID, kind: "ema-pullback", supportedRegimes: ALL_REGIMES, action: emaAction })
  ]);
}

function runForward(
  candles: Candle[],
  overrides: Partial<Parameters<typeof runR10AutoForwardValidation>[1]> = {}
) {
  return runR10AutoForwardValidation(candles, {
    symbol: "R_10",
    interval: "1m",
    forwardStartMs: FWD_START_MS,
    selectionMode: "BOOTSTRAP",
    executionBackend: "paper_cfd",
    strategyAllowlist: [],
    strategies: forwardStrategies(),
    ...overrides
  });
}

describe("R_10 Pass C forward validation", () => {
  it("compares only C0 and the frozen C1 (fast-EMA extension ≤ 0.5 ATR) rule", () => {
    expect(R10_FORWARD_START_ISO).toBe("2026-09-29T16:17:00.000Z");
    expect([...FORWARD_VARIANT_IDS]).toEqual(["C0_BASELINE", "C1_EMA_MAX_EXTENSION_0_5"]);
    expect(FORWARD_VARIANTS[0]).toBe(C0);
    expect(FORWARD_VARIANTS[1]).toBe(C1);
    expect(FORWARD_VARIANTS[0]!.gate).toBeNull();

    const gate = FORWARD_VARIANTS[1]!.gate!;
    const decide = (entryPrice: number, direction: "BUY" | "SELL" = "BUY") =>
      gate(gateCtx({ entryPrice, direction, stopLoss: direction === "BUY" ? entryPrice - 5 : entryPrice + 5 }));
    expect(decide(100.5).reject).toBe(false);
    expect(decide(100.5001)).toMatchObject({ reject: true, reason: "EMA_EXTENSION_GT_0_5" });
    expect(decide(99.5, "SELL").reject).toBe(false);
    expect(decide(99.4999, "SELL")).toMatchObject({ reject: true, reason: "EMA_EXTENSION_GT_0_5" });
    expect(decide(99).reject).toBe(false);
    // Stop distance plays no role in the frozen C1 rule.
    expect(gate(gateCtx({ entryPrice: 100.4, stopLoss: 100.39 })).reject).toBe(false);
    expect(gate(gateCtx({ entryPrice: 100.4, stopLoss: 80 })).reject).toBe(false);
    expect(gate(gateCtx({ entryPrice: 110, fromProductionHold: false })).reject).toBe(false);
    expect(gate(gateCtx({ entryPrice: 110, strategyId: SQ_ID })).reject).toBe(false);

    const r = runForward(forwardCandles());
    expect(r.variants.map((v) => v.id)).toEqual(["C0_BASELINE", "C1_EMA_MAX_EXTENSION_0_5"]);
    expect(r.config.variants.map((v) => v.id)).toEqual(["C0_BASELINE", "C1_EMA_MAX_EXTENSION_0_5"]);
  });

  it("excludes signals at or before forwardStart and includes the first one after it", () => {
    const candles = forwardCandles();
    const r = runForward(candles);
    const c0 = r.variants[0]!;
    expect(r.coverage.firstForwardCandleIso).toBe(R10_FORWARD_START_ISO);
    expect(r.dataIntegrity.preForwardSignalsExcluded).toBe(0);
    expect(c0.result.trades[0]!.signalTimeMs).toBe(candles[FWD_WARMUP_BARS]!.closeTime);
    expect(c0.result.trades[0]!.signalCandleIndex).toBe(FWD_WARMUP_BARS);

    // A forward bar whose signal timestamp lands exactly on forwardStart is rejected.
    const degenerate = candles.map((c, i) => (i === FWD_WARMUP_BARS ? { ...c, closeTime: FWD_START_MS } : c));
    const d = runForward(degenerate);
    expect(d.dataIntegrity.preForwardSignalsExcluded).toBe(1);
    expect(d.variants[0]!.executableSignals).toBe(c0.executableSignals - 1);
    expect(d.variants[0]!.result.trades[0]!.signalCandleIndex).toBe(FWD_WARMUP_BARS + 1);
    for (const rep of [r, d]) {
      expect(rep.dataIntegrity.preForwardTradesInAnalysis).toBe(0);
      expect(rep.dataIntegrity.noPreForwardLeakage).toBe(true);
      for (const v of rep.variants) {
        for (const t of v.result.trades) expect(t.signalTimeMs).toBeGreaterThan(FWD_START_MS);
        for (const x of v.result.rejections) expect(x.signalTimeMs).toBeGreaterThan(FWD_START_MS);
      }
    }
  });

  it("warm-up candles feed indicators but never produce signals, trades, or results", () => {
    const candles = forwardCandles();
    const warmupOnly = runForward(candles, {
      strategies: forwardStrategies((ctx) => (ctx.candles.at(-1)!.openTime < FWD_START_MS ? "BUY" : "HOLD"))
    });
    expect(warmupOnly.coverage.warmupCandles).toBe(FWD_WARMUP_BARS);
    expect(warmupOnly.coverage.forwardCandles).toBe(candles.length - FWD_WARMUP_BARS);
    for (const v of warmupOnly.variants) {
      expect(v).toMatchObject({ executableSignals: 0, entries: 0, resolvedTrades: 0, totalR: 0, gateRejections: 0 });
    }
    expect(warmupOnly.weekly.cumulative.every((w) => w.c0R === 0 && w.c1R === 0)).toBe(true);

    // Rewriting warm-up OHLC only changes indicator inputs, never adds pre-forward trades.
    const full = runForward(candles);
    expect(full.coverage.forwardAnalysisBars).toBe(candles.length - FWD_WARMUP_BARS);
    expect(full.variants[0]!.executableSignals).toBe(full.coverage.forwardAnalysisBars);
    expect(full.variants.every((v) => v.result.trades.every((t) => t.signalCandleIndex >= FWD_WARMUP_BARS))).toBe(true);
  });

  it("C0 and C1 keep independent position state", () => {
    const candles = gapEntrySeries(251, 101);
    const signals = [emaSignal(250, candles), emaSignal(270, candles, { strategyId: SQ_ID })];
    const [c0, c1] = runVariants(candles, signals, FORWARD_VARIANTS).variants as [PassCVariantResult, PassCVariantResult];
    expect(c0.trades.map((t) => t.strategyId)).toEqual([EMA_ID]);
    expect(c0.signalsSkippedOpenPosition).toBe(1);
    expect(c1.trades.map((t) => t.strategyId)).toEqual([SQ_ID]);
    expect(c1.signalsSkippedOpenPosition).toBe(0);
    const reversed = runVariants(candles, signals, [C1, C0]).variants;
    expect(reversed[1]!.trades).toEqual(c0.trades);
    expect(reversed[0]!.trades).toEqual(c1.trades);
  });

  it("simulates the forward window continuously across week boundaries (no weekly reset)", () => {
    const start = MONDAY_MS - 20 * 60_000;
    const candles = forwardCandles(160, start);
    const r = runForward(candles, { forwardStartMs: start });
    expect(r.weekly.cumulative.map((w) => w.weekStartIso)).toEqual(["1969-12-29", "1970-01-05"]);

    const signals = buildReplayEconomicSignals(
      runAutoSelectionCounterfactualReplay(candles, {
        symbol: "R_10",
        interval: "1m",
        analysisStartMs: start,
        analysisEndMs: candles.at(-1)!.openTime + 60_000,
        selectionMode: "BOOTSTRAP",
        executionBackend: "paper_cfd",
        strategyAllowlist: [],
        strategies: forwardStrategies()
      }).bars
    ).filter((s) => s.pass === "C");
    const continuous = runPassCResearchVariants({
      candles,
      signals,
      parametersByStrategyId: new Map([
        [EMA_ID, {}],
        ["breakout-momentum-v1", {}]
      ]),
      tickSize: 0.01,
      featureLookback: 1500,
      variants: FORWARD_VARIANTS
    });
    r.variants.forEach((v, i) => expect(v.result.trades).toEqual(continuous.variants[i]!.trades));
    expect(r.variants[0]!.skippedWhilePositionOpen).toBeGreaterThan(0);
  });

  it("weekly rows sum to aggregates, cumulative ends at aggregates, empty weeks included", () => {
    const candles = forwardCandles();
    const r = runForward(candles, { forwardEndMs: FWD_START_MS + 20 * 86_400_000 });
    // 2026-09-28 (Mon) … 2026-10-19 (Mon): 4 UTC weeks, only the first has entries.
    expect(r.weekly.cumulative.map((w) => w.weekStartIso)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19"
    ]);
    const [c0, c1] = r.variants as [ForwardVariantSummary, ForwardVariantSummary];
    const sum = (f: (w: (typeof r.weekly.cumulative)[number]) => number) =>
      r.weekly.cumulative.reduce((a, w) => a + f(w), 0);
    expect(sum((w) => w.c0R)).toBeCloseTo(c0.totalR, 9);
    expect(sum((w) => w.c1R)).toBeCloseTo(c1.totalR, 9);
    expect(sum((w) => w.c0EmaR)).toBeCloseTo(c0.emaFallbackFromHold.totalR, 9);
    expect(sum((w) => w.c1EmaR)).toBeCloseTo(c1.emaFallbackFromHold.totalR, 9);
    const last = r.weekly.cumulative.at(-1)!;
    expect(last.cumulativeC0R).toBeCloseTo(c0.totalR, 9);
    expect(last.cumulativeC1R).toBeCloseTo(c1.totalR, 9);
    expect(last.cumulativeDeltaR).toBeCloseTo(c1.totalR - c0.totalR, 9);
    expect(last.cumulativeC0EmaR).toBeCloseTo(c0.emaFallbackFromHold.totalR, 9);
    for (const w of r.weekly.cumulative.slice(1)) {
      expect(w).toMatchObject({ c0R: 0, c1R: 0, deltaR: 0 });
      expect(w.cumulativeC0R).toBe(r.weekly.cumulative[0]!.cumulativeC0R);
    }
    expect(r.evidenceStatus.forwardDaysElapsed).toBeCloseTo(20, 9);
    expect(r.evidenceStatus.resolvedC1Trades).toBe(c1.resolvedTrades);
    expect(r.evidenceStatus.weeksWithResolvedC1Trade).toBe(c1.resolvedTrades > 0 ? 1 : 0);
  });

  it("scopes EMA fallback-from-HOLD reporting exactly", () => {
    const r = runForward(forwardCandles());
    for (const v of r.variants) {
      const scoped = v.result.trades.filter(
        (t) => t.pass === "C" && t.strategyId === EMA_ID && t.fromProductionHold
      );
      const entered = scoped.filter((t) => t.outcome !== "UNSCORABLE" && t.entryTimeMs != null);
      expect(v.emaFallbackFromHold.acceptedTrades.map((t) => t.signalCandleIndex)).toEqual(
        entered.map((t) => t.signalCandleIndex)
      );
      expect(v.emaFallbackFromHold.entries).toBe(entered.length);
      expect(v.emaFallbackFromHold.acceptedTrades.length).toBe(v.emaFallbackFromHold.entries);
      expect(v.emaFallbackFromHold.resolved).toBe(
        scoped.filter((t) => t.outcome === "TARGET" || t.outcome === "STOP").length
      );
      for (const x of v.emaFallbackFromHold.rejectedSignals) {
        expect(x).toMatchObject({ strategyId: EMA_ID, fromProductionHold: true });
      }
    }
    expect(r.variants[0]!.emaFallbackFromHold.rejectedSignals).toEqual([]);
    const c1 = r.variants[1]!;
    for (const x of c1.emaFallbackFromHold.rejectedSignals) {
      if (x.reason === "EMA_EXTENSION_GT_0_5") expect(x.detail!.extensionFromFastAtr!).toBeGreaterThan(0.5);
    }
    for (const t of c1.emaFallbackFromHold.acceptedTrades) expect(t.extensionFromFastAtr!).toBeLessThanOrEqual(0.5);

    const md = formatR10ForwardValidationMarkdown(r);
    expect(md).toContain("## C0 vs C1");
    expect(md).toContain("### C0 extension buckets");
    expect(md).toContain("### C1 accepted EMA fallback-from-HOLD trades");
    expect(md).toContain("### C1 rejected EMA fallback-from-HOLD signals");
    expect(md).toContain("## Weekly forward validation (UTC entry week, cumulative)");
    expect(md).toContain("## Evidence status (descriptive only)");
    expect(md).toContain("no leakage: confirmed");
    expect(md).not.toMatch(/recommend(ed|ation)?:/i);
  });

  it("handles an empty forward window without inventing results", () => {
    const warmupOnly = forwardCandles().slice(0, FWD_WARMUP_BARS);
    const r = runForward(warmupOnly, { forwardEndMs: FWD_START_MS });
    expect(r.coverage).toMatchObject({ forwardCandles: 0, forwardAnalysisBars: 0, firstForwardCandleIso: null });
    expect(r.variants.every((v) => v.entries === 0 && v.totalR === 0)).toBe(true);
    expect(r.evidenceStatus).toMatchObject({ forwardDaysElapsed: 0, resolvedC1Trades: 0, weeksWithResolvedC1Trade: 0 });
    expect(formatR10ForwardValidationMarkdown(r)).toContain("Forward analysis bars: 0");
  });

  it("latest forward/counterfactual reports are git-ignored and untracked", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const latest = [
      "research-datasets/auto-selection-forward-validation/r10_auto_forward_validation_latest.json",
      "research-datasets/auto-selection-forward-validation/r10_auto_forward_validation_latest.md",
      "research-datasets/auto-selection-counterfactual/r10_auto_counterfactual_latest.json",
      "research-datasets/auto-selection-counterfactual/r10_auto_counterfactual_latest.md"
    ];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...latest], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n");
    expect(ignored).toEqual(latest);
    const tracked = execFileSync("git", ["ls-files", "--", ...latest], { cwd: repoRoot, encoding: "utf8" }).trim();
    expect(tracked).toBe("");
  });

  it("leaves the historical C0/C1 replay unchanged", () => {
    const candles = forwardCandles();
    const cfg = {
      symbol: "R_10",
      interval: "1m",
      analysisStartMs: candles[FWD_WARMUP_BARS]!.openTime,
      analysisEndMs: candles.at(-1)!.openTime + 60_000,
      selectionMode: "BOOTSTRAP" as const,
      executionBackend: "paper_cfd" as const,
      strategyAllowlist: [] as string[],
      strategies: forwardStrategies()
    };
    const report = runAutoSelectionCounterfactualReplay(candles, cfg);
    const resim = simulatePassEconomicOutcomes({
      candles,
      signals: buildReplayEconomicSignals(report.bars),
      parametersByStrategyId: new Map([
        [EMA_ID, {}],
        ["breakout-momentum-v1", {}]
      ]),
      tickSize: 0.01
    });
    expect(resim.trades).toEqual(report.economic.trades);
    expect(report.passCVariants.variants.map((v) => v.id)).toEqual([...PASS_C_VARIANT_IDS]);
    const [hc0, hc1] = report.passCVariants.variants as [PassCVariantResult, PassCVariantResult];
    expect(hc0.metrics).toEqual(report.economic.passC);
    expect(hc0.emaFallbackFromHold.records).toEqual(report.economic.emaFallbackFromHold.trades);

    // Same window through the forward path yields the same C0/C1 results.
    const fwd = runForward(candles);
    expect(fwd.variants[0]!.result.trades).toEqual(hc0.trades);
    expect(fwd.variants[1]!.result.trades).toEqual(hc1.trades);
    expect(fwd.variants[1]!.result.rejections).toEqual(hc1.rejections);
  });
});
