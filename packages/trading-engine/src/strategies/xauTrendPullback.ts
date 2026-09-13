/**
 * xau-trend-pullback-v1 — XAUUSD H4 bias + M15 pullback/breakout.
 *
 * Live/DEMO entry interval: native 15m only.
 * Live broker_demo_mt5 prefers native MT5 H4 context candles when provided.
 * Research backtests may still evaluate on a 1m series (signals only on completed M15 closes)
 * and aggregate H4 from the evaluation series when contextCandles are absent.
 */
import { z } from "zod";
import {
  type MarketRegime,
  type StrategyDecision,
  type StrategyEligibility
} from "@regimex/shared";
import { extractFeatures } from "../features/featureExtractor.js";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";
import { completedHtfBarsAsOf, closesCompletedHtfBucket } from "./mtfResampleAsOf.js";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind
} from "./structureSwings.js";
import {
  atrPercentileAtEnd,
  classifyH4TrendBias,
  completedSessionAwareHtfBarsAsOf,
  emaSeries,
  isWithinUtcSessionHours,
  type H4TrendBias
} from "./xauTrendPullbackHtf.js";
import { sessionContextFromEpochMs } from "./xauMtfEntryQuality.js";
import {
  XAU_TREND_PULLBACK_H4_MINIMUM_BARS,
  XAU_TREND_PULLBACK_M15_MINIMUM_BARS,
  completedContextBarsAsOf,
  type MultiTimeframeWarmupSpec
} from "../candles/mt5MtfWarmup.js";

export const XAU_TREND_PULLBACK_REASON_CODES = [
  "INSUFFICIENT_HISTORY",
  "INSUFFICIENT_H4_CONTEXT",
  "COOLDOWN_ACTIVE",
  "NOT_M15_CLOSE",
  "UNSUPPORTED_EXECUTION_INTERVAL",
  "H4_NEUTRAL",
  "ADX_BELOW_MINIMUM",
  "OUTSIDE_SESSION",
  "ATR_PERCENTILE_OUT_OF_RANGE",
  "SPREAD_TOO_WIDE",
  "NO_PULLBACK",
  "EXTENDED_FROM_EMA",
  "NO_CONTINUATION_TRIGGER",
  "INDICATORS_UNAVAILABLE",
  "STOP_INVALID"
] as const;

export type XauTrendPullbackReasonCode = (typeof XAU_TREND_PULLBACK_REASON_CODES)[number];

const parametersSchema = z.object({
  h4SlopeLookback: z.number().int().min(1).max(10).default(3),
  adxMinimum: z.number().min(0).max(50).default(20),
  atrPercentileLookback: z.number().int().min(20).max(500).default(100),
  atrPercentileMin: z.number().min(0).max(1).default(0.2),
  atrPercentileMax: z.number().min(0).max(1).default(0.85),
  sessionStartHourUtc: z.number().min(0).max(24).default(7),
  sessionEndHourUtc: z.number().min(0).max(24).default(17),
  maxDistanceFromEma21Atr: z.number().min(0.5).max(6).default(2.5),
  pullbackTouchAtr: z.number().min(0.05).max(2).default(0.6),
  swingLookback: z.number().int().min(2).max(5).default(2),
  minContinuationBodyAtr: z.number().min(0).max(1).default(0.1),
  stopAtrMultiple: z.number().min(0.5).max(4).default(1.5),
  targetRMultiple: z.number().min(1).max(4).default(2),
  structureBufferAtr: z.number().min(0).max(1).default(0.15),
  /**
   * Cooldown after a signal, in M15 candles.
   * On native 15m this is bars directly; on the 1m research series it is ×15.
   */
  cooldownCandles: z.number().int().min(0).max(200).default(4),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  /** Optional live/research spread gate (bps). -1 = disabled (use cost profiles instead). */
  maxSpreadBps: z.number().min(-1).max(50).default(-1),
  maxSpreadVsMedianMult: z.number().min(1).max(5).default(2),
  h4MinFillRatio: z.number().min(0.1).max(1).default(0.25),
  /**
   * Research ablation only. Production default remains "either".
   * Does not change live/demo allowlists or deployed configs.
   */
  continuationMode: z.enum(["either", "breakout_only", "reclaim_only"]).default("either")
});

export type XauTrendPullbackParams = z.infer<typeof parametersSchema>;

export const XAU_TREND_PULLBACK_DEFAULTS: XauTrendPullbackParams = parametersSchema.parse({});

export const XAU_TREND_PULLBACK_SENSITIVITY_RANGES = {
  adxMinimum: [15, 20, 25] as const,
  stopAtrMultiple: [1.25, 1.5, 2] as const,
  targetRMultiple: [1.5, 2, 2.5] as const,
  maxDistanceFromEma21Atr: [1.5, 2.5, 3.5] as const
};

const SUPPORTED: MarketRegime[] = [
  "STRONG_UPTREND",
  "WEAK_UPTREND",
  "STRONG_DOWNTREND",
  "WEAK_DOWNTREND",
  "BREAKOUT_EXPANSION",
  "VOLATILITY_COMPRESSION",
  "RANGE_LOW_VOLATILITY",
  "RANGE_HIGH_VOLATILITY",
  "TRANSITION",
  "UNKNOWN"
];

function holdWith(
  strategy: TradingStrategy,
  ts: number,
  codes: XauTrendPullbackReasonCode[],
  telemetry: Record<string, unknown>
): StrategyDecision {
  const decision = holdDecision(strategy, ts, codes);
  return {
    ...decision,
    metadata: {
      ...(decision.metadata ?? {}),
      entryQualityReasonCodes: codes,
      ...telemetry
    }
  };
}

function nearEma(price: number, ema: number, atr: number, touchAtr: number): boolean {
  return Math.abs(price - ema) <= atr * touchAtr;
}

export class XauTrendPullbackStrategy implements TradingStrategy {
  readonly id = "xau-trend-pullback-v1";
  readonly name = "XAU Trend Pullback v1";
  readonly kind = "xau-trend-pullback" as const;
  readonly version = "1.0.0";
  readonly displayName = "XAU Trend Pullback v1";
  readonly description =
    "XAUUSD H4 EMA trend bias with M15 pullback/breakout continuation (live entry on native 15m).";
  readonly supportedRegimes = SUPPORTED;
  /** Live/DEMO execution interval — research may still feed 1m series into evaluate(). */
  readonly allowedIntervals = ["15m"] as const;
  /**
   * M15 entry warm-up only (derived from ATR/ADX/EMA/percentile/structure lookbacks).
   * H4 context is a separate MTF requirement — not manufactured from M15 count.
   */
  readonly minimumHistory: number = XAU_TREND_PULLBACK_M15_MINIMUM_BARS;
  readonly multiTimeframeWarmup: MultiTimeframeWarmupSpec = {
    executionInterval: "15m",
    requirements: [
      {
        interval: "15m",
        minimumBars: XAU_TREND_PULLBACK_M15_MINIMUM_BARS,
        role: "execution"
      },
      {
        interval: "4h",
        minimumBars: XAU_TREND_PULLBACK_H4_MINIMUM_BARS,
        role: "context"
      }
    ]
  };
  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["atr", "adx", "emaFast", "emaSlow"],
    minimumHistory: XAU_TREND_PULLBACK_M15_MINIMUM_BARS,
    minimumRegimeConfidence: 0,
    minimumStrategyConfidence: 0.5,
    allowedSymbols: [],
    allowedIntervals: ["15m"],
    cooldownCandles: 4
  };

  validateParameters(raw: Record<string, unknown>): XauTrendPullbackParams {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const rawParams = context.parameters;
    const p = this.validateParameters(rawParams);
    const currentSpreadBps =
      typeof rawParams.currentSpreadBps === "number" ? rawParams.currentSpreadBps : null;
    const recentMedianSpreadBps =
      typeof rawParams.recentMedianSpreadBps === "number"
        ? rawParams.recentMedianSpreadBps
        : null;
    const candles = context.candles;
    const i = candles.length - 1;
    const candle = candles[i]!;
    const ts = candle.closeTime;
    const session = sessionContextFromEpochMs(ts);
    const interval = String(candle.interval);
    const isNative15 = interval === "15m";
    const isResearch1m = interval === "1m";

    const baseTelem = {
      hourUtc: session.hourUtc,
      session: session.session,
      strategyId: this.id,
      evaluationInterval: interval
    };

    if (!isNative15 && !isResearch1m) {
      return holdWith(this, ts, ["UNSUPPORTED_EXECUTION_INTERVAL"], baseTelem);
    }

    const requiredHistory = isNative15 ? this.minimumHistory : 10_000;
    if (candles.length < requiredHistory) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], baseTelem);
    }
    const cooldownBars = isNative15 ? p.cooldownCandles : p.cooldownCandles * 15;
    if (context.candlesSinceLastSignal < cooldownBars) {
      return holdWith(this, ts, ["COOLDOWN_ACTIVE"], {
        ...baseTelem,
        candlesSinceLastSignal: context.candlesSinceLastSignal,
        cooldownM15: p.cooldownCandles,
        cooldownBars
      });
    }
    if (isResearch1m && !closesCompletedHtfBucket(candles, i, "15m")) {
      return holdWith(this, ts, ["NOT_M15_CLOSE"], baseTelem);
    }

    const m15 = isNative15
      ? candles.slice(0, i + 1).filter((c) => c.isComplete)
      : completedHtfBarsAsOf(candles, i, "15m");

    const nativeH4All = context.contextCandles?.["4h"];
    const useNativeH4 = Array.isArray(nativeH4All) && nativeH4All.length > 0;
    const h4 = useNativeH4
      ? completedContextBarsAsOf(nativeH4All, ts)
      : completedSessionAwareHtfBarsAsOf(candles, i, "4h", {
          minFillRatio: p.h4MinFillRatio
        });

    if (useNativeH4 && h4.length < XAU_TREND_PULLBACK_H4_MINIMUM_BARS) {
      return holdWith(this, ts, ["INSUFFICIENT_H4_CONTEXT"], {
        ...baseTelem,
        h4BarCount: h4.length,
        h4Required: XAU_TREND_PULLBACK_H4_MINIMUM_BARS,
        h4ContextSource: "native_mt5_history"
      });
    }

    const biasSnap = classifyH4TrendBias(h4, { slopeLookback: p.h4SlopeLookback });
    const lastClosedH4 = h4.length > 0 ? h4[h4.length - 1]! : null;
    const telem = {
      ...baseTelem,
      h4Bias: biasSnap.bias,
      h4Ema21: biasSnap.ema21,
      h4Ema50: biasSnap.ema50,
      h4Ema21Slope: biasSnap.ema21Slope,
      h4BarCount: h4.length,
      m15BarCount: m15.length,
      lastClosedH4OpenTime: lastClosedH4?.openTime ?? null,
      lastClosedH4CloseTime: lastClosedH4?.closeTime ?? null,
      h4ContextSource: useNativeH4
        ? "native_mt5_history"
        : isNative15
          ? "aggregated_from_native_15m_closed_bars"
          : "aggregated_from_1m_closed_bars",
      h4AlignmentNote: useNativeH4
        ? "Native MT5 H4: only completed bars with closeTime <= M15 decision time; forming H4 never included."
        : "H4 bars are session-aware completed wall-clock buckets with closeTime <= as-of bar close; forming H4 never included."
    };

    if (biasSnap.bias === "NEUTRAL") {
      return holdWith(this, ts, ["H4_NEUTRAL"], { ...telem, h4Reasons: biasSnap.reasons });
    }

    if (!isWithinUtcSessionHours(ts, p.sessionStartHourUtc, p.sessionEndHourUtc)) {
      return holdWith(this, ts, ["OUTSIDE_SESSION"], telem);
    }

    if (m15.length < 80) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], telem);
    }

    const m15Feat = extractFeatures(m15);
    const feat = m15Feat[m15Feat.length - 1];
    const m15Bar = m15[m15.length - 1]!;
    if (!feat || feat.atr == null || feat.atr <= 0 || feat.emaFast == null || feat.emaSlow == null) {
      return holdWith(this, ts, ["INDICATORS_UNAVAILABLE"], telem);
    }

    if (feat.adx != null && feat.adx < p.adxMinimum) {
      return holdWith(this, ts, ["ADX_BELOW_MINIMUM"], {
        ...telem,
        adx: feat.adx,
        adxMinimum: p.adxMinimum
      });
    }

    const atrSeries = m15Feat.map((f) => f.atr);
    const atrPct = atrPercentileAtEnd(atrSeries, p.atrPercentileLookback);
    if (
      atrPct == null ||
      atrPct < p.atrPercentileMin ||
      atrPct > p.atrPercentileMax
    ) {
      return holdWith(this, ts, ["ATR_PERCENTILE_OUT_OF_RANGE"], {
        ...telem,
        atrPercentile: atrPct
      });
    }

    // Optional spread gate via research/live params (not empirical fill cost)
    if (p.maxSpreadBps >= 0 && currentSpreadBps != null) {
      const tooWideAbs = currentSpreadBps > p.maxSpreadBps;
      const tooWideRel =
        recentMedianSpreadBps != null &&
        recentMedianSpreadBps > 0 &&
        currentSpreadBps > recentMedianSpreadBps * p.maxSpreadVsMedianMult;
      if (tooWideAbs || tooWideRel) {
        return holdWith(this, ts, ["SPREAD_TOO_WIDE"], {
          ...telem,
          currentSpreadBps,
          recentMedianSpreadBps,
          spreadFilterNote: "Modeled/live spread gate — not an empirical fill cost"
        });
      }
    }

    // M15 EMA21 from closes (align with feature emaFast period 9 — use dedicated 21 for pullback)
    const m15Closes = m15.map((c) => c.close);
    const ema21s = emaSeries(m15Closes, 21);
    const ema50s = emaSeries(m15Closes, 50);
    const ema21 = ema21s[ema21s.length - 1];
    const ema50 = ema50s[ema50s.length - 1];
    if (ema21 == null || ema50 == null) {
      return holdWith(this, ts, ["INDICATORS_UNAVAILABLE"], telem);
    }

    const atr = feat.atr;
    const distEma21Atr = Math.abs(m15Bar.close - ema21) / atr;
    if (distEma21Atr > p.maxDistanceFromEma21Atr) {
      return holdWith(this, ts, ["EXTENDED_FROM_EMA"], {
        ...telem,
        distEma21Atr,
        maxDistanceFromEma21Atr: p.maxDistanceFromEma21Atr
      });
    }

    const pivots = findConfirmedSwingPivots(m15, m15.length - 1, p.swingLookback);
    const swingHigh = latestSwingOfKind(pivots, "high");
    const swingLow = latestSwingOfKind(pivots, "low");
    const prev = m15.length >= 2 ? m15[m15.length - 2]! : null;

    const touchedEma =
      nearEma(m15Bar.low, ema21, atr, p.pullbackTouchAtr) ||
      nearEma(m15Bar.low, ema50, atr, p.pullbackTouchAtr) ||
      nearEma(m15Bar.high, ema21, atr, p.pullbackTouchAtr) ||
      nearEma(m15Bar.high, ema50, atr, p.pullbackTouchAtr) ||
      (prev != null &&
        (nearEma(prev.low, ema21, atr, p.pullbackTouchAtr) ||
          nearEma(prev.high, ema21, atr, p.pullbackTouchAtr) ||
          nearEma(prev.low, ema50, atr, p.pullbackTouchAtr) ||
          nearEma(prev.high, ema50, atr, p.pullbackTouchAtr)));

    if (!touchedEma) {
      return holdWith(this, ts, ["NO_PULLBACK"], {
        ...telem,
        ema21,
        ema50,
        atrPercentile: atrPct
      });
    }

    const bodyAtr = Math.abs(m15Bar.close - m15Bar.open) / atr;
    const bias: H4TrendBias = biasSnap.bias;

    let action: "BUY" | "SELL" | null = null;
    let trigger: string | null = null;

    if (bias === "BULLISH") {
      const breakout =
        swingHigh != null && m15Bar.close > swingHigh.price && m15Bar.close > m15Bar.open;
      const reclaim =
        bodyAtr >= p.minContinuationBodyAtr &&
        m15Bar.close > ema21 &&
        (prev == null || prev.close <= ema21 || prev.low <= ema21);
      const allowBreakout = p.continuationMode === "either" || p.continuationMode === "breakout_only";
      const allowReclaim = p.continuationMode === "either" || p.continuationMode === "reclaim_only";
      if (allowBreakout && breakout) {
        action = "BUY";
        trigger = "SWING_HIGH_BREAKOUT";
      } else if (allowReclaim && reclaim) {
        action = "BUY";
        trigger = "EMA21_RECLAIM";
      }
    } else if (bias === "BEARISH") {
      const breakout =
        swingLow != null && m15Bar.close < swingLow.price && m15Bar.close < m15Bar.open;
      const reclaim =
        bodyAtr >= p.minContinuationBodyAtr &&
        m15Bar.close < ema21 &&
        (prev == null || prev.close >= ema21 || prev.high >= ema21);
      const allowBreakout = p.continuationMode === "either" || p.continuationMode === "breakout_only";
      const allowReclaim = p.continuationMode === "either" || p.continuationMode === "reclaim_only";
      if (allowBreakout && breakout) {
        action = "SELL";
        trigger = "SWING_LOW_BREAKOUT";
      } else if (allowReclaim && reclaim) {
        action = "SELL";
        trigger = "EMA21_RECLAIM";
      }
    }

    if (action == null || trigger == null) {
      return holdWith(this, ts, ["NO_CONTINUATION_TRIGGER"], {
        ...telem,
        ema21,
        atrPercentile: atrPct,
        pullbackTouched: true
      });
    }

    // Conservative stop: farther of ATR stop vs structure swing
    const buffer = atr * p.structureBufferAtr;
    let stopLoss: number;
    let pullbackExtreme: number | null = null;
    if (action === "BUY") {
      const atrStop = m15Bar.close - atr * p.stopAtrMultiple;
      const structStop =
        swingLow != null && swingLow.price < m15Bar.close ? swingLow.price - buffer : null;
      stopLoss =
        structStop != null ? Math.min(atrStop, structStop) : atrStop;
      pullbackExtreme = swingLow?.price ?? null;
      if (!(stopLoss < m15Bar.close)) {
        return holdWith(this, ts, ["STOP_INVALID"], telem);
      }
    } else {
      const atrStop = m15Bar.close + atr * p.stopAtrMultiple;
      const structStop =
        swingHigh != null && swingHigh.price > m15Bar.close ? swingHigh.price + buffer : null;
      stopLoss =
        structStop != null ? Math.max(atrStop, structStop) : atrStop;
      pullbackExtreme = swingHigh?.price ?? null;
      if (!(stopLoss > m15Bar.close)) {
        return holdWith(this, ts, ["STOP_INVALID"], telem);
      }
    }

    const risk = Math.abs(m15Bar.close - stopLoss);
    const takeProfit =
      action === "BUY"
        ? m15Bar.close + risk * p.targetRMultiple
        : m15Bar.close - risk * p.targetRMultiple;

    return {
      strategyId: this.id,
      strategyVersion: this.version,
      action,
      confidence: Math.min(0.85, p.minimumConfidence + (biasSnap.ema21Slope != null ? 0.1 : 0)),
      entryReason: [
        `H4_${bias}`,
        trigger,
        `ADX=${feat.adx?.toFixed(1) ?? "na"}`,
        `ATRpctl=${((atrPct ?? 0) * 100).toFixed(0)}`
      ],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: 16,
      expiryUnit: "m",
      signalTimestamp: ts,
      metadata: {
        h4Bias: bias,
        trigger,
        atrPercentile: atrPct,
        adx: feat.adx,
        atr,
        m15Atr: atr,
        m15Ema21: ema21,
        m15Ema50: ema50,
        stopLoss,
        takeProfit,
        intendedR: p.targetRMultiple,
        stopAtrMultiple: p.stopAtrMultiple,
        pullbackLow: action === "BUY" ? pullbackExtreme : null,
        pullbackHigh: action === "SELL" ? pullbackExtreme : null,
        session: session.session,
        hourUtc: session.hourUtc,
        h4AlignmentNote: telem.h4AlignmentNote
      }
    };
  }
}
