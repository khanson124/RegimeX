/**
 * xau-trend-breakout-v2 — research-only XAUUSD H4 bias + M15 consolidation breakout.
 *
 * Simpler than xau-trend-pullback-v1: no EMA pullback requirement.
 * Evaluates on 1m series; signals only on completed M15 closes.
 * Not auto-enabled for MT5/live allowlists.
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
import { latestSwingOfKind, findConfirmedSwingPivots } from "./structureSwings.js";
import {
  atrPercentileAtEnd,
  classifyH4TrendBias,
  completedSessionAwareHtfBarsAsOf,
  isWithinUtcSessionHours,
  type H4TrendBias
} from "./xauTrendPullbackHtf.js";
import { sessionContextFromEpochMs } from "./xauMtfEntryQuality.js";
import {
  evaluateBreakoutRetest,
  evaluateConsolidationBreakout
} from "./xauTrendBreakoutV2Consolidation.js";

export const XAU_TREND_BREAKOUT_V2_REASON_CODES = [
  "INSUFFICIENT_HISTORY",
  "COOLDOWN_ACTIVE",
  "NOT_M15_CLOSE",
  "H4_NEUTRAL",
  "H4_CONTEXT_INVALID",
  "OUTSIDE_SESSION",
  "ATR_PERCENTILE_OUT_OF_RANGE",
  "INDICATORS_UNAVAILABLE",
  "NO_VALID_CONSOLIDATION",
  "NO_BREAKOUT",
  "BREAKOUT_QUALITY_FAIL",
  "DUPLICATE_STRUCTURE",
  "NO_RETEST",
  "STOP_INVALID",
  "ADX_BELOW_MINIMUM"
] as const;

export type XauTrendBreakoutV2ReasonCode = (typeof XAU_TREND_BREAKOUT_V2_REASON_CODES)[number];

const parametersSchema = z.object({
  h4SlopeLookback: z.number().int().min(1).max(10).default(3),
  /** 0 = disabled (baseline). */
  adxMinimum: z.number().min(0).max(50).default(0),
  atrPercentileLookback: z.number().int().min(20).max(500).default(100),
  atrPercentileMin: z.number().min(0).max(1).default(0.1),
  atrPercentileMax: z.number().min(0).max(1).default(0.9),
  sessionStartHourUtc: z.number().min(0).max(24).default(7),
  sessionEndHourUtc: z.number().min(0).max(24).default(17),
  consolidationLookback: z.number().int().min(4).max(40).default(12),
  minConsolidationWidthAtr: z.number().min(0.05).max(3).default(0.4),
  maxConsolidationWidthAtr: z.number().min(0.5).max(8).default(3.5),
  minBreakoutDistanceAtr: z.number().min(0).max(1).default(0.1),
  maxBreakoutCandleRangeAtr: z.number().min(0.5).max(6).default(2.0),
  minBreakoutBodyAtr: z.number().min(0).max(1).default(0.05),
  /** immediate = breakout bar entry; retest = separate research variant. */
  entryMode: z.enum(["immediate", "retest"]).default("immediate"),
  maxRetestDelayBars: z.number().int().min(1).max(5).default(3),
  retestTouchAtr: z.number().min(0.05).max(1).default(0.25),
  stopAtrMultiple: z.number().min(0.5).max(4).default(1.5),
  targetRMultiple: z.number().min(1).max(4).default(2),
  structureBufferAtr: z.number().min(0).max(1).default(0.15),
  /** Cooldown in M15 candles (converted to 1m ×15). */
  cooldownCandles: z.number().int().min(0).max(200).default(2),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  h4MinFillRatio: z.number().min(0.1).max(1).default(0.25),
  swingLookback: z.number().int().min(2).max(5).default(2)
});

export type XauTrendBreakoutV2Params = z.infer<typeof parametersSchema>;

export const XAU_TREND_BREAKOUT_V2_DEFAULTS: XauTrendBreakoutV2Params = parametersSchema.parse({});

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
  codes: XauTrendBreakoutV2ReasonCode[],
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

/** True if a bar after the consolidation window already closed beyond the structure. */
function recentlyBrokeSameStructure(
  m15: ReadonlyArray<{ close: number }>,
  barIndex: number,
  consolidationEndIndex: number,
  direction: "BUY" | "SELL",
  high: number,
  low: number
): boolean {
  for (let i = consolidationEndIndex + 1; i < barIndex; i++) {
    const c = m15[i]!;
    if (direction === "BUY" && c.close > high) return true;
    if (direction === "SELL" && c.close < low) return true;
  }
  return false;
}

export class XauTrendBreakoutV2Strategy implements TradingStrategy {
  readonly id = "xau-trend-breakout-v2";
  readonly name = "XAU Trend Breakout v2";
  readonly kind = "xau-trend-breakout" as const;
  readonly version = "2.0.0";
  readonly displayName = "XAU Trend Breakout v2";
  readonly description =
    "Research-only XAUUSD H4 EMA bias with M15 consolidation/structural breakout (not MT5-enabled).";
  readonly supportedRegimes = SUPPORTED;
  readonly allowedIntervals = ["1m"] as const;
  readonly minimumHistory: number = 10_000;
  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["atr", "emaFast", "emaSlow"],
    minimumHistory: 10_000,
    minimumRegimeConfidence: 0,
    minimumStrategyConfidence: 0.5,
    allowedSymbols: [],
    allowedIntervals: ["1m"],
    cooldownCandles: 30
  };

  validateParameters(raw: Record<string, unknown>): XauTrendBreakoutV2Params {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const p = this.validateParameters(context.parameters);
    const candles = context.candles;
    const i = candles.length - 1;
    const candle = candles[i]!;
    const ts = candle.closeTime;
    const session = sessionContextFromEpochMs(ts);
    const baseTelem = {
      hourUtc: session.hourUtc,
      session: session.session,
      strategyId: this.id,
      entryMode: p.entryMode
    };

    if (candles.length < this.minimumHistory) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], baseTelem);
    }
    const cooldown1m = p.cooldownCandles * 15;
    if (context.candlesSinceLastSignal < cooldown1m) {
      return holdWith(this, ts, ["COOLDOWN_ACTIVE"], {
        ...baseTelem,
        candlesSinceLastSignal: context.candlesSinceLastSignal,
        cooldown1m
      });
    }
    if (!closesCompletedHtfBucket(candles, i, "15m")) {
      return holdWith(this, ts, ["NOT_M15_CLOSE"], baseTelem);
    }

    const m15 = completedHtfBarsAsOf(candles, i, "15m");
    const h4 = completedSessionAwareHtfBarsAsOf(candles, i, "4h", {
      minFillRatio: p.h4MinFillRatio
    });
    const biasSnap = classifyH4TrendBias(h4, { slopeLookback: p.h4SlopeLookback });
    const telem = {
      ...baseTelem,
      h4Bias: biasSnap.bias,
      h4BarCount: h4.length,
      m15BarCount: m15.length,
      h4AlignmentNote:
        "H4 session-aware completed buckets with closeTime <= as-of 1m close; M15 only on contiguous completed closes."
    };

    if (h4.length < 55 || biasSnap.ema21 == null) {
      return holdWith(this, ts, ["H4_CONTEXT_INVALID"], telem);
    }
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
    const m15Idx = m15.length - 1;
    if (!feat || feat.atr == null || feat.atr <= 0) {
      return holdWith(this, ts, ["INDICATORS_UNAVAILABLE"], telem);
    }
    if (p.adxMinimum > 0 && feat.adx != null && feat.adx < p.adxMinimum) {
      return holdWith(this, ts, ["ADX_BELOW_MINIMUM"], {
        ...telem,
        adx: feat.adx,
        adxMinimum: p.adxMinimum
      });
    }

    const atrSeries = m15Feat.map((f) => f.atr);
    const atrPct = atrPercentileAtEnd(atrSeries, p.atrPercentileLookback);
    if (atrPct == null || atrPct < p.atrPercentileMin || atrPct > p.atrPercentileMax) {
      return holdWith(this, ts, ["ATR_PERCENTILE_OUT_OF_RANGE"], {
        ...telem,
        atrPercentile: atrPct
      });
    }

    const atr = feat.atr;
    const bias: H4TrendBias = biasSnap.bias;
    let action: "BUY" | "SELL" | null = null;
    let consolidation = null as ReturnType<typeof evaluateConsolidationBreakout>["consolidation"];
    let trigger = "IMMEDIATE_BREAKOUT";
    let qualityReasons: string[] = [];

    if (p.entryMode === "immediate") {
      const snap = evaluateConsolidationBreakout({
        m15,
        barIndex: m15Idx,
        bias: bias as "BULLISH" | "BEARISH",
        atr,
        lookback: p.consolidationLookback,
        minWidthAtr: p.minConsolidationWidthAtr,
        maxWidthAtr: p.maxConsolidationWidthAtr,
        minBreakoutDistanceAtr: p.minBreakoutDistanceAtr,
        maxBreakoutCandleRangeAtr: p.maxBreakoutCandleRangeAtr,
        minBreakoutBodyAtr: p.minBreakoutBodyAtr
      });
      consolidation = snap.consolidation;
      qualityReasons = snap.reasons;
      if (snap.consolidation == null) {
        return holdWith(this, ts, ["NO_VALID_CONSOLIDATION"], { ...telem, ...snap });
      }
      if (!snap.breakout) {
        return holdWith(this, ts, ["NO_BREAKOUT"], { ...telem, reasons: snap.reasons });
      }
      if (!snap.qualityPass) {
        return holdWith(this, ts, ["BREAKOUT_QUALITY_FAIL"], {
          ...telem,
          reasons: snap.reasons,
          candleRangeAtr: snap.candleRangeAtr,
          breakoutDistanceAtr: snap.breakoutDistanceAtr
        });
      }
      action = snap.direction;
      if (
        action != null &&
        snap.consolidation != null &&
        recentlyBrokeSameStructure(
          m15,
          m15Idx,
          snap.consolidation.endIndex,
          action,
          snap.consolidation.high,
          snap.consolidation.low
        )
      ) {
        return holdWith(this, ts, ["DUPLICATE_STRUCTURE"], {
          ...telem,
          structureKey: snap.consolidation.structureKey
        });
      }
    } else {
      const retest = evaluateBreakoutRetest({
        m15,
        barIndex: m15Idx,
        bias: bias as "BULLISH" | "BEARISH",
        atr,
        lookback: p.consolidationLookback,
        minWidthAtr: p.minConsolidationWidthAtr,
        maxWidthAtr: p.maxConsolidationWidthAtr,
        minBreakoutDistanceAtr: p.minBreakoutDistanceAtr,
        maxBreakoutCandleRangeAtr: p.maxBreakoutCandleRangeAtr,
        minBreakoutBodyAtr: p.minBreakoutBodyAtr,
        maxRetestDelayBars: p.maxRetestDelayBars,
        retestTouchAtr: p.retestTouchAtr
      });
      consolidation = retest.consolidation;
      qualityReasons = retest.reasons;
      if (!retest.ok || retest.direction == null) {
        return holdWith(this, ts, ["NO_RETEST"], { ...telem, reasons: retest.reasons });
      }
      action = retest.direction;
      trigger = "BREAKOUT_RETEST";
    }

    if (action == null || consolidation == null) {
      return holdWith(this, ts, ["NO_BREAKOUT"], telem);
    }

    const pivots = findConfirmedSwingPivots(m15, m15Idx, p.swingLookback);
    const swingHigh = latestSwingOfKind(pivots, "high");
    const swingLow = latestSwingOfKind(pivots, "low");
    const buffer = atr * p.structureBufferAtr;
    let stopLoss: number;
    if (action === "BUY") {
      const atrStop = m15Bar.close - atr * p.stopAtrMultiple;
      const structStop = consolidation.low - buffer;
      const swingStop =
        swingLow != null && swingLow.price < m15Bar.close ? swingLow.price - buffer : null;
      stopLoss = Math.min(atrStop, structStop, swingStop ?? atrStop);
      if (!(stopLoss < m15Bar.close)) {
        return holdWith(this, ts, ["STOP_INVALID"], telem);
      }
    } else {
      const atrStop = m15Bar.close + atr * p.stopAtrMultiple;
      const structStop = consolidation.high + buffer;
      const swingStop =
        swingHigh != null && swingHigh.price > m15Bar.close ? swingHigh.price + buffer : null;
      stopLoss = Math.max(atrStop, structStop, swingStop ?? atrStop);
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
      confidence: Math.min(0.85, p.minimumConfidence + 0.1),
      entryReason: [
        `H4_${bias}`,
        trigger,
        `rangeW=${consolidation.widthAtr?.toFixed(2) ?? "na"}ATR`,
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
        entryMode: p.entryMode,
        atrPercentile: atrPct,
        adx: feat.adx,
        atr,
        m15Atr: atr,
        stopLoss,
        takeProfit,
        intendedR: p.targetRMultiple,
        stopAtrMultiple: p.stopAtrMultiple,
        consolidationHigh: consolidation.high,
        consolidationLow: consolidation.low,
        structureKey: consolidation.structureKey,
        pullbackLow: action === "BUY" ? consolidation.low : null,
        pullbackHigh: action === "SELL" ? consolidation.high : null,
        session: session.session,
        hourUtc: session.hourUtc,
        qualityReasons,
        h4AlignmentNote: telem.h4AlignmentNote
      }
    };
  }
}
