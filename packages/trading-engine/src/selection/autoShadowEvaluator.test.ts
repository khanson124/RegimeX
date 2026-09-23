import { describe, expect, it, vi } from "vitest";
import {
  type Candle,
  type MarketFeatureSnapshot,
  type MarketRegime,
  type RegimeResult,
  type StrategyDecision
} from "@regimex/shared";
import { type StrategyContext, type TradingStrategy } from "../strategies/types.js";
import {
  applyAutoShadowCooldownUpdates,
  evaluateAutoShadowCandidates,
  formatAutoShadowComparisonSummary
} from "./autoShadowEvaluator.js";

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
  action: StrategyDecision["action"];
  cooldownCandles?: number;
  onEvaluate?: () => void;
}): TradingStrategy {
  const cooldown = input.cooldownCandles ?? 0;
  return {
    id: input.id,
    name: input.id,
    version: "1",
    kind: input.kind,
    supportedRegimes: ["STRONG_UPTREND", "BREAKOUT_EXPANSION"] as MarketRegime[],
    minimumHistory: 1,
    eligibility: { minimumRegimeConfidence: 0.1 },
    validateParameters: (raw) => raw as Record<string, number | boolean | string>,
    evaluate(ctx: StrategyContext): StrategyDecision {
      input.onEvaluate?.();
      const ts = ctx.candles[ctx.candles.length - 1]?.closeTime ?? 0;
      if (cooldown > 0 && ctx.candlesSinceLastSignal < cooldown) {
        return holdLike(this, ts, "HOLD", [`Cooldown ${ctx.candlesSinceLastSignal}/${cooldown}`]);
      }
      return holdLike(this, ts, input.action, [`mock-${input.action}`]);
    }
  };
}

function regime(ts: number): RegimeResult {
  return {
    regime: "STRONG_UPTREND",
    confidence: 0.8,
    scores: { trend: 80, momentum: 70, volatility: 40, range: 20, breakout: 50 },
    reasons: ["test"],
    timestamp: ts,
    classifierVersion: "test"
  };
}

function candle(ts: number): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: ts,
    closeTime: ts + 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    tickCount: 10,
    isComplete: true,
    source: "SEED"
  };
}

function feature(ts: number): MarketFeatureSnapshot {
  return {
    symbol: "R_10",
    interval: "1m",
    timestamp: ts,
    close: 100.5,
    emaFast: 100,
    emaSlow: 99,
    emaLong: 98,
    emaFastSlope: 0.001,
    emaSlowSlope: 0.001,
    rsi: 55,
    atr: 1,
    atrPercent: 0.01,
    adx: 30,
    macd: 0.1,
    macdSignal: 0.05,
    macdHistogram: 0.05,
    bollingerUpper: 102,
    bollingerMiddle: 100,
    bollingerLower: 98,
    bollingerWidth: 0.04,
    priceDistanceFromEma: 0.005,
    recentReturn: 0.01,
    higherHighCount: 1,
    lowerLowCount: 0,
    donchianHigh: 101,
    donchianLow: 99,
    trendDirection: 1,
    volatilityPercentile: 50,
    momentumScore: 60,
    trendScore: 70,
    rangeScore: 20,
    breakoutScore: 40
  };
}

describe("autoShadowEvaluator", () => {
  it("evaluates all eligible strategies and flags production HOLD vs alternative BUY", () => {
    const ts = Date.UTC(2026, 8, 20, 14, 0, 0);
    const holder = mockStrategy({
      id: "squeeze-breakout-v1",
      kind: "squeeze-breakout",
      action: "HOLD"
    });
    const buyer = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      action: "BUY"
    });
    const productionDecision = holdLike(holder, ts + 60_000, "HOLD", ["no setup"]);

    const { report, shadowCooldownUpdates } = evaluateAutoShadowCandidates({
      timestampMs: ts + 60_000,
      openTimeMs: ts,
      candleIndex: 100,
      symbol: "R_10",
      interval: "1m",
      executionBackend: "broker_demo_mt5",
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8,
      selectionResult: {
        selectedStrategyId: holder.id,
        selectionScore: 55,
        selectionMode: "BOOTSTRAP",
        alternatives: [{ strategyId: buyer.id, score: 50, componentScores: {} }]
      },
      productionDecision,
      eligible: [
        { strategy: holder, parameters: {} },
        { strategy: buyer, parameters: {} }
      ],
      context: {
        candles: [candle(ts)],
        features: [feature(ts + 60_000)],
        regime: regime(ts + 60_000)
      },
      shadowLastSignalCandle: new Map()
    });

    expect(report.production.action).toBe("HOLD");
    expect(report.productionHoldWithAlternativeSignals).toBe(true);
    expect(report.alternativeSignalStrategyIds).toEqual(["breakout-momentum-v1"]);
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.find((c) => c.strategyId === buyer.id)?.rank).toBe(2);
    expect(report.candidates.find((c) => c.strategyId === buyer.id)?.executionReadiness).toBe(
      "NOT_ASSESSED"
    );
    expect(report.comparisonSummary).toContain("AUTO_SHADOW");
    expect(report.comparisonSummary).toContain("breakout-momentum-v1:BUY");
    expect(shadowCooldownUpdates.map((u) => u.strategyId)).toEqual(["breakout-momentum-v1"]);
  });

  it("does not mutate a production cooldown map when applying shadow updates", () => {
    const productionCooldown = new Map<string, number>([["squeeze-breakout-v1", 10]]);
    const shadowCooldown = new Map<string, number>();
    const productionSnapshot = new Map(productionCooldown);

    applyAutoShadowCooldownUpdates(shadowCooldown, [
      { strategyId: "breakout-momentum-v1", candleIndex: 42 }
    ]);

    expect(shadowCooldown.get("breakout-momentum-v1")).toBe(42);
    expect(productionCooldown).toEqual(productionSnapshot);
    expect(productionCooldown.has("breakout-momentum-v1")).toBe(false);
  });

  it("marks repeated alternative setups across consecutive bars vs independent starts", () => {
    const ts = Date.UTC(2026, 8, 20, 14, 54, 0);
    const holder = mockStrategy({
      id: "breakout-momentum-v1",
      kind: "breakout-momentum",
      action: "HOLD"
    });
    const buyer = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      action: "BUY",
      cooldownCandles: 0
    });

    const baseInput = {
      timestampMs: ts + 60_000,
      openTimeMs: ts,
      candleIndex: 200,
      symbol: "R_10",
      interval: "1m",
      executionBackend: "broker_demo_mt5" as const,
      regime: "STRONG_UPTREND" as const,
      regimeConfidence: 0.76,
      selectionResult: {
        selectedStrategyId: holder.id,
        selectionScore: 60,
        selectionMode: "BOOTSTRAP",
        alternatives: [{ strategyId: buyer.id, score: 40, componentScores: {} }]
      },
      productionDecision: holdLike(holder, ts + 60_000, "HOLD", ["no"]),
      eligible: [
        { strategy: holder, parameters: {} },
        { strategy: buyer, parameters: {} }
      ],
      context: {
        candles: [candle(ts)],
        features: [feature(ts + 60_000)],
        regime: regime(ts + 60_000)
      },
      shadowLastSignalCandle: new Map<string, number>()
    };

    const first = evaluateAutoShadowCandidates(baseInput);
    expect(first.report.independentAlternativeSignalStrategyIds).toContain("ema-pullback-v1");
    expect(first.report.repeatedAlternativeSignalStrategyIds).toEqual([]);

    const second = evaluateAutoShadowCandidates({
      ...baseInput,
      candleIndex: 201,
      openTimeMs: ts + 60_000,
      previousAlternativeSignalIds: new Set(first.report.alternativeSignalStrategyIds)
    });
    expect(second.report.repeatedAlternativeSignalStrategyIds).toContain("ema-pullback-v1");
    expect(second.report.independentAlternativeSignalStrategyIds).not.toContain("ema-pullback-v1");
  });

  it("annotates forward-trial blocks without claiming execution readiness", () => {
    const ts = Date.UTC(2026, 8, 20, 15, 0, 0);
    const seller = mockStrategy({
      id: "squeeze-breakout-v1",
      kind: "squeeze-breakout",
      action: "SELL"
    });
    const { report: allowedReport } = evaluateAutoShadowCandidates({
      timestampMs: ts + 60_000,
      openTimeMs: ts,
      candleIndex: 50,
      symbol: "R_10",
      interval: "1m",
      executionBackend: "broker_demo_mt5",
      regime: "VOLATILITY_COMPRESSION",
      regimeConfidence: 0.7,
      selectionResult: {
        selectedStrategyId: seller.id,
        selectionScore: 50,
        selectionMode: "BOOTSTRAP",
        alternatives: []
      },
      productionDecision: holdLike(seller, ts + 60_000, "HOLD", ["prod hold"]),
      eligible: [{ strategy: seller, parameters: {} }],
      context: {
        candles: [candle(ts)],
        features: [feature(ts + 60_000)],
        regime: { ...regime(ts + 60_000), regime: "VOLATILITY_COMPRESSION" }
      },
      shadowLastSignalCandle: new Map()
    });

    const allowed = allowedReport.candidates[0]!;
    expect(allowed.action).toBe("SELL");
    expect(allowed.forwardTrialBlocked).toBe(false);
    expect(allowed.shadowSignalEligible).toBe(true);
    expect(allowed.executionReadiness).toBe("NOT_ASSESSED");

    const { report: blockedReport } = evaluateAutoShadowCandidates({
      timestampMs: ts + 60_000,
      openTimeMs: ts,
      candleIndex: 50,
      symbol: "R_10",
      interval: "5m",
      executionBackend: "broker_demo_mt5",
      regime: "VOLATILITY_COMPRESSION",
      regimeConfidence: 0.7,
      selectionResult: {
        selectedStrategyId: seller.id,
        selectionScore: 50,
        selectionMode: "BOOTSTRAP",
        alternatives: []
      },
      productionDecision: holdLike(seller, ts + 60_000, "HOLD", ["prod hold"]),
      eligible: [{ strategy: seller, parameters: {} }],
      context: {
        candles: [candle(ts)],
        features: [feature(ts + 60_000)],
        regime: { ...regime(ts + 60_000), regime: "VOLATILITY_COMPRESSION" }
      },
      shadowLastSignalCandle: new Map()
    });

    const blocked = blockedReport.candidates[0]!;
    expect(blocked.action).toBe("SELL");
    expect(blocked.forwardTrialBlocked).toBe(true);
    expect(blocked.shadowSignalEligible).toBe(false);
    expect(blocked.forwardTrialReason).toBe("R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY");
    expect(blocked.executionReadiness).toBe("NOT_ASSESSED");
    expect(blockedReport.productionHoldWithAlternativeSignals).toBe(false);
  });

  it("shadow evaluation result contains no executable intent fields", () => {
    const ts = Date.UTC(2026, 8, 20, 14, 0, 0);
    const buyer = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      action: "BUY"
    });
    const { report } = evaluateAutoShadowCandidates({
      timestampMs: ts + 60_000,
      openTimeMs: ts,
      candleIndex: 1,
      symbol: "R_10",
      interval: "1m",
      executionBackend: "broker_demo_mt5",
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8,
      selectionResult: {
        selectedStrategyId: buyer.id,
        selectionScore: 70,
        selectionMode: "BOOTSTRAP",
        alternatives: []
      },
      productionDecision: holdLike(buyer, ts + 60_000, "HOLD", ["hold"]),
      eligible: [{ strategy: buyer, parameters: {} }],
      context: {
        candles: [candle(ts)],
        features: [feature(ts + 60_000)],
        regime: regime(ts + 60_000)
      },
      shadowLastSignalCandle: new Map()
    });

    const json = JSON.stringify(report);
    expect(json).not.toMatch(/executeCfdSignal|orderId|volume|broker|mt5|submit/i);
    expect(report.candidates.every((c) => c.executionReadiness === "NOT_ASSESSED")).toBe(true);
  });

  it("formats a compact HOLD vs BUY comparison line", () => {
    const line = formatAutoShadowComparisonSummary({
      productionAction: "HOLD",
      productionStrategyId: "squeeze-breakout-v1",
      regime: "BREAKOUT_EXPANSION",
      alternativeCandidates: [
        {
          strategyId: "breakout-momentum-v1",
          action: "BUY",
          rank: 2,
          repeatedSetup: false,
          forwardTrialBlocked: false
        }
      ]
    });
    expect(line).toBe(
      "AUTO_SHADOW prod=squeeze-breakout-v1/HOLD regime=BREAKOUT_EXPANSION vs breakout-momentum-v1:BUY(r2,indep)"
    );
  });

  it("never invokes a provided order/submit callback (API has none)", () => {
    const submit = vi.fn();
    const buyer = mockStrategy({
      id: "ema-pullback-v1",
      kind: "ema-pullback",
      action: "BUY",
      onEvaluate: () => {
        // Shadow path must not call submit even if a host mistakenly wires one.
        expect(submit).not.toHaveBeenCalled();
      }
    });
    evaluateAutoShadowCandidates({
      timestampMs: 1,
      openTimeMs: 0,
      candleIndex: 3,
      symbol: "R_10",
      interval: "1m",
      executionBackend: "broker_demo_mt5",
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8,
      selectionResult: {
        selectedStrategyId: "breakout-momentum-v1",
        selectionScore: 1,
        selectionMode: "BOOTSTRAP",
        alternatives: [{ strategyId: buyer.id, score: 0, componentScores: {} }]
      },
      productionDecision: holdLike(
        { id: "breakout-momentum-v1", version: "1" },
        1,
        "HOLD",
        []
      ),
      eligible: [{ strategy: buyer, parameters: {} }],
      context: {
        candles: [candle(0)],
        features: [feature(1)],
        regime: regime(1)
      },
      shadowLastSignalCandle: new Map()
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
