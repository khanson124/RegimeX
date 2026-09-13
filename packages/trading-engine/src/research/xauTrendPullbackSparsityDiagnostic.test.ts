import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import {
  classifySampleSize,
  maxDrawdownR,
  recommendSingleModestChange,
  runXauTrendPullbackFunnelDiagnostic,
  type AblationRow,
  type FunnelDiagnosticResult
} from "./xauTrendPullbackSparsityDiagnostic.js";
import { XAU_TREND_PULLBACK_DEFAULTS } from "../strategies/xauTrendPullback.js";
import { type CfdSimulatedTrade } from "../backtest/cfdMetrics.js";

function bar(i: number, px: number, base = Date.UTC(2025, 5, 2, 8, 0, 0)): Candle {
  const openTime = base + i * 60_000;
  return {
    symbol: "XAUUSD",
    interval: "1m",
    openTime,
    closeTime: openTime + 60_000,
    open: px,
    high: px + 0.5,
    low: px - 0.5,
    close: px + 0.05,
    tickCount: 4,
    isComplete: true,
    source: "HISTORY_API"
  };
}

describe("xau-trend-pullback sparsity diagnostic helpers", () => {
  it("classifies sample-size labels", () => {
    expect(classifySampleSize(10)).toBe("TOO_SPARSE");
    expect(classifySampleSize(50)).toBe("LOW_SAMPLE");
    expect(classifySampleSize(100)).toBe("USABLE_FOR_RESEARCH");
    expect(classifySampleSize(200)).toBe("GOOD_SAMPLE");
  });

  it("computes max drawdown in R from cumulative netR", () => {
    const trades = [
      { netR: 1 },
      { netR: -0.5 },
      { netR: -1 },
      { netR: 0.5 }
    ] as CfdSimulatedTrade[];
    expect(maxDrawdownR(trades)).toBe(1.5);
  });

  it("funnel returns ordered stages and no H4 lookahead on synthetic series", () => {
    const candles: Candle[] = [];
    let px = 1800;
    for (let i = 0; i < 12_000; i++) {
      px += 0.1;
      candles.push(bar(i, px));
    }
    const funnel = runXauTrendPullbackFunnelDiagnostic(candles, {
      ...XAU_TREND_PULLBACK_DEFAULTS,
      adxMinimum: 0,
      atrPercentileMin: 0,
      atrPercentileMax: 1,
      sessionStartHourUtc: 0,
      sessionEndHourUtc: 24,
      h4MinFillRatio: 0.15
    });
    expect(funnel.totalM15Bars).toBeGreaterThan(0);
    expect(funnel.stages[0]!.stage).toBe("m15_bars");
    expect(funnel.stages.at(-1)!.stage).toBe("final_signal");
    for (let i = 1; i < funnel.stages.length; i++) {
      expect(funnel.stages[i]!.count).toBeLessThanOrEqual(funnel.stages[i - 1]!.count);
    }
    expect(funnel.alignmentAudit.closedH4Only).toBe(true);
    expect(funnel.alignmentAudit.noFutureH4LeakObserved).toBe(true);
    for (const ex of funnel.alignmentAudit.examples) {
      expect(ex.h4CloseBeforeM15).toBe(true);
    }
  });

  it("recommendSingleModestChange prefers material sample lift without holdout", () => {
    const baseline: AblationRow = {
      variantId: "baseline",
      family: "baseline",
      changeDescription: "baseline",
      params: {},
      sampleSizeLabel: "TOO_SPARSE",
      developmentTrades: 34,
      expectancyR: 0.05,
      profitFactor: 1.1,
      netR: 1.7,
      maxDrawdownR: 3,
      winRate: 0.44,
      buyTrades: 20,
      sellTrades: 14,
      costSensitivity: null,
      funnelFinalSignals: 40
    };
    const better: AblationRow = {
      ...baseline,
      variantId: "atr_10_90",
      family: "atr_percentile",
      changeDescription: "ATR pctl 10–90",
      params: { atrPercentileMin: 0.1, atrPercentileMax: 0.9 },
      sampleSizeLabel: "LOW_SAMPLE",
      developmentTrades: 62,
      expectancyR: 0.04,
      costSensitivity: [
        {
          id: "OBSERVED_SPREAD_ONLY",
          label: "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST",
          costKind: "EMPIRICAL_OBSERVED_SPREAD_ONLY",
          trades: 62,
          expectancyR: 0.03,
          profitFactor: 1.05,
          netR: 1.8,
          maxDrawdownR: 4
        },
        {
          id: "ASSUMED_SLIP_0_25",
          label: "ASSUMED",
          costKind: "MODELED_HYPOTHETICAL_SLIPPAGE_NOT_EMPIRICAL",
          trades: 62,
          expectancyR: 0.01,
          profitFactor: 1.02,
          netR: 0.6,
          maxDrawdownR: 4.2
        }
      ]
    };
    const funnel = {
      primaryBottlenecks: [
        { stage: "continuation_detected", dropFromPrevious: 100, dropPct: 80 }
      ]
    } as FunnelDiagnosticResult;
    const rec = recommendSingleModestChange({
      baseline,
      ablations: [baseline, better],
      funnel
    });
    expect(rec.recommendedVariantId).toBe("atr_10_90");
    expect(rec.architectureTooRestrictive).toBe(false);
  });

  it("recommendSingleModestChange reports architecture too restrictive when no lift", () => {
    const baseline: AblationRow = {
      variantId: "baseline",
      family: "baseline",
      changeDescription: "baseline",
      params: {},
      sampleSizeLabel: "TOO_SPARSE",
      developmentTrades: 34,
      expectancyR: 0.05,
      profitFactor: 1.1,
      netR: 1.7,
      maxDrawdownR: 3,
      winRate: 0.44,
      buyTrades: 20,
      sellTrades: 14,
      costSensitivity: null,
      funnelFinalSignals: 40
    };
    const worse: AblationRow = {
      ...baseline,
      variantId: "adx_25",
      family: "adx",
      changeDescription: "ADX >= 25",
      params: { adxMinimum: 25 },
      developmentTrades: 20,
      expectancyR: -0.2
    };
    const rec = recommendSingleModestChange({
      baseline,
      ablations: [baseline, worse],
      funnel: {
        primaryBottlenecks: [
          { stage: "pullback_detected", dropFromPrevious: 200, dropPct: 70 }
        ]
      } as FunnelDiagnosticResult
    });
    expect(rec.recommendedVariantId).toBeNull();
    expect(rec.architectureTooRestrictive).toBe(true);
  });
});
