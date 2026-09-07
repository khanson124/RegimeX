import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  TREND_STRUCTURE_PULLBACK_DEFAULTS,
  TrendStructurePullbackStrategy
} from "./trendStructurePullback.js";
import { proposeTrendStructurePullbackStopTarget } from "./trendStructurePullbackCfd.js";
import { proposeCfdStopTarget } from "./cfdCapability.js";
import { findConfirmedSwingPivots } from "./structureSwings.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "./emaPullback.js";
import { featureFixture, regimeFixture } from "../testing/fixtures.js";
import { type StrategyContext } from "./types.js";
import { buildEntryFeatureTelemetry } from "../research/entryFeatureTelemetry.js";

function baseCandle(i: number, ohlc: { o: number; h: number; l: number; c: number }): Candle {
  const t = Date.UTC(2026, 0, 1) + i * 60_000;
  return {
    symbol: "R_10",
    interval: "1m",
    openTime: t,
    closeTime: t + 60_000,
    open: ohlc.o,
    high: ohlc.h,
    low: ohlc.l,
    close: ohlc.c,
    tickCount: 20,
    isComplete: true,
    source: "SEED"
  };
}

/**
 * Controlled BUY series with confirmed HL swings (lookback=3):
 * - prior low @4 = 980
 * - swing low @10 = 990 (HL)
 * - impulse high @16 = 996 (~3 ATR with atr=2)
 * - rejection @39 touches slow EMA ~993.5 and closes above
 */
function buildBuySeries(opts: {
  last?: { o: number; h: number; l: number; c: number };
  longEma?: number;
  slowEma?: number;
  fastEma?: number;
  atr?: number;
  rsi?: number;
  params?: Record<string, number | boolean | string>;
}): StrategyContext {
  const atr = opts.atr ?? 2;
  const longEma = opts.longEma ?? 992;
  const slowEma = opts.slowEma ?? 993.5;
  const fastEma = opts.fastEma ?? 995;
  const candles: Candle[] = [];

  for (let i = 0; i < 40; i++) {
    let o = 991 + i * 0.05;
    let c = o + 0.02;
    let h = Math.max(o, c) + 0.3;
    let l = Math.min(o, c) - 0.3;

    if (i === 4) {
      l = 980;
      o = 982;
      c = 981.5;
      h = 983;
    } else if (i >= 1 && i <= 7 && i !== 4) {
      l = Math.max(l, 984);
    }

    if (i === 10) {
      l = 990;
      o = 991.5;
      c = 991.2;
      h = 992;
    } else if (i >= 7 && i <= 13 && i !== 10) {
      l = Math.max(l, 991.2);
    }

    if (i === 16) {
      // impulse high — keep neighbors from confirming this as a swing high
      // so target-room uses an older/farther high if any.
      h = 996;
      o = 994;
      c = 995;
      l = 993.5;
    }

    if (i === 39) {
      const last = opts.last ?? { o: 994.4, h: 995.5, l: 993.2, c: 995.0 };
      o = last.o;
      h = last.h;
      l = last.l;
      c = last.c;
    }

    candles.push(baseCandle(i, { o: Number(o.toFixed(3)), h: Number(h.toFixed(3)), l: Number(l.toFixed(3)), c: Number(c.toFixed(3)) }));
  }

  const features = candles.map((c) =>
    featureFixture({
      timestamp: c.closeTime,
      close: c.close,
      emaFast: fastEma,
      emaSlow: slowEma,
      emaLong: longEma,
      atr,
      adx: 28,
      rsi: opts.rsi ?? 55,
      trendDirection: 1,
      higherHighCount: 2,
      lowerLowCount: 0,
      donchianHigh: 1001,
      donchianLow: 979
    })
  );

  return {
    candles,
    features,
    regime: regimeFixture({ timestamp: candles[39]!.closeTime, regime: "STRONG_UPTREND" }),
    parameters: {
      ...TREND_STRUCTURE_PULLBACK_DEFAULTS,
      // Fixture geometry: leave room check soft so unit tests target intended filters.
      minTargetRoomR: 0.5,
      maxImpulseDistanceAtr: 5,
      ...(opts.params ?? {})
    },
    candlesSinceLastSignal: Number.POSITIVE_INFINITY
  };
}

/**
 * Controlled SELL series with confirmed LH swings (lookback=3):
 * - prior high @4 = 1020
 * - swing high @10 = 1010 (LH)
 * - impulse / swing low @16 = 1000 (~5 ATR with atr=2)
 * - rejection @39 pulls back to slow EMA ~1004.5 and closes below, well above swing low
 */
function buildSellSeries(opts: {
  last?: { o: number; h: number; l: number; c: number };
  longEma?: number;
  slowEma?: number;
  fastEma?: number;
  atr?: number;
  params?: Record<string, number | boolean | string>;
}): StrategyContext {
  const atr = opts.atr ?? 2;
  const longEma = opts.longEma ?? 1006;
  const slowEma = opts.slowEma ?? 1004.5;
  const fastEma = opts.fastEma ?? 1003;
  const candles: Candle[] = [];

  for (let i = 0; i < 40; i++) {
    let o = 1009 - i * 0.05;
    let c = o - 0.02;
    let h = Math.max(o, c) + 0.3;
    let l = Math.min(o, c) - 0.3;

    if (i === 4) {
      h = 1020;
      o = 1018;
      c = 1018.5;
      l = 1017;
    } else if (i >= 1 && i <= 7 && i !== 4) {
      h = Math.min(h, 1016);
    }

    if (i === 10) {
      h = 1010;
      o = 1008.5;
      c = 1008.8;
      l = 1008;
    } else if (i >= 7 && i <= 13 && i !== 10) {
      h = Math.min(h, 1008.8);
    }

    if (i === 16) {
      l = 1000;
      o = 1002;
      c = 1001.2;
      h = 1002.5;
    } else if (i >= 13 && i <= 19 && i !== 16) {
      // Keep neighbors above the impulse low so @16 confirms as a swing low.
      l = Math.max(l, 1001.5);
    }

    if (i === 39) {
      const last = opts.last ?? { o: 1004.9, h: 1005.9, l: 1003.8, c: 1004.2 };
      o = last.o;
      h = last.h;
      l = last.l;
      c = last.c;
    }

    candles.push(baseCandle(i, { o: Number(o.toFixed(3)), h: Number(h.toFixed(3)), l: Number(l.toFixed(3)), c: Number(c.toFixed(3)) }));
  }

  const features = candles.map((c) =>
    featureFixture({
      timestamp: c.closeTime,
      close: c.close,
      emaFast: fastEma,
      emaSlow: slowEma,
      emaLong: longEma,
      atr,
      adx: 28,
      rsi: 45,
      trendDirection: -1,
      higherHighCount: 0,
      lowerLowCount: 2,
      donchianHigh: 1021,
      donchianLow: 999
    })
  );

  return {
    candles,
    features,
    regime: regimeFixture({ timestamp: candles[39]!.closeTime, regime: "STRONG_DOWNTREND" }),
    parameters: {
      ...TREND_STRUCTURE_PULLBACK_DEFAULTS,
      minTargetRoomR: 0.5,
      maxImpulseDistanceAtr: 5,
      ...(opts.params ?? {})
    },
    candlesSinceLastSignal: Number.POSITIVE_INFINITY
  };
}

describe("structureSwings", () => {
  it("only returns pivots confirmed without lookahead", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const base = 100 + i;
      candles.push(
        baseCandle(i, {
          o: base,
          h: i === 10 ? 130 : base + 1,
          l: i === 5 ? 80 : base - 1,
          c: base
        })
      );
    }
    // flatten neighbors so 5/10 are true fractals
    for (const i of [2, 3, 4, 6, 7, 8]) {
      candles[i]!.low = 90;
      candles[i]!.high = 110;
    }
    for (const i of [7, 8, 9, 11, 12, 13]) {
      candles[i]!.high = 120;
      candles[i]!.low = 95;
    }
    candles[5]!.low = 80;
    candles[10]!.high = 130;

    const at19 = findConfirmedSwingPivots(candles, 19, 3);
    expect(at19.some((p) => p.index === 10 && p.kind === "high")).toBe(true);
    expect(at19.some((p) => p.index === 5 && p.kind === "low")).toBe(true);
    const at17 = findConfirmedSwingPivots(candles, 17, 3);
    expect(at17.every((p) => p.index <= 14)).toBe(true);
  });
});

describe("TrendStructurePullbackStrategy", () => {
  const strategy = new TrendStructurePullbackStrategy();

  it("fixture confirms expected swing low for BUY path", () => {
    const ctx = buildBuySeries({});
    const pivots = findConfirmedSwingPivots(ctx.candles, 39, 3);
    expect(pivots.some((p) => p.kind === "low" && p.index === 10)).toBe(true);
  });

  it("signals BUY on a healthy pullback", () => {
    const decision = strategy.evaluate(buildBuySeries({}));
    expect(decision.action).toBe("BUY");
    expect(decision.strategyId).toBe("trend-structure-pullback-v1");
    expect(Number(decision.metadata?.pullbackDepthAtr)).toBeGreaterThanOrEqual(0.4);
  });

  it("signals SELL on a healthy pullback", () => {
    const decision = strategy.evaluate(buildSellSeries({}));
    expect(decision.action).toBe("SELL");
    expect(decision.strategyId).toBe("trend-structure-pullback-v1");
  });

  it("rejects BUY for excessive extension from long EMA", () => {
    const decision = strategy.evaluate(buildBuySeries({ longEma: 980 })); // close~995.8 → ~7.9 ATR
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toContain("EXTENDED_FROM_LONG_EMA");
  });

  it("rejects SELL for excessive extension from long EMA", () => {
    const decision = strategy.evaluate(buildSellSeries({ longEma: 1020 }));
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toContain("EXTENDED_FROM_LONG_EMA");
  });

  it("rejects shallow pullbacks", () => {
    const decision = strategy.evaluate(
      buildBuySeries({
        last: { o: 995.5, h: 996.1, l: 995.4, c: 995.8 },
        slowEma: 995.5,
        fastEma: 996,
        longEma: 994
      })
    );
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toMatch(
      /PULLBACK_TOO_SHALLOW|NEAR_RECENT_SWING_EXTREME|CONTINUATION_CANDLE_WEAK|TARGET_ROOM/
    );
  });

  it("rejects near recent swing extreme", () => {
    const decision = strategy.evaluate(
      buildBuySeries({
        last: { o: 995.5, h: 996.2, l: 993.2, c: 995.9 },
        slowEma: 993.5,
        fastEma: 995,
        longEma: 992,
        params: { maxNearSwingExtremeAtr: 1.5, minTargetRoomR: 0.5, maxImpulseDistanceAtr: 8 }
      })
    );
    expect(decision.action).toBe("HOLD");
    expect(decision.action).not.toBe("BUY");
  });

  it("does not incorrectly reject a healthy pullback under default params", () => {
    expect(strategy.evaluate(buildBuySeries({})).action).toBe("BUY");
    expect(strategy.evaluate(buildSellSeries({})).action).toBe("SELL");
  });

  it("rejects weak rejection candles", () => {
    const decision = strategy.evaluate(
      buildBuySeries({
        // Closes back above EMA but with negligible rejection wick.
        last: { o: 993.6, h: 995.0, l: 993.55, c: 994.8 }
      })
    );
    expect(decision.action).toBe("HOLD");
    expect(decision.invalidationReason.join(" ")).toContain("CONTINUATION_CANDLE_WEAK");
  });

  it("is deterministic for identical context", () => {
    const ctx = buildBuySeries({});
    expect(strategy.evaluate(ctx)).toEqual(strategy.evaluate(ctx));
  });

  it("does not mutate ema-pullback-v1 behavior or identity", () => {
    const ema = new EmaPullbackStrategy();
    expect(ema.id).toBe("ema-pullback-v1");
    expect(strategy.id).toBe("trend-structure-pullback-v1");
    expect(EMA_PULLBACK_DEFAULTS.pullbackEma).toBe("fast");
    expect(TREND_STRUCTURE_PULLBACK_DEFAULTS.pullbackEma).toBe("slow");
  });

  it("emits entry-quality telemetry fields on signals", () => {
    const ctx = buildBuySeries({});
    const decision = strategy.evaluate(ctx);
    expect(decision.action).toBe("BUY");
    const tel = buildEntryFeatureTelemetry({
      feature: ctx.features[39]!,
      candle: ctx.candles[39]!,
      decision,
      regime: "STRONG_UPTREND",
      regimeConfidence: 0.8
    });
    expect(tel.extensionAtr).not.toBeNull();
    expect(tel.pullbackDepthAtr).not.toBeNull();
    expect(tel.impulseDistanceAtr).not.toBeNull();
    expect(tel.structureState).toBe("BULLISH_HL");
  });

  it("strategy evaluate is pure — does not alter risk/execution state objects", () => {
    const ctx = buildBuySeries({});
    const before = JSON.stringify(ctx.parameters);
    strategy.evaluate(ctx);
    expect(JSON.stringify(ctx.parameters)).toBe(before);
  });
});

describe("proposeTrendStructurePullbackStopTarget", () => {
  it("dispatches via proposeCfdStopTarget for trend-structure-pullback-v1", () => {
    const proposal = proposeCfdStopTarget({
      strategyId: "trend-structure-pullback-v1",
      direction: "BUY",
      entryPrice: 1000,
      features: featureFixture({ atr: 4 }),
      candles: [baseCandle(0, { o: 1000, h: 1001, l: 995, c: 1000 })],
      tickSize: 0.001,
      metadata: { pullbackLow: 995 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBeLessThan(1000);
    expect(proposal!.initialRiskReward).toBe(2);
  });

  it("mirrors structure-stop geometry for SELL", () => {
    const proposal = proposeTrendStructurePullbackStopTarget({
      direction: "SELL",
      entryPrice: 1000,
      features: featureFixture({ atr: 4 }),
      candles: [baseCandle(0, { o: 1000, h: 1005, l: 999, c: 1000 })],
      metadata: { pullbackHigh: 1005 },
      params: { tickSize: 0.001 }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBeGreaterThan(1000);
  });
});
