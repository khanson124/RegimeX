/**
 * Live selection must use the same session applicability rules as MTF warm-up.
 */
import { describe, expect, it } from "vitest";
import {
  filterStrategiesForSessionWarmup,
  resolveSessionMtfWarmupSpec,
  strategyAppliesToSession
} from "./mt5MtfWarmup.js";
import { applyMt5StrategySelectionAllowlist } from "../broker/mt5/engineRollout.js";
import { SqueezeBreakoutStrategy } from "../strategies/squeezeBreakout.js";
import { XauTrendPullbackStrategy } from "../strategies/xauTrendPullback.js";
import { isCfdCapableStrategy } from "../strategies/cfdCapability.js";

const demoConfig = {
  EXECUTION_MODE: "broker_demo_mt5",
  REAL_MONEY_ENABLED: false,
  MT5_ENGINE_ENABLED: true,
  MT5_ENGINE_STRATEGY_ALLOWLIST: "squeeze-breakout-v1,xau-trend-pullback-v1"
};

/**
 * Mirrors LiveEngineSession selection filtering (sans regime/history gates)
 * so warm-up and live selection cannot disagree on symbol/interval scope.
 */
function resolveLiveSelectionEligibleIds(input: {
  strategies: Array<{ id: string; strategy: ReturnType<typeof Object> & {
    id: string;
    eligibility: { allowedIntervals: readonly string[]; allowedSymbols: readonly string[]; minimumRegimeConfidence: number };
    supportedRegimes: readonly string[];
    minimumHistory: number;
    multiTimeframeWarmup?: { executionInterval: string };
    allowedIntervals?: readonly string[];
  } }>;
  symbol: string;
  interval: string;
  candleCount: number;
  regime: string;
  regimeConfidence: number;
}): string[] {
  let eligible = input.strategies.filter((s) => {
    const st = s.strategy as Parameters<typeof strategyAppliesToSession>[0];
    return (
      st.supportedRegimes.includes(input.regime as never) &&
      input.regimeConfidence >= st.eligibility.minimumRegimeConfidence &&
      input.candleCount >= st.minimumHistory &&
      isCfdCapableStrategy(st.id) &&
      strategyAppliesToSession(st, { symbol: input.symbol, interval: input.interval })
    );
  });
  eligible = applyMt5StrategySelectionAllowlist(
    eligible,
    (s) => s.strategy.id,
    "broker_demo_mt5",
    demoConfig
  );
  return eligible.map((s) => s.strategy.id);
}

describe("live selection session scoping", () => {
  const squeeze = new SqueezeBreakoutStrategy();
  const xau = new XauTrendPullbackStrategy();
  const loaded = [
    { id: squeeze.id, strategy: squeeze },
    { id: xau.id, strategy: xau }
  ];

  it("R_10/1m/AUTO with both allowlisted → only squeeze-breakout-v1 eligible", () => {
    const ids = resolveLiveSelectionEligibleIds({
      strategies: loaded,
      symbol: "R_10",
      interval: "1m",
      candleCount: 1500,
      regime: "VOLATILITY_COMPRESSION",
      regimeConfidence: 0.8
    });
    expect(ids).toEqual(["squeeze-breakout-v1"]);
    expect(ids).not.toContain("xau-trend-pullback-v1");
  });

  it("xau-trend-pullback-v1 cannot be selected/evaluated on R_10/1m even with enough bars", () => {
    expect(strategyAppliesToSession(xau, { symbol: "R_10", interval: "1m" })).toBe(false);
    // History gate alone would pass (1500 >= 120) — session filter must still exclude.
    expect(1500 >= xau.minimumHistory).toBe(true);
    const ids = resolveLiveSelectionEligibleIds({
      strategies: loaded,
      symbol: "R_10",
      interval: "1m",
      candleCount: 1500,
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.9
    });
    expect(ids).toEqual([]);
    // Squeeze doesn't support STRONG_UPTREND — empty is correct; XAU must still be absent
    expect(ids).not.toContain("xau-trend-pullback-v1");
  });

  it("XAUUSD/15m still selects only xau-trend-pullback-v1", () => {
    const ids = resolveLiveSelectionEligibleIds({
      strategies: loaded,
      symbol: "XAUUSD",
      interval: "15m",
      candleCount: 200,
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8
    });
    expect(ids).toEqual(["xau-trend-pullback-v1"]);
    expect(ids).not.toContain("squeeze-breakout-v1");
  });

  it("invalid SINGLE fixed strategy for symbol/interval fails closed (not applicable)", () => {
    expect(strategyAppliesToSession(xau, { symbol: "R_10", interval: "1m" })).toBe(false);
    expect(strategyAppliesToSession(squeeze, { symbol: "XAUUSD", interval: "15m" })).toBe(false);
  });

  it("warm-up scoped strategy IDs and live-selection eligible IDs agree on R_10", () => {
    const warmupScoped = filterStrategiesForSessionWarmup(
      [squeeze, xau],
      { symbol: "R_10", interval: "1m" }
    ).map((s) => s.id);
    const allowlisted = applyMt5StrategySelectionAllowlist(
      warmupScoped.map((id) => ({ id })),
      (s) => s.id,
      "broker_demo_mt5",
      demoConfig
    ).map((s) => s.id);

    const liveIds = resolveLiveSelectionEligibleIds({
      strategies: loaded,
      symbol: "R_10",
      interval: "1m",
      candleCount: 1500,
      regime: "VOLATILITY_COMPRESSION",
      regimeConfidence: 0.8
    });

    expect(allowlisted).toEqual(["squeeze-breakout-v1"]);
    expect(liveIds).toEqual(["squeeze-breakout-v1"]);

    const mtf = resolveSessionMtfWarmupSpec({
      strategies: [squeeze, xau],
      eligibleStrategyIds: allowlisted,
      symbol: "R_10",
      interval: "1m"
    });
    expect(mtf?.requirements.map((r) => r.interval)).toEqual(["1m"]);
  });

  it("warm-up and live selection agree on XAUUSD/15m", () => {
    const warmupScoped = filterStrategiesForSessionWarmup(
      [squeeze, xau],
      { symbol: "XAUUSD", interval: "15m" }
    ).map((s) => s.id);
    expect(warmupScoped).toEqual(["xau-trend-pullback-v1"]);

    const liveIds = resolveLiveSelectionEligibleIds({
      strategies: loaded,
      symbol: "XAUUSD",
      interval: "15m",
      candleCount: 200,
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8
    });
    expect(liveIds).toEqual(["xau-trend-pullback-v1"]);
  });
});
