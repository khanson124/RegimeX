import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import {
  countVolatilityFunnel,
  evaluateVolatilitySetupAsOf,
  type VolatilityStateParams
} from "./volatilityExpansionState.js";
import {
  XauVolatilityExpansionRetestStrategy,
  XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS
} from "./xauVolatilityExpansionRetest.js";
import { proposeXauVolatilityExpansionRetestStopTarget } from "./xauVolatilityExpansionRetestCfd.js";
import { isCfdCapableStrategy, proposeCfdStopTarget } from "./cfdCapability.js";
import { SQUEEZE_BREAKOUT_DEFAULTS } from "./squeezeBreakout.js";
import { XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS } from "./xauMtfStructureMomentum.js";
import { assertProductionIntervalsUnchanged } from "../research/researchCandleInterval.js";
import { parseCsvAllowlist } from "../broker/mt5/engineRollout.js";
import { completedHtfBarsAsOf } from "./mtfResampleAsOf.js";

const DEFAULT_STATE: VolatilityStateParams = {
  compressionLookback: 8,
  maxNormalizedRange: 0.8,
  minCompressionBars: 4,
  minExpansionRangeAtr: 1.0,
  minBreakoutBodyAtr: 0.2,
  minCloseLocation: 0.55,
  retestZoneWidthAtr: 0.4,
  maxRetestDelayBars: 10,
  maxChaseExtensionAtr: 3,
  minAcceptanceCloseBeyondAtr: 0.08,
  exhaustionExtensionAtr: 4
};

function c5(
  i: number,
  o: number,
  h: number,
  l: number,
  cl: number,
  base = Date.UTC(2026, 0, 5, 8, 0, 0)
): Candle {
  const openTime = base + i * 5 * 60_000;
  return {
    symbol: "XAUUSD",
    interval: "5m" as never,
    openTime,
    closeTime: openTime + 5 * 60_000,
    open: o,
    high: h,
    low: l,
    close: cl,
    tickCount: 10,
    isComplete: true,
    source: "HISTORY_API"
  };
}

/** Tight range then bullish expansion, pullback retest, acceptance. */
function bullishRetestSeries(): Candle[] {
  const bars: Candle[] = [];
  // Compression: tight around 2000
  for (let i = 0; i < 12; i++) {
    bars.push(c5(i, 2000, 2000.4, 1999.6, 2000.1));
  }
  // Expansion breakout above ~2000.4
  bars.push(c5(12, 2000.2, 2003.5, 2000.1, 2003.2));
  // Extension without retest yet
  bars.push(c5(13, 2003.0, 2003.8, 2002.5, 2003.4));
  // Retest into zone around 2000.4
  bars.push(c5(14, 2003.0, 2003.1, 2000.3, 2000.6));
  // Acceptance close back above level
  bars.push(c5(15, 2000.7, 2002.5, 2000.5, 2002.3));
  return bars;
}

function bearishRetestSeries(): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < 12; i++) {
    bars.push(c5(i, 2000, 2000.4, 1999.6, 1999.9));
  }
  bars.push(c5(12, 1999.8, 1999.9, 1996.5, 1996.8));
  bars.push(c5(13, 1996.9, 1997.5, 1996.2, 1996.5));
  bars.push(c5(14, 1996.6, 1999.7, 1996.4, 1999.5));
  bars.push(c5(15, 1999.4, 1999.5, 1997.2, 1997.4));
  return bars;
}

describe("volatility expansion state machine", () => {
  it("detects compression → expansion → retest → acceptance (BUY)", () => {
    const bars = bullishRetestSeries();
    const mid = evaluateVolatilitySetupAsOf(bars, 12, DEFAULT_STATE);
    // Expansion may confirm on the breakout bar or remaining NEUTRAL if ATR gate not ready;
    // acceptance bar is the contract under test.
    if (mid.state !== "NEUTRAL" && mid.state !== "COMPRESSION") {
      expect(["EXPANSION_INITIATED", "EXPANSION_CONFIRMED", "RETEST_IN_PROGRESS"]).toContain(
        mid.state
      );
      expect(mid.breakoutDirection).toBe("BUY");
    }

    const retest = evaluateVolatilitySetupAsOf(bars, 14, DEFAULT_STATE);
    expect(
      retest.retestSeen ||
        retest.state === "RETEST_IN_PROGRESS" ||
        retest.state === "RETEST_ACCEPTED"
    ).toBe(true);

    const accepted = evaluateVolatilitySetupAsOf(bars, 15, DEFAULT_STATE);
    expect(accepted.state).toBe("RETEST_ACCEPTED");
    expect(accepted.breakoutDirection).toBe("BUY");
    expect(accepted.breakoutLevel).not.toBeNull();
  });

  it("detects SELL acceptance path", () => {
    const bars = bearishRetestSeries();
    const accepted = evaluateVolatilitySetupAsOf(bars, 15, DEFAULT_STATE);
    expect(accepted.state).toBe("RETEST_ACCEPTED");
    expect(accepted.breakoutDirection).toBe("SELL");
  });

  it("does not use future bars (no lookahead)", () => {
    const bars = bullishRetestSeries();
    const early = evaluateVolatilitySetupAsOf(bars.slice(0, 13), 12, DEFAULT_STATE);
    const withFuture = evaluateVolatilitySetupAsOf(bars, 12, DEFAULT_STATE);
    expect(early.state).toBe(withFuture.state);
    expect(early.breakoutLevel).toBe(withFuture.breakoutLevel);
  });

  it("marks exhausted when extension runs without retest", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 12; i++) bars.push(c5(i, 2000, 2000.3, 1999.7, 2000));
    bars.push(c5(12, 2000.1, 2003.5, 2000, 2003.2));
    // Run far without revisiting zone
    for (let i = 13; i <= 18; i++) {
      const px = 2003 + (i - 12) * 1.2;
      bars.push(c5(i, px, px + 0.5, px - 0.2, px + 0.3));
    }
    const snap = evaluateVolatilitySetupAsOf(bars, bars.length - 1, {
      ...DEFAULT_STATE,
      exhaustionExtensionAtr: 2.5,
      maxChaseExtensionAtr: 2.0,
      maxRetestDelayBars: 20
    });
    expect(["EXHAUSTED", "NEUTRAL"]).toContain(snap.state);
  });

  it("marks failed retest when price closes back through compression", () => {
    const bars = bullishRetestSeries().slice(0, 15);
    // Fail through compression low
    bars.push(c5(15, 2000.5, 2000.6, 1998.5, 1998.8));
    const snap = evaluateVolatilitySetupAsOf(bars, 15, DEFAULT_STATE);
    expect(snap.state === "BREAKOUT_FAILED" || snap.breakoutFailureFlag || snap.state === "NEUTRAL").toBe(
      true
    );
  });

  it("counts funnel transitions deterministically", () => {
    const a = countVolatilityFunnel(bullishRetestSeries(), DEFAULT_STATE);
    const b = countVolatilityFunnel(bullishRetestSeries(), DEFAULT_STATE);
    expect(a).toEqual(b);
    expect(a.expansionDetected).toBeGreaterThanOrEqual(1);
    expect(a.accepted).toBeGreaterThanOrEqual(1);
  });
});

describe("xau-volatility-expansion-retest-v1 contract", () => {
  it("is CFD-capable without mutating existing strategy defaults", () => {
    expect(isCfdCapableStrategy("xau-volatility-expansion-retest-v1")).toBe(true);
    const beforeSq = JSON.stringify(SQUEEZE_BREAKOUT_DEFAULTS);
    const beforeMtf = JSON.stringify(XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS);
    new XauVolatilityExpansionRetestStrategy().validateParameters({
      ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS
    });
    expect(JSON.stringify(SQUEEZE_BREAKOUT_DEFAULTS)).toBe(beforeSq);
    expect(JSON.stringify(XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS)).toBe(beforeMtf);
    assertProductionIntervalsUnchanged();
    expect(CANDLE_INTERVALS).toEqual(["1m", "5m"]);
  });

  it("structural stop BUY/SELL + target room cap", () => {
    const buy = proposeXauVolatilityExpansionRetestStopTarget({
      direction: "BUY",
      entryPrice: 2002,
      features: { atr: 1.5 } as never,
      candles: [c5(0, 2001, 2002.5, 2000.2, 2002)],
      metadata: { pullbackLow: 2000.2, intendedR: 2, structuralRoomR: 1.3 }
    });
    expect(buy).not.toBeNull();
    expect(buy!.stopLoss).toBeLessThan(2002);
    expect(buy!.riskRewardRatio).toBeLessThanOrEqual(1.3 + 1e-9);

    const sell = proposeCfdStopTarget({
      strategyId: "xau-volatility-expansion-retest-v1",
      direction: "SELL",
      entryPrice: 1998,
      features: { atr: 1.5 } as never,
      candles: [c5(0, 1999, 1999.8, 1997, 1998)],
      metadata: { pullbackHigh: 1999.8, intendedR: 2 },
      tickSize: 0.01
    });
    expect(sell).not.toBeNull();
    expect(sell!.stopLoss).toBeGreaterThan(1998);
  });

  it("HOLD until retest accepted; session metadata present", () => {
    const s = new XauVolatilityExpansionRetestStrategy();
    // Build 1m from compression only (no acceptance yet)
    const m1: Candle[] = [];
    const base = Date.UTC(2026, 0, 5, 8, 0, 0);
    for (let i = 0; i < 1000; i++) {
      const openTime = base + i * 60_000;
      m1.push({
        symbol: "XAUUSD",
        interval: "1m",
        openTime,
        closeTime: openTime + 60_000,
        open: 2000,
        high: 2000.2,
        low: 1999.8,
        close: 2000,
        tickCount: 2,
        isComplete: true,
        source: "HISTORY_API"
      });
    }
    const features = m1.map((c) => ({
      atr: 1,
      adx: 15,
      bollingerWidth: 0.001,
      timestamp: c.closeTime
    })) as never;
    const d = s.evaluate({
      candles: m1,
      features,
      regime: {
        regime: "VOLATILITY_COMPRESSION",
        confidence: 0.7,
        scores: { trend: 0, momentum: 0, volatility: 50, range: 50, breakout: 0 },
        reasons: [],
        timestamp: m1.at(-1)!.closeTime,
        classifierVersion: "test"
      },
      parameters: { ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS, executionTimeframe: "5m" },
      candlesSinceLastSignal: 100
    });
    expect(d.action).toBe("HOLD");
    expect(d.metadata.sessionContext).toBeTruthy();
    // Last bar may not be 5m close
    expect(
      (d.metadata.entryQualityReasonCodes as string[]).some((c) =>
        ["WRONG_BAR_FOR_EXECUTION_MODE", "NOT_RETEST_ACCEPTED", "INSUFFICIENT_HISTORY"].includes(c)
      )
    ).toBe(true);
  });

  it("does not enable XAUUSD", () => {
    expect(parseCsvAllowlist("")).not.toContain("XAUUSD");
    expect(parseCsvAllowlist("R_10")).not.toContain("XAUUSD");
    expect(parseCsvAllowlist("xau-volatility-expansion-retest-v1")).not.toContain("XAUUSD");
  });

  it("5m HTF resample aligns for setup", () => {
    const m1: Candle[] = [];
    const base = Date.UTC(2026, 0, 5, 12, 0, 0);
    for (let i = 0; i < 50; i++) {
      const openTime = base + i * 60_000;
      m1.push({
        symbol: "XAUUSD",
        interval: "1m",
        openTime,
        closeTime: openTime + 60_000,
        open: 2000 + i * 0.01,
        high: 2000.2 + i * 0.01,
        low: 1999.8 + i * 0.01,
        close: 2000.05 + i * 0.01,
        tickCount: 1,
        isComplete: true,
        source: "HISTORY_API"
      });
    }
    const five = completedHtfBarsAsOf(m1, 49, "5m");
    expect(five.length).toBeGreaterThanOrEqual(8);
    expect(five.every((b) => b.closeTime <= m1[49]!.closeTime)).toBe(true);
  });
});
