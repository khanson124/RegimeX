import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  TREND_STRUCTURE_PULLBACK_V2_DEFAULTS,
  TrendStructurePullbackV2Strategy,
  classifyEntryQualityIntersection
} from "./trendStructurePullbackV2.js";
import { TrendStructurePullbackStrategy } from "./trendStructurePullback.js";
import { EmaPullbackStrategy } from "./emaPullback.js";
import { featureFixture, regimeFixture } from "../testing/fixtures.js";
import { type StrategyContext } from "./types.js";
import { buildEntryFeatureTelemetry } from "../research/entryFeatureTelemetry.js";
import { isCfdCapableStrategy } from "./cfdCapability.js";

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

    candles.push(
      baseCandle(i, {
        o: Number(o.toFixed(3)),
        h: Number(h.toFixed(3)),
        l: Number(l.toFixed(3)),
        c: Number(c.toFixed(3))
      })
    );
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
      ...TREND_STRUCTURE_PULLBACK_V2_DEFAULTS,
      minTargetRoomR: 0.5,
      maxImpulseDistanceAtr: 5,
      ...(opts.params ?? {})
    },
    candlesSinceLastSignal: Number.POSITIVE_INFINITY
  };
}

function buildSellSeries(opts: {
  last?: { o: number; h: number; l: number; c: number };
  longEma?: number;
  params?: Record<string, number | boolean | string>;
}): StrategyContext {
  const atr = 2;
  const longEma = opts.longEma ?? 1006;
  const slowEma = 1004.5;
  const fastEma = 1003;
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
      l = Math.max(l, 1001.5);
    }

    if (i === 39) {
      const last = opts.last ?? { o: 1004.9, h: 1005.9, l: 1003.8, c: 1004.2 };
      o = last.o;
      h = last.h;
      l = last.l;
      c = last.c;
    }

    candles.push(
      baseCandle(i, {
        o: Number(o.toFixed(3)),
        h: Number(h.toFixed(3)),
        l: Number(l.toFixed(3)),
        c: Number(c.toFixed(3))
      })
    );
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
      ...TREND_STRUCTURE_PULLBACK_V2_DEFAULTS,
      minTargetRoomR: 0.5,
      maxImpulseDistanceAtr: 5,
      ...(opts.params ?? {})
    },
    candlesSinceLastSignal: Number.POSITIVE_INFINITY
  };
}

describe("TrendStructurePullbackV2Strategy", () => {
  const strategy = new TrendStructurePullbackV2Strategy();

  it("signals BUY on healthy pullback", () => {
    const d = strategy.evaluate(buildBuySeries({}));
    expect(d.action).toBe("BUY");
    expect(d.strategyId).toBe("trend-structure-pullback-v2");
    expect(d.metadata?.finalEntryQualityDecision).toBe("ACCEPT");
  });

  it("signals SELL on healthy pullback", () => {
    expect(strategy.evaluate(buildSellSeries({})).action).toBe("SELL");
  });

  it("accepts deep healthy pullback after moderate extension (contextual)", () => {
    // close~995, longEma 988 → ~3.5 ATR extension (soft 2.5, hard 5) with deep pullback from 996.
    const d = strategy.evaluate(
      buildBuySeries({
        longEma: 988,
        last: { o: 994.4, h: 995.5, l: 993.0, c: 995.0 },
        params: { softExtensionAtr: 2.5, hardExtremeExtensionAtr: 5, minPullbackDepthAtr: 0.3 }
      })
    );
    expect(d.action).toBe("BUY");
    const codes = d.metadata?.allEntryQualityReasonCodes as string[];
    expect(codes).toContain("EXTENDED_SOFT");
    expect(codes).not.toContain("EXTENDED_AND_SHALLOW");
  });

  it("rejects shallow chase when extended", () => {
    const d = strategy.evaluate(
      buildBuySeries({
        longEma: 988,
        // Tiny pause near highs while ~4 ATR above long EMA.
        last: { o: 995.7, h: 996.0, l: 995.65, c: 995.85 },
        slowEma: 995.5,
        fastEma: 996
      })
    );
    expect(d.action).toBe("HOLD");
    const codes = (d.metadata?.allEntryQualityReasonCodes as string[]) ?? [];
    expect(
      codes.some(
        (c) =>
          c === "EXTENDED_AND_SHALLOW" ||
          c === "PULLBACK_TOO_SHALLOW" ||
          c === "CONTINUATION_CANDLE_WEAK"
      )
    ).toBe(true);
    expect(codes).toContain("EXTENDED_SOFT");
  });

  it("hard-rejects extreme extension even with pullback", () => {
    const d = strategy.evaluate(buildBuySeries({ longEma: 970 })); // ~12.5 ATR
    expect(d.action).toBe("HOLD");
    expect((d.metadata?.allEntryQualityReasonCodes as string[]).join(" ")).toContain(
      "EXTENDED_FROM_LONG_EMA"
    );
  });

  it("collects all applicable reason codes (order-independent diagnostics)", () => {
    const d = strategy.evaluate(
      buildBuySeries({
        longEma: 988,
        last: { o: 995.5, h: 996.1, l: 995.4, c: 995.8 },
        slowEma: 995.5,
        fastEma: 996
      })
    );
    expect(d.action).toBe("HOLD");
    const codes = d.metadata?.allEntryQualityReasonCodes as string[];
    expect(codes.length).toBeGreaterThan(1);
    expect(d.metadata?.entryQualityIntersection).toBeTruthy();
    expect(d.metadata?.finalEntryQualityDecision).toBe("REJECT");
  });

  it("classifyEntryQualityIntersection is deterministic", () => {
    expect(classifyEntryQualityIntersection(["EXTENDED_SOFT", "PULLBACK_TOO_SHALLOW"], false)).toBe(
      "EXTENDED_AND_SHALLOW"
    );
    expect(classifyEntryQualityIntersection(["STRUCTURE_NOT_CONFIRMED"], false)).toBe(
      "STRUCTURE_FAIL_ONLY"
    );
    expect(classifyEntryQualityIntersection(["EXTENDED_SOFT"], true)).toBe("ACCEPTED");
  });

  it("is deterministic for identical context", () => {
    const ctx = buildBuySeries({});
    expect(strategy.evaluate(ctx)).toEqual(strategy.evaluate(ctx));
  });

  it("preserves v1 and ema-pullback identities", () => {
    expect(new TrendStructurePullbackStrategy().id).toBe("trend-structure-pullback-v1");
    expect(new EmaPullbackStrategy().id).toBe("ema-pullback-v1");
    expect(strategy.id).toBe("trend-structure-pullback-v2");
    expect(isCfdCapableStrategy("trend-structure-pullback-v2")).toBe(true);
  });

  it("emits v2 telemetry score fields", () => {
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
    expect(tel.entryQualityScore).not.toBeNull();
    expect(tel.extensionPenalty).not.toBeNull();
    expect(tel.pullbackQualityScore).not.toBeNull();
    expect(tel.finalEntryQualityDecision).toBe("ACCEPT");
  });

  it("evaluate does not mutate parameters", () => {
    const ctx = buildBuySeries({});
    const before = JSON.stringify(ctx.parameters);
    strategy.evaluate(ctx);
    expect(JSON.stringify(ctx.parameters)).toBe(before);
  });
});
