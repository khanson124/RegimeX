/**
 * Unit tests for xau-trend-breakout-v2 helpers + strategy gates.
 */
import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { extractFeatures } from "../features/featureExtractor.js";
import { assertProductionIntervalsUnchanged } from "../research/researchCandleInterval.js";
import { closesCompletedHtfBucket } from "./mtfResampleAsOf.js";
import { parseCsvAllowlist } from "../broker/mt5/engineRollout.js";
import { CFD_CAPABLE_STRATEGY_IDS, isCfdCapableStrategy } from "./cfdCapability.js";
import { classifyH4TrendBias, isWithinUtcSessionHours } from "./xauTrendPullbackHtf.js";
import {
  computeConsolidationRange,
  evaluateConsolidationBreakout
} from "./xauTrendBreakoutV2Consolidation.js";
import {
  XauTrendBreakoutV2Strategy,
  XAU_TREND_BREAKOUT_V2_DEFAULTS
} from "./xauTrendBreakoutV2.js";
import { proposeXauTrendBreakoutV2StopTarget } from "./xauTrendBreakoutV2Cfd.js";
import { type StrategyContext } from "./types.js";
import {
  classifyBreakoutV2Architecture,
  classifySampleSize
} from "../research/xauTrendBreakoutV2Research.js";
import { XAU_TREND_PULLBACK_DEFAULTS } from "./xauTrendPullback.js";
function m15Bar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  base = Date.UTC(2025, 5, 2, 10, 0, 0)
): Candle {
  const openTime = base + i * 15 * 60_000;
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime,
    closeTime: openTime + 15 * 60_000,
    open: o,
    high: h,
    low: l,
    close: c,
    tickCount: 20,
    isComplete: true,
    source: "HISTORY_API"
  };
}

function h4Bar(i: number, close: number): Candle {
  const openTime = Date.UTC(2025, 0, 1) + i * 4 * 60 * 60_000;
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime,
    closeTime: openTime + 4 * 60 * 60_000,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    tickCount: 100,
    isComplete: true,
    source: "HISTORY_API"
  };
}

function ctxOf(
  candles: Candle[],
  params: Record<string, unknown> = {},
  candlesSinceLastSignal = Number.POSITIVE_INFINITY
): StrategyContext {
  return {
    candles,
    features: extractFeatures(candles),
    regime: {
      regime: "STRONG_UPTREND",
      confidence: 0.7,
      scores: { trend: 80, momentum: 60, volatility: 40, range: 50, breakout: 40 },
      reasons: [],
      timestamp: candles[candles.length - 1]!.closeTime,
      classifierVersion: "test"
    },
    parameters: { ...XAU_TREND_BREAKOUT_V2_DEFAULTS, ...params } as Record<
      string,
      number | boolean | string
    >,
    candlesSinceLastSignal
  };
}

describe("xau-trend-breakout-v2 consolidation / breakout", () => {
  it("detects consolidation range excluding breakout bar", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 12; i++) {
      bars.push(m15Bar(i, 2000, 2002, 1998, 2001));
    }
    bars.push(m15Bar(12, 2001, 2008, 2000, 2007)); // breakout
    const range = computeConsolidationRange(bars, 12, 12, 2);
    expect(range).not.toBeNull();
    expect(range!.high).toBe(2002);
    expect(range!.low).toBe(1998);
    expect(range!.endIndex).toBe(11);
  });

  it("detects bullish breakout with quality and rejects exhaustion", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 12; i++) {
      bars.push(m15Bar(i, 2000, 2002, 1998, 2000.5));
    }
    const good = [...bars, m15Bar(12, 2001, 2004, 2000.5, 2003.5)];
    const ok = evaluateConsolidationBreakout({
      m15: good,
      barIndex: 12,
      bias: "BULLISH",
      atr: 2,
      lookback: 12,
      minWidthAtr: 0.4,
      maxWidthAtr: 3.5,
      minBreakoutDistanceAtr: 0.1,
      maxBreakoutCandleRangeAtr: 2,
      minBreakoutBodyAtr: 0.05
    });
    expect(ok.breakout).toBe(true);
    expect(ok.qualityPass).toBe(true);
    expect(ok.direction).toBe("BUY");

    const exhaust = [...bars, m15Bar(12, 2001, 2012, 2000, 2011)];
    const bad = evaluateConsolidationBreakout({
      m15: exhaust,
      barIndex: 12,
      bias: "BULLISH",
      atr: 2,
      lookback: 12,
      minWidthAtr: 0.4,
      maxWidthAtr: 3.5,
      minBreakoutDistanceAtr: 0.1,
      maxBreakoutCandleRangeAtr: 2,
      minBreakoutBodyAtr: 0.05
    });
    expect(bad.breakout).toBe(true);
    expect(bad.qualityPass).toBe(false);
    expect(bad.reasons).toContain("EXHAUSTION_CANDLE");
  });

  it("rejects tiny breakout distance", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 12; i++) bars.push(m15Bar(i, 2000, 2002, 1998, 2000));
    bars.push(m15Bar(12, 2001.9, 2002.3, 2001.8, 2002.15));
    const snap = evaluateConsolidationBreakout({
      m15: bars,
      barIndex: 12,
      bias: "BULLISH",
      atr: 2,
      lookback: 12,
      minWidthAtr: 0.4,
      maxWidthAtr: 3.5,
      minBreakoutDistanceAtr: 0.1,
      maxBreakoutCandleRangeAtr: 2,
      minBreakoutBodyAtr: 0.05
    });
    expect(snap.breakout).toBe(true);
    expect(snap.qualityPass).toBe(false);
    expect(snap.reasons).toContain("BREAKOUT_DISTANCE_TOO_SMALL");
  });
});

describe("H4 bias + session + sample labels", () => {
  it("classifies H4 bullish / bearish and session boundaries", () => {
    assertProductionIntervalsUnchanged();
    expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
    const up = Array.from({ length: 80 }, (_, i) => h4Bar(i, 1800 + i * 3));
    expect(classifyH4TrendBias(up).bias).toBe("BULLISH");
    const down = Array.from({ length: 80 }, (_, i) => h4Bar(i, 2200 - i * 3));
    expect(classifyH4TrendBias(down).bias).toBe("BEARISH");
    const t = Date.UTC(2026, 0, 5, 7, 0, 0);
    expect(isWithinUtcSessionHours(t, 7, 17)).toBe(true);
    expect(isWithinUtcSessionHours(Date.UTC(2026, 0, 5, 17, 0, 0), 7, 17)).toBe(false);
    expect(classifySampleSize(40)).toBe("TOO_SPARSE");
    expect(classifySampleSize(120)).toBe("USABLE_FOR_RESEARCH");
  });

  it("defaults favor simpler architecture (no mandatory ADX)", () => {
    expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.adxMinimum).toBe(0);
    expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.atrPercentileMin).toBe(0.1);
    expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.atrPercentileMax).toBe(0.9);
    expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.entryMode).toBe("immediate");
    expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.consolidationLookback).toBe(12);
    // pullback v1 untouched
    expect(XAU_TREND_PULLBACK_DEFAULTS.adxMinimum).toBe(20);
  });

  it("is CFD-capable research-only, not allowlisted", () => {
    expect(isCfdCapableStrategy("xau-trend-breakout-v2")).toBe(true);
    expect(CFD_CAPABLE_STRATEGY_IDS).toContain("xau-trend-breakout-v2");
    expect(parseCsvAllowlist("")).not.toContain("xau-trend-breakout-v2");
    expect(parseCsvAllowlist("")).not.toContain("XAUUSD");
  });
});

describe("strategy HOLD / CFD proposal / architecture gate", () => {
  it("HOLDs off M15 close and during cooldown", () => {
    const strategy = new XauTrendBreakoutV2Strategy();
    class Short extends XauTrendBreakoutV2Strategy {
      override readonly minimumHistory = 200;
    }
    const s = new Short();
    const bars = Array.from({ length: 250 }, (_, i) => {
      const px = 2000 + i * 0.05;
      const openTime = Date.UTC(2025, 5, 2, 10, 0, 0) + i * 60_000;
      return {
        symbol: "XAUUSD",
        interval: "1m" as const,
        openTime,
        closeTime: openTime + 60_000,
        open: px,
        high: px + 0.4,
        low: px - 0.4,
        close: px,
        tickCount: 4,
        isComplete: true,
        source: "HISTORY_API" as const
      };
    });
    // not M15 close
    const mid = bars.slice(0, 100);
    const d1 = s.evaluate(ctxOf(mid));
    expect(d1.action).toBe("HOLD");
    let end = bars.length - 1;
    while (end > 0 && !closesCompletedHtfBucket(bars, end, "15m")) end--;
    const d2 = s.evaluate(ctxOf(bars.slice(0, end + 1), {}, 5));
    expect(d2.action).toBe("HOLD");
    expect(d2.metadata?.entryQualityReasonCodes).toContain("COOLDOWN_ACTIVE");
    expect(strategy.id).toBe("xau-trend-breakout-v2");
  });

  it("proposes CFD stop/target from metadata", () => {
    const feat = extractFeatures([
      m15Bar(0, 2000, 2001, 1999, 2000),
      m15Bar(1, 2000, 2005, 1999, 2004)
    ])[1]!;
    const proposal = proposeXauTrendBreakoutV2StopTarget({
      direction: "BUY",
      entryPrice: 2004,
      features: { ...feat, atr: 5 },
      candles: [m15Bar(0, 2000, 2001, 1999, 2000), m15Bar(1, 2000, 2005, 1999, 2004)],
      metadata: {
        stopLoss: 1990,
        takeProfit: 2032,
        intendedR: 2,
        consolidationLow: 1995
      }
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.stopLoss).toBeLessThan(2004);
    expect(proposal!.riskRewardRatio).toBe(2);
  });

  it("classifies continued-research gate without DEMO promotion", () => {
    const ok = classifyBreakoutV2Architecture({
      developmentTrades: 80,
      expectancyRObserved: 0.1,
      profitFactorObserved: 1.3,
      maxDrawdownR: 8,
      survivesModestSlip: true,
      weekDominanceShare: 0.3
    });
    expect(ok.meritsContinuedResearch).toBe(true);
    const sparse = classifyBreakoutV2Architecture({
      developmentTrades: 20,
      expectancyRObserved: 0.2,
      profitFactorObserved: 1.5,
      maxDrawdownR: 3,
      survivesModestSlip: true,
      weekDominanceShare: 0.2
    });
    expect(sparse.meritsContinuedResearch).toBe(false);
    expect(sparse.sampleSizeLabel).toBe("TOO_SPARSE");
  });
});
