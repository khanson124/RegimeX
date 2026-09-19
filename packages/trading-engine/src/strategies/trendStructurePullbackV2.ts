import { z } from "zod";
import { type MarketRegime, type StrategyDecision, type StrategyEligibility } from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";
import {
  findConfirmedSwingPivots,
  latestSwingOfKind,
  maxHighSince,
  minLowSince,
  priorSwingBefore
} from "./structureSwings.js";
import { VOLATILITY_INDEX_SYMBOLS } from "./symbolScopes.js";

/**
 * Iteration-2 reason codes. Soft codes may appear alongside accepts;
 * hard codes drive rejection when final decision is HOLD.
 */
export const TREND_STRUCTURE_PULLBACK_V2_REASON_CODES = [
  "INSUFFICIENT_HISTORY",
  "COOLDOWN_ACTIVE",
  "INDICATORS_UNAVAILABLE",
  "NO_TREND_DIRECTION",
  "ADX_BELOW_MINIMUM",
  "EMA_STACK_NOT_ALIGNED",
  "NO_CONFIRMED_SWINGS",
  "EXTENDED_SOFT",
  "EXTENDED_FROM_LONG_EMA",
  "EXTENDED_AND_SHALLOW",
  "PULLBACK_TOO_SHALLOW",
  "NEAR_RECENT_SWING_EXTREME",
  "IMPULSE_TOO_MATURE",
  "STRUCTURE_NOT_CONFIRMED",
  "CONTINUATION_CANDLE_WEAK",
  "RSI_EXTREME_WITH_EXTENSION",
  "TARGET_ROOM_INSUFFICIENT",
  "ENTRY_QUALITY_SCORE_LOW",
  "CONFIDENCE_BELOW_MINIMUM"
] as const;

export type TrendStructurePullbackV2ReasonCode =
  (typeof TREND_STRUCTURE_PULLBACK_V2_REASON_CODES)[number];

/** Research intersection labels derived from all applicable reason codes. */
export const ENTRY_QUALITY_INTERSECTIONS = [
  "EXTENDED_ONLY",
  "EXTENDED_AND_SHALLOW",
  "SHALLOW_AND_WEAK_CONFIRMATION",
  "STRUCTURE_FAIL_ONLY",
  "SCORE_ONLY",
  "MULTI_DIMENSION_FAIL",
  "ACCEPTED",
  "OTHER_REJECT"
] as const;

export type EntryQualityIntersection = (typeof ENTRY_QUALITY_INTERSECTIONS)[number];

const parametersSchema = z.object({
  pullbackEma: z.enum(["fast", "slow"]).default("slow"),
  touchTolerance: z.number().min(0.0001).max(0.02).default(0.002),
  adxMinimum: z.number().min(5).max(50).default(15),
  /**
   * Soft extension threshold (ATR from long EMA). Above this applies penalty
   * and requires meaningful pullback; does not alone reject.
   */
  softExtensionAtr: z.number().min(0.5).max(6).default(2.5),
  /** Hard extreme extension — only absolute safety reject. */
  hardExtremeExtensionAtr: z.number().min(2).max(12).default(5.0),
  /** Preferred minimum pullback depth (ATR). */
  minPullbackDepthAtr: z.number().min(0.05).max(3).default(0.3),
  /** Absolute floor — reject regardless of extension context. */
  absoluteMinPullbackDepthAtr: z.number().min(0.05).max(1).default(0.15),
  maxNearSwingExtremeAtr: z.number().min(0.05).max(2).default(0.5),
  maxImpulseDistanceAtr: z.number().min(1).max(12).default(5),
  swingLookback: z.number().int().min(2).max(8).default(3),
  rejectionWickBodyRatio: z.number().min(0.5).max(5).default(1.0),
  minBodyAtr: z.number().min(0).max(1).default(0.04),
  rsiExtensionBuyMax: z.number().min(50).max(95).default(80),
  rsiExtensionSellMin: z.number().min(5).max(50).default(20),
  rsiExtensionActivationFrac: z.number().min(0.5).max(1).default(0.85),
  minTargetRoomR: z.number().min(0.5).max(5).default(1.0),
  assumedStopAtr: z.number().min(0.2).max(5).default(1.0),
  /** Minimum composite entry quality score [0,1]. */
  minEntryQualityScore: z.number().min(0.2).max(0.9).default(0.42),
  cooldownCandles: z.number().int().min(0).max(100).default(4),
  minimumConfidence: z.number().min(0).max(1).default(0.5),
  expiryCandles: z.number().int().min(1).max(60).default(5)
});

export type TrendStructurePullbackV2Params = z.infer<typeof parametersSchema>;

export const TREND_STRUCTURE_PULLBACK_V2_DEFAULTS: TrendStructurePullbackV2Params =
  parametersSchema.parse({});

const SUPPORTED: MarketRegime[] = [
  "STRONG_UPTREND",
  "WEAK_UPTREND",
  "STRONG_DOWNTREND",
  "WEAK_DOWNTREND"
];

function atrDist(delta: number, atr: number): number {
  return atr > 0 ? delta / atr : Number.POSITIVE_INFINITY;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Classify research intersection from the full set of applicable reason codes.
 * Deterministic and independent of evaluation order.
 */
export function classifyEntryQualityIntersection(
  codes: ReadonlyArray<string>,
  accepted: boolean
): EntryQualityIntersection {
  if (accepted) return "ACCEPTED";
  const set = new Set(codes);
  const extended =
    set.has("EXTENDED_FROM_LONG_EMA") ||
    set.has("EXTENDED_SOFT") ||
    set.has("EXTENDED_AND_SHALLOW");
  const shallow = set.has("PULLBACK_TOO_SHALLOW") || set.has("EXTENDED_AND_SHALLOW");
  const weak = set.has("CONTINUATION_CANDLE_WEAK");
  const structure = set.has("STRUCTURE_NOT_CONFIRMED") || set.has("NO_CONFIRMED_SWINGS");
  const scoreOnly =
    set.has("ENTRY_QUALITY_SCORE_LOW") &&
    !extended &&
    !shallow &&
    !weak &&
    !structure &&
    !set.has("TARGET_ROOM_INSUFFICIENT") &&
    !set.has("IMPULSE_TOO_MATURE") &&
    !set.has("NEAR_RECENT_SWING_EXTREME");

  const failDims = [
    extended,
    shallow,
    weak,
    structure,
    set.has("TARGET_ROOM_INSUFFICIENT"),
    set.has("IMPULSE_TOO_MATURE"),
    set.has("NEAR_RECENT_SWING_EXTREME"),
    set.has("ENTRY_QUALITY_SCORE_LOW"),
    set.has("RSI_EXTREME_WITH_EXTENSION")
  ].filter(Boolean).length;

  if (set.has("EXTENDED_AND_SHALLOW") || (extended && shallow)) return "EXTENDED_AND_SHALLOW";
  if (shallow && weak) return "SHALLOW_AND_WEAK_CONFIRMATION";
  if (extended && failDims === 1) return "EXTENDED_ONLY";
  if (structure && failDims === 1) return "STRUCTURE_FAIL_ONLY";
  if (scoreOnly) return "SCORE_ONLY";
  if (failDims >= 2) return "MULTI_DIMENSION_FAIL";
  return "OTHER_REJECT";
}

/**
 * Trend Structure Pullback v2 — research candidate.
 *
 * Soft/contextual extension + composite entryQualityScore.
 * Does not replace v1 or ema-pullback-v1. Diagnostics collect all applicable
 * reason codes before the final accept/reject decision.
 */
export class TrendStructurePullbackV2Strategy implements TradingStrategy {
  readonly id = "trend-structure-pullback-v2";
  readonly name = "Trend Structure Pullback v2";
  readonly version = "2";
  readonly kind = "trend-structure-pullback" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 80;

  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["emaFast", "emaSlow", "emaLong", "rsi", "adx", "atr"],
    minimumHistory: this.minimumHistory,
    minimumRegimeConfidence: 0.5,
    minimumStrategyConfidence: 0.5,
    allowedSymbols: [...VOLATILITY_INDEX_SYMBOLS],
    allowedIntervals: ["1m", "5m"],
    cooldownCandles: TREND_STRUCTURE_PULLBACK_V2_DEFAULTS.cooldownCandles
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const p = parametersSchema.parse(context.parameters);
    const i = context.candles.length - 1;
    const candle = context.candles[i];
    const f = context.features[i];
    const ts = context.regime.timestamp;
    if (!candle || !f) {
      return this.finish(false, ts, ["INSUFFICIENT_HISTORY"], ["No candle/features"], {}, p);
    }

    if (context.candlesSinceLastSignal < p.cooldownCandles) {
      return this.finish(
        false,
        ts,
        ["COOLDOWN_ACTIVE"],
        [`Cooldown ${context.candlesSinceLastSignal}/${p.cooldownCandles}`],
        {},
        p
      );
    }

    if (
      f.emaFast === null ||
      f.emaSlow === null ||
      f.emaLong === null ||
      f.rsi === null ||
      f.adx === null ||
      f.atr === null ||
      !(f.atr > 0)
    ) {
      return this.finish(false, ts, ["INDICATORS_UNAVAILABLE"], ["Indicators unavailable"], {}, p);
    }

    const atr = f.atr;
    const trendUp = f.trendDirection === 1;
    const trendDown = f.trendDirection === -1;
    if (!trendUp && !trendDown) {
      return this.finish(false, ts, ["NO_TREND_DIRECTION"], ["No trend"], {}, p);
    }

    const allCodes: TrendStructurePullbackV2ReasonCode[] = [];
    const details: string[] = [];

    if (f.adx < p.adxMinimum) {
      allCodes.push("ADX_BELOW_MINIMUM");
      details.push(`ADX ${f.adx.toFixed(1)} < ${p.adxMinimum}`);
    }

    const stackBullish = f.emaFast > f.emaSlow && f.emaSlow > f.emaLong;
    const stackBearish = f.emaFast < f.emaSlow && f.emaSlow < f.emaLong;
    if ((trendUp && !stackBullish) || (trendDown && !stackBearish)) {
      allCodes.push("EMA_STACK_NOT_ALIGNED");
      details.push("EMA stack not aligned with trend");
    }

    const extensionAtr = atrDist(candle.close - f.emaLong, atr);
    const extensionAbsAtr = Math.abs(extensionAtr);
    const directedExtension =
      trendUp && extensionAtr > 0
        ? extensionAtr
        : trendDown && extensionAtr < 0
          ? Math.abs(extensionAtr)
          : 0;

    const pivots = findConfirmedSwingPivots(context.candles, i, p.swingLookback);
    if (pivots.length < 2) {
      allCodes.push("NO_CONFIRMED_SWINGS");
    }

    const targetEma = p.pullbackEma === "fast" ? f.emaFast : f.emaSlow;
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const tolerance = targetEma * p.touchTolerance;
    const bodyAtr = atrDist(body, atr);

    const side = trendUp ? "BUY" : "SELL";
    const metrics = this.measureSide({
      side,
      candle,
      f,
      atr,
      pivots,
      i,
      candles: context.candles,
      targetEma,
      tolerance,
      body,
      lowerWick,
      upperWick,
      bodyAtr,
      p
    });

    // --- Collect all applicable soft/hard dimension codes (order-independent) ---
    if (directedExtension > p.hardExtremeExtensionAtr) {
      allCodes.push("EXTENDED_FROM_LONG_EMA");
      details.push(`Hard extreme extension ${directedExtension.toFixed(2)} ATR`);
    } else if (directedExtension > p.softExtensionAtr) {
      allCodes.push("EXTENDED_SOFT");
      details.push(`Soft extension ${directedExtension.toFixed(2)} ATR`);
    }

    if (metrics.pullbackDepthAtr < p.absoluteMinPullbackDepthAtr) {
      allCodes.push("PULLBACK_TOO_SHALLOW");
      details.push(`Pullback ${metrics.pullbackDepthAtr.toFixed(2)} < absolute floor`);
    }

    if (
      directedExtension > p.softExtensionAtr &&
      metrics.pullbackDepthAtr < p.minPullbackDepthAtr
    ) {
      allCodes.push("EXTENDED_AND_SHALLOW");
      details.push("Extended trend with insufficient retracement");
    }

    if (!metrics.structureOk) {
      allCodes.push("STRUCTURE_NOT_CONFIRMED");
      details.push("HL/LH structure not confirmed");
    }

    if (metrics.impulseDistanceAtr > p.maxImpulseDistanceAtr) {
      allCodes.push("IMPULSE_TOO_MATURE");
      details.push(`Impulse ${metrics.impulseDistanceAtr.toFixed(2)} ATR mature`);
    }

    if (
      metrics.distanceToOpposingSwingAtr != null &&
      metrics.distanceToOpposingSwingAtr < p.maxNearSwingExtremeAtr
    ) {
      allCodes.push("NEAR_RECENT_SWING_EXTREME");
      details.push("Too close to opposing swing extreme");
    }

    if (!metrics.continuationOk) {
      allCodes.push("CONTINUATION_CANDLE_WEAK");
      details.push("Rejection/continuation candle weak");
    }

    if (metrics.roomR != null && metrics.roomR < p.minTargetRoomR) {
      allCodes.push("TARGET_ROOM_INSUFFICIENT");
      details.push(`Target room ${metrics.roomR.toFixed(2)}R < ${p.minTargetRoomR}`);
    }

    if (
      directedExtension >= p.softExtensionAtr * p.rsiExtensionActivationFrac &&
      ((side === "BUY" && f.rsi > p.rsiExtensionBuyMax) ||
        (side === "SELL" && f.rsi < p.rsiExtensionSellMin))
    ) {
      allCodes.push("RSI_EXTREME_WITH_EXTENSION");
      details.push("RSI extreme with extension context");
    }

    // Composite scores (simple fixed weights — researched via compact grid, not black-box).
    const softSpan = Math.max(1e-6, p.hardExtremeExtensionAtr - p.softExtensionAtr);
    const extensionPenalty =
      directedExtension <= p.softExtensionAtr
        ? 0
        : clamp01((directedExtension - p.softExtensionAtr) / softSpan);

    const pullbackQualityScore = clamp01(metrics.pullbackDepthAtr / Math.max(p.minPullbackDepthAtr, 1e-6));
    const structureQualityScore = metrics.structureOk ? 1 : 0;
    const continuationQualityScore = metrics.continuationOk
      ? clamp01(metrics.wickBodyRatio / Math.max(p.rejectionWickBodyRatio, 1e-6))
      : 0;
    const targetRoomScore =
      metrics.roomR == null ? 0.5 : clamp01(metrics.roomR / Math.max(p.minTargetRoomR, 1e-6));
    const impulseSoft =
      metrics.impulseDistanceAtr <= p.maxImpulseDistanceAtr * 0.75
        ? 0
        : clamp01(
            (metrics.impulseDistanceAtr - p.maxImpulseDistanceAtr * 0.75) /
              Math.max(p.maxImpulseDistanceAtr * 0.25, 1e-6)
          );

    // Extension penalty is reduced when pullback quality is strong (contextual).
    const contextualExtensionCost = extensionPenalty * (1 - 0.7 * pullbackQualityScore);

    const entryQualityScore = clamp01(
      0.3 * pullbackQualityScore +
        0.25 * structureQualityScore +
        0.2 * continuationQualityScore +
        0.15 * targetRoomScore +
        0.1 * (1 - impulseSoft) -
        0.35 * contextualExtensionCost
    );

    if (entryQualityScore < p.minEntryQualityScore) {
      allCodes.push("ENTRY_QUALITY_SCORE_LOW");
      details.push(`Score ${entryQualityScore.toFixed(3)} < ${p.minEntryQualityScore}`);
    }

    const qualityMeta: Record<string, unknown> = {
      extensionAtr: Number(extensionAtr.toFixed(4)),
      extensionLimitAtr: p.softExtensionAtr,
      hardExtremeExtensionAtr: p.hardExtremeExtensionAtr,
      minimumPullbackDepthAtr: p.minPullbackDepthAtr,
      pullbackDepthAtr: Number(metrics.pullbackDepthAtr.toFixed(4)),
      impulseDistanceAtr: Number(metrics.impulseDistanceAtr.toFixed(4)),
      barsSinceImpulse: metrics.barsSinceImpulse,
      structureState: metrics.structureOk
        ? side === "BUY"
          ? "BULLISH_HL"
          : "BEARISH_LH"
        : "STRUCTURE_WEAK",
      distanceToNearestStructureAtr:
        metrics.distanceToOpposingSwingAtr != null
          ? Number(metrics.distanceToOpposingSwingAtr.toFixed(4))
          : null,
      extensionPenalty: Number(extensionPenalty.toFixed(4)),
      pullbackQualityScore: Number(pullbackQualityScore.toFixed(4)),
      structureQualityScore,
      continuationQualityScore: Number(continuationQualityScore.toFixed(4)),
      targetRoomScore: Number(targetRoomScore.toFixed(4)),
      entryQualityScore: Number(entryQualityScore.toFixed(4)),
      allEntryQualityReasonCodes: [...new Set(allCodes)],
      swingLow: metrics.swingLow,
      swingHigh: metrics.swingHigh,
      impulseExtreme: metrics.impulseExtreme,
      pullbackLow: candle.low,
      pullbackHigh: candle.high,
      targetEma
    };

    // Hard prerequisites that always reject (even if score is high).
    const hardRejectCodes = new Set<TrendStructurePullbackV2ReasonCode>([
      "ADX_BELOW_MINIMUM",
      "EMA_STACK_NOT_ALIGNED",
      "NO_CONFIRMED_SWINGS",
      "EXTENDED_FROM_LONG_EMA",
      "EXTENDED_AND_SHALLOW",
      "PULLBACK_TOO_SHALLOW",
      "STRUCTURE_NOT_CONFIRMED",
      "CONTINUATION_CANDLE_WEAK",
      "IMPULSE_TOO_MATURE",
      "NEAR_RECENT_SWING_EXTREME",
      "TARGET_ROOM_INSUFFICIENT",
      "RSI_EXTREME_WITH_EXTENSION",
      "ENTRY_QUALITY_SCORE_LOW"
    ]);

    const hasHardReject = allCodes.some((c) => hardRejectCodes.has(c));
    // Soft extension alone does not reject.
    const accept = !hasHardReject;

    const confidence = Math.min(
      0.5 + entryQualityScore * 0.4 + (f.adx - p.adxMinimum) / 100,
      0.92
    );
    if (accept && confidence < p.minimumConfidence) {
      allCodes.push("CONFIDENCE_BELOW_MINIMUM");
      return this.finish(false, ts, allCodes, details, qualityMeta, p);
    }

    const intersection = classifyEntryQualityIntersection(allCodes, accept);
    qualityMeta.entryQualityIntersection = intersection;
    qualityMeta.finalEntryQualityDecision = accept ? "ACCEPT" : "REJECT";
    qualityMeta.entryQualityReasonCodes = accept
      ? allCodes.filter((c) => c === "EXTENDED_SOFT")
      : [...new Set(allCodes)];

    if (!accept) {
      return this.finish(false, ts, allCodes, details, qualityMeta, p);
    }

    return {
      action: side,
      confidence: Number(confidence.toFixed(3)),
      entryReason: [
        `${side} contextual pullback`,
        `Score ${entryQualityScore.toFixed(3)} (min ${p.minEntryQualityScore})`,
        `Extension ${directedExtension.toFixed(2)} ATR (soft ${p.softExtensionAtr}, hard ${p.hardExtremeExtensionAtr})`,
        `Pullback ${metrics.pullbackDepthAtr.toFixed(2)} ATR`,
        `Structure ${qualityMeta.structureState}`
      ],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: p.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: {
        pullbackEma: p.pullbackEma,
        ...qualityMeta
      }
    };
  }

  private finish(
    _accept: false,
    ts: number,
    codes: TrendStructurePullbackV2ReasonCode[],
    details: string[],
    quality: Record<string, unknown>,
    _p: TrendStructurePullbackV2Params
  ): StrategyDecision {
    const uniq = [...new Set(codes)];
    const decision = holdDecision(this, ts, [...uniq, ...details]);
    const intersection = classifyEntryQualityIntersection(uniq, false);
    return {
      ...decision,
      metadata: {
        ...quality,
        allEntryQualityReasonCodes: uniq,
        entryQualityReasonCodes: uniq,
        entryQualityIntersection: intersection,
        finalEntryQualityDecision: "REJECT"
      }
    };
  }

  private measureSide(input: {
    side: "BUY" | "SELL";
    candle: StrategyContext["candles"][number];
    f: NonNullable<StrategyContext["features"][number]>;
    atr: number;
    pivots: ReturnType<typeof findConfirmedSwingPivots>;
    i: number;
    candles: StrategyContext["candles"];
    targetEma: number;
    tolerance: number;
    body: number;
    lowerWick: number;
    upperWick: number;
    bodyAtr: number;
    p: TrendStructurePullbackV2Params;
  }) {
    const { side, candle, f, atr, pivots, i, p } = input;
    if (side === "BUY") {
      const swingLow = latestSwingOfKind(pivots, "low");
      const swingHigh = latestSwingOfKind(pivots, "high");
      const impulseExtreme =
        swingLow != null ? maxHighSince(input.candles, swingLow.index, i) : null;
      const pullbackDepthAtr =
        impulseExtreme != null ? atrDist(impulseExtreme - candle.low, atr) : 0;
      const impulseDistanceAtr =
        swingLow != null && impulseExtreme != null
          ? atrDist(impulseExtreme - swingLow.price, atr)
          : 0;
      const priorLow = swingLow != null ? priorSwingBefore(pivots, swingLow.index, "low") : null;
      const structureOk =
        (priorLow != null && swingLow != null && swingLow.price >= priorLow.price) ||
        f.higherHighCount >= 1;
      const distanceToOpposingSwingAtr =
        swingHigh != null ? atrDist(Math.max(0, swingHigh.price - candle.close), atr) : null;
      const touched = candle.low <= input.targetEma + input.tolerance;
      const closedBack = candle.close > input.targetEma;
      const wickBodyRatio =
        input.body === 0 ? (input.lowerWick > 0 ? 99 : 0) : input.lowerWick / input.body;
      const rejection =
        candle.close > candle.open &&
        wickBodyRatio >= p.rejectionWickBodyRatio &&
        (p.minBodyAtr <= 0 ||
          input.bodyAtr >= p.minBodyAtr ||
          wickBodyRatio >= p.rejectionWickBodyRatio * 1.25);
      const continuationOk = touched && closedBack && rejection;
      const assumedStop = atr * p.assumedStopAtr;
      const roomR =
        swingHigh != null && assumedStop > 0
          ? (swingHigh.price - candle.close) / assumedStop
          : null;
      return {
        structureOk,
        pullbackDepthAtr,
        impulseDistanceAtr,
        barsSinceImpulse: swingLow != null ? i - swingLow.index : 0,
        distanceToOpposingSwingAtr,
        continuationOk,
        wickBodyRatio,
        roomR,
        swingLow: swingLow?.price ?? null,
        swingHigh: swingHigh?.price ?? null,
        impulseExtreme
      };
    }

    const swingHigh = latestSwingOfKind(pivots, "high");
    const swingLow = latestSwingOfKind(pivots, "low");
    const impulseExtreme =
      swingHigh != null ? minLowSince(input.candles, swingHigh.index, i) : null;
    const pullbackDepthAtr =
      impulseExtreme != null ? atrDist(candle.high - impulseExtreme, atr) : 0;
    const impulseDistanceAtr =
      swingHigh != null && impulseExtreme != null
        ? atrDist(swingHigh.price - impulseExtreme, atr)
        : 0;
    const priorHigh = swingHigh != null ? priorSwingBefore(pivots, swingHigh.index, "high") : null;
    const structureOk =
      (priorHigh != null && swingHigh != null && swingHigh.price <= priorHigh.price) ||
      f.lowerLowCount >= 1;
    const distanceToOpposingSwingAtr =
      swingLow != null ? atrDist(Math.max(0, candle.close - swingLow.price), atr) : null;
    const touched = candle.high >= input.targetEma - input.tolerance;
    const closedBack = candle.close < input.targetEma;
    const wickBodyRatio =
      input.body === 0 ? (input.upperWick > 0 ? 99 : 0) : input.upperWick / input.body;
    const rejection =
      candle.close < candle.open &&
      wickBodyRatio >= p.rejectionWickBodyRatio &&
      (p.minBodyAtr <= 0 ||
        input.bodyAtr >= p.minBodyAtr ||
        wickBodyRatio >= p.rejectionWickBodyRatio * 1.25);
    const continuationOk = touched && closedBack && rejection;
    const assumedStop = atr * p.assumedStopAtr;
    const roomR =
      swingLow != null && assumedStop > 0 ? (candle.close - swingLow.price) / assumedStop : null;
    return {
      structureOk,
      pullbackDepthAtr,
      impulseDistanceAtr,
      barsSinceImpulse: swingHigh != null ? i - swingHigh.index : 0,
      distanceToOpposingSwingAtr,
      continuationOk,
      wickBodyRatio,
      roomR,
      swingLow: swingLow?.price ?? null,
      swingHigh: swingHigh?.price ?? null,
      impulseExtreme
    };
  }
}
