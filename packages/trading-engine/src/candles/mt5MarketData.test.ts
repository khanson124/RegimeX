import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  filterRestorableMt5Candles,
  isMt5MarketDataReady,
  NO_MT5_ELIGIBLE_STRATEGIES,
  resolveMt5WarmupRequirement,
  shouldIngestMt5ClosedCandle,
  validateIncomingMt5Candle
} from "./mt5MarketData.js";

const demoConfig = {
  EXECUTION_MODE: "broker_demo_mt5",
  REAL_MONEY_ENABLED: false,
  MT5_ENGINE_ENABLED: true,
  MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1"
};

const rolloutStrategies = [
  { strategyId: "ema-pullback-v1", minimumHistory: 60 },
  { strategyId: "squeeze-breakout-v1", minimumHistory: 80 }
];

function mt5Candle(close: number, source: Candle["source"] = "MT5_LIVE_TICKS"): Candle {
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: 0,
    closeTime: 60_000,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    tickCount: 3,
    isComplete: true,
    source
  };
}

describe("resolveMt5WarmupRequirement", () => {
  it("A: allowlist only ema-pullback-v1 uses EMA minimumHistory only", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: rolloutStrategies,
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    expect(requirement).toEqual({
      status: "REQUIRES_BARS",
      requiredBars: 60,
      eligibleStrategyIds: ["ema-pullback-v1"]
    });
  });

  it("B: disallowed strategy with larger minimumHistory does not affect warm-up", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: [
        { strategyId: "ema-pullback-v1", minimumHistory: 60 },
        { strategyId: "squeeze-breakout-v1", minimumHistory: 80 }
      ],
      executionBackend: "broker_demo_mt5",
      config: { ...demoConfig, MT5_ENGINE_STRATEGY_ALLOWLIST: "ema-pullback-v1" },
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    expect(requirement.status).toBe("REQUIRES_BARS");
    if (requirement.status === "REQUIRES_BARS") {
      expect(requirement.requiredBars).toBe(60);
      expect(requirement.eligibleStrategyIds).toEqual(["ema-pullback-v1"]);
    }
  });

  it("C: empty MT5 eligible strategy set remains fail-closed", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: rolloutStrategies,
      executionBackend: "broker_demo_mt5",
      config: { ...demoConfig, MT5_ENGINE_STRATEGY_ALLOWLIST: "" },
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    expect(requirement).toEqual({
      status: "NO_ELIGIBLE_STRATEGIES",
      reason: NO_MT5_ELIGIBLE_STRATEGIES
    });
    expect(isMt5MarketDataReady([mt5Candle(4780)], requirement).ready).toBe(false);
    expect(isMt5MarketDataReady([mt5Candle(4780)], requirement).reason).toBe(NO_MT5_ELIGIBLE_STRATEGIES);
  });

  it("D: fixed/SINGLE disallowed strategy remains blocked", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: rolloutStrategies,
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "SINGLE",
      fixedStrategyId: "squeeze-breakout-v1"
    });
    expect(requirement).toEqual({
      status: "NO_ELIGIBLE_STRATEGIES",
      reason: NO_MT5_ELIGIBLE_STRATEGIES
    });
  });

  it("E: fixed/SINGLE allowed strategy uses only its required minimumHistory", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: rolloutStrategies,
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "SINGLE",
      fixedStrategyId: "ema-pullback-v1"
    });
    expect(requirement).toEqual({
      status: "REQUIRES_BARS",
      requiredBars: 60,
      eligibleStrategyIds: ["ema-pullback-v1"]
    });
  });
});

describe("filterRestorableMt5Candles", () => {
  it("D: rejects Deriv LIVE_TICKS history for MT5 restore", () => {
    const result = filterRestorableMt5Candles([
      mt5Candle(4783, "LIVE_TICKS"),
      mt5Candle(4784, "LIVE_TICKS")
    ]);
    expect(result.candles).toEqual([]);
    expect(result.rejected).toBe(true);
  });

  it("rejects quarantined CONTAMINATED_MIXED_DOMAIN rows", () => {
    const result = filterRestorableMt5Candles([
      mt5Candle(4783, "CONTAMINATED_MIXED_DOMAIN" as Candle["source"])
    ]);
    expect(result.candles).toEqual([]);
    expect(result.rejected).toBe(true);
  });

  it("G: rejects contaminated MT5 rows with cross-domain jumps", () => {
    const result = filterRestorableMt5Candles([mt5Candle(4783), mt5Candle(9790)]);
    expect(result.candles).toEqual([]);
    expect(result.rejected).toBe(true);
  });

  it("accepts consistent MT5-only history", () => {
    const result = filterRestorableMt5Candles([mt5Candle(4783), mt5Candle(4784), mt5Candle(4785)]);
    expect(result.rejected).toBe(false);
    expect(result.candles).toHaveLength(3);
  });
});

describe("isMt5MarketDataReady", () => {
  it("H: blocks analysis/execution until warm-up threshold is met", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: rolloutStrategies,
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    const candles = Array.from({ length: 10 }, (_, i) => mt5Candle(4780 + i));
    expect(isMt5MarketDataReady(candles, requirement).ready).toBe(false);
    const warmed = Array.from({ length: 60 }, (_, i) => mt5Candle(4780 + i * 0.1));
    expect(isMt5MarketDataReady(warmed, requirement).ready).toBe(true);
  });

  it("fails closed when buffer contains non-MT5 provenance", () => {
    const requirement = resolveMt5WarmupRequirement({
      strategies: rolloutStrategies,
      executionBackend: "broker_demo_mt5",
      config: demoConfig,
      selectionMode: "AUTO",
      fixedStrategyId: null
    });
    const candles = [mt5Candle(4780), { ...mt5Candle(4781), source: "LIVE_TICKS" as const }];
    expect(isMt5MarketDataReady(candles, requirement).ready).toBe(false);
  });
});

describe("shouldIngestMt5ClosedCandle", () => {
  it("F: rejects mixed-domain candle before persistence/analysis path", () => {
    const previous = mt5Candle(4783);
    const contaminated = {
      ...mt5Candle(9790),
      open: 4783.034,
      high: 9791.47,
      low: 4782.653,
      close: 9790.46
    };
    expect(shouldIngestMt5ClosedCandle(contaminated, previous.close)).toBe(false);
    expect(validateIncomingMt5Candle(contaminated, previous.close).accepted).toBe(false);
  });

  it("accepts normal consecutive MT5 candles", () => {
    expect(shouldIngestMt5ClosedCandle(mt5Candle(4784), 4783)).toBe(true);
  });
});
