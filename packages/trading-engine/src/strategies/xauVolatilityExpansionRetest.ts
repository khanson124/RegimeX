/**
 * XAU Volatility Expansion Retest v1 — research-only CFD candidate.
 *
 * Compression → expansion breakout → wait (do not chase) → retest → acceptance
 * → structural stop / target room. Distinct from squeeze-breakout (no entry on
 * the expansion event itself).
 *
 * Evaluates on 1m series; builds 5m setup (+ optional 15m context) as-of.
 */
import { z } from "zod";
import {
  type MarketRegime,
  type StrategyDecision,
  type StrategyEligibility
} from "@regimex/shared";
import { holdDecision, type StrategyContext, type TradingStrategy } from "./types.js";
import { completedHtfBarsAsOf, closesCompletedHtfBucket } from "./mtfResampleAsOf.js";
import { sessionContextFromEpochMs } from "./xauMtfEntryQuality.js";
import {
  evaluateVolatilitySetupAsOf,
  type VolatilityStateParams
} from "./volatilityExpansionState.js";
import { classifyHtfStructure } from "./htfStructure.js";
import { findConfirmedSwingPivots, latestSwingOfKind } from "./structureSwings.js";
import { XAUUSD_SYMBOLS } from "./symbolScopes.js";

export const XAU_VOL_EXPANSION_RETEST_REASON_CODES = [
  "INSUFFICIENT_HISTORY",
  "COOLDOWN_ACTIVE",
  "WRONG_BAR_FOR_EXECUTION_MODE",
  "NOT_RETEST_ACCEPTED",
  "EXHAUSTED",
  "BREAKOUT_FAILED",
  "TARGET_ROOM_INSUFFICIENT",
  "NO_1M_REFINEMENT",
  "STOP_INVALID",
  "INDICATORS_UNAVAILABLE"
] as const;

export type XauVolExpansionRetestReasonCode =
  (typeof XAU_VOL_EXPANSION_RETEST_REASON_CODES)[number];

const parametersSchema = z.object({
  executionTimeframe: z.enum(["5m", "1m"]).default("5m"),
  compressionLookback: z.number().int().min(6).max(30).default(12),
  maxNormalizedRange: z.number().min(0.3).max(1.2).default(0.65),
  minCompressionBars: z.number().int().min(3).max(20).default(6),
  minExpansionRangeAtr: z.number().min(0.8).max(3).default(1.2),
  minBreakoutBodyAtr: z.number().min(0.05).max(1).default(0.25),
  minCloseLocation: z.number().min(0.5).max(0.9).default(0.6),
  retestZoneWidthAtr: z.number().min(0.1).max(1).default(0.35),
  maxRetestDelayBars: z.number().int().min(2).max(40).default(12),
  maxChaseExtensionAtr: z.number().min(1).max(8).default(2.5),
  minAcceptanceCloseBeyondAtr: z.number().min(0.02).max(1).default(0.1),
  exhaustionExtensionAtr: z.number().min(1.5).max(10).default(3.5),
  minStructureRoomR: z.number().min(0.8).max(4).default(1.5),
  structureBufferAtr: z.number().min(0).max(1).default(0.15),
  intendedTargetR: z.number().min(1).max(4).default(2),
  cooldownCandles: z.number().int().min(0).max(200).default(20),
  minimumConfidence: z.number().min(0).max(1).default(0.55),
  expiryCandles: z.number().int().min(1).max(120).default(24)
});

export type XauVolatilityExpansionRetestParams = z.infer<typeof parametersSchema>;

export const XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS: XauVolatilityExpansionRetestParams =
  parametersSchema.parse({});

export const XAU_VOLATILITY_EXPANSION_RETEST_SENSITIVITY_RANGES = {
  compressionLookback: [8, 12, 16] as const,
  maxNormalizedRange: [0.55, 0.65, 0.8] as const,
  minExpansionRangeAtr: [1.0, 1.2, 1.5] as const,
  retestZoneWidthAtr: [0.25, 0.35, 0.5] as const,
  maxRetestDelayBars: [8, 12, 18] as const,
  maxChaseExtensionAtr: [2.0, 2.5, 3.5] as const,
  minStructureRoomR: [1.2, 1.5, 2.0] as const,
  executionTimeframe: ["5m", "1m"] as const
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

function toStateParams(p: XauVolatilityExpansionRetestParams): VolatilityStateParams {
  return {
    compressionLookback: p.compressionLookback,
    maxNormalizedRange: p.maxNormalizedRange,
    minCompressionBars: p.minCompressionBars,
    minExpansionRangeAtr: p.minExpansionRangeAtr,
    minBreakoutBodyAtr: p.minBreakoutBodyAtr,
    minCloseLocation: p.minCloseLocation,
    retestZoneWidthAtr: p.retestZoneWidthAtr,
    maxRetestDelayBars: p.maxRetestDelayBars,
    maxChaseExtensionAtr: p.maxChaseExtensionAtr,
    minAcceptanceCloseBeyondAtr: p.minAcceptanceCloseBeyondAtr,
    exhaustionExtensionAtr: p.exhaustionExtensionAtr
  };
}

function holdWith(
  strategy: TradingStrategy,
  ts: number,
  codes: XauVolExpansionRetestReasonCode[],
  telemetry: Record<string, unknown>
): StrategyDecision {
  const decision = holdDecision(strategy, ts, codes);
  return {
    ...decision,
    metadata: { entryQualityReasonCodes: codes, ...telemetry }
  };
}

export class XauVolatilityExpansionRetestStrategy implements TradingStrategy {
  readonly id = "xau-volatility-expansion-retest-v1";
  readonly name = "XAU Volatility Expansion Retest";
  readonly version = "1";
  readonly kind = "xau-volatility-expansion-retest" as const;
  readonly supportedRegimes = SUPPORTED;
  readonly minimumHistory = 900;
  readonly eligibility: StrategyEligibility = {
    supportedRegimes: SUPPORTED,
    requiredIndicators: ["atr", "adx", "bollingerWidth"],
    minimumHistory: 900,
    minimumRegimeConfidence: 0,
    minimumStrategyConfidence: 0.5,
    allowedSymbols: [...XAUUSD_SYMBOLS],
    allowedIntervals: ["1m"],
    cooldownCandles: 20
  };

  validateParameters(raw: Record<string, unknown>): Record<string, number | boolean | string> {
    return parametersSchema.parse(raw);
  }

  evaluate(context: StrategyContext): StrategyDecision {
    const params = parametersSchema.parse(context.parameters);
    const candles = context.candles;
    const i = candles.length - 1;
    const candle = candles[i]!;
    const ts = candle.closeTime;
    const session = sessionContextFromEpochMs(ts);
    const baseTelemetry: Record<string, unknown> = {
      entryMode: params.executionTimeframe,
      sessionContext: session.session,
      hourUtc: session.hourUtc
    };

    if (candles.length < this.minimumHistory) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], baseTelemetry);
    }
    if (context.candlesSinceLastSignal < params.cooldownCandles) {
      return holdWith(this, ts, ["COOLDOWN_ACTIVE"], baseTelemetry);
    }
    if (params.executionTimeframe === "5m" && !closesCompletedHtfBucket(candles, i, "5m")) {
      return holdWith(this, ts, ["WRONG_BAR_FOR_EXECUTION_MODE"], baseTelemetry);
    }

    const setup5 = completedHtfBarsAsOf(candles, i, "5m");
    const htf15 = completedHtfBarsAsOf(candles, i, "15m");
    if (setup5.length < params.compressionLookback + 10) {
      return holdWith(this, ts, ["INSUFFICIENT_HISTORY"], {
        ...baseTelemetry,
        setup5Bars: setup5.length
      });
    }

    const setup = evaluateVolatilitySetupAsOf(
      setup5,
      setup5.length - 1,
      toStateParams(params)
    );
    Object.assign(baseTelemetry, {
      volatilityState: setup.state,
      compressionScore: setup.compressionScore,
      compressionDurationBars: setup.compressionDurationBars,
      compressionRangeAtr: setup.compressionRangeAtr,
      breakoutDirection: setup.breakoutDirection,
      breakoutLevel: setup.breakoutLevel,
      breakoutDistanceAtr: setup.breakoutDistanceAtr,
      expansionStrength: setup.expansionStrength,
      barsSinceExpansion: setup.barsSinceExpansion,
      maxExtensionSinceExpansionAtr: setup.maxExtensionSinceExpansionAtr,
      retestSeen: setup.retestSeen,
      retestDepthAtr: setup.retestDepthAtr,
      retestZoneWidthAtr: setup.retestZoneWidthAtr,
      acceptanceScore: setup.acceptanceScore,
      breakoutFailureFlag: setup.breakoutFailureFlag,
      exhaustionScore: setup.exhaustionScore
    });

    // 15m context (diagnostic, not a hard filter)
    if (htf15.length >= 30) {
      const htf = classifyHtfStructure(htf15, { swingLookback: 2 });
      baseTelemetry.htf15StructureState = htf.state;
      baseTelemetry.htf15StructureStrength = htf.strength;
      baseTelemetry.htf15SwingHigh = htf.lastSwingHigh?.price ?? null;
      baseTelemetry.htf15SwingLow = htf.lastSwingLow?.price ?? null;
      if (setup.breakoutDirection && htf.state !== "NEUTRAL") {
        baseTelemetry.htf15Aligned =
          (setup.breakoutDirection === "BUY" && htf.state === "BULLISH") ||
          (setup.breakoutDirection === "SELL" && htf.state === "BEARISH");
      }
    }

    if (setup.state === "EXHAUSTED") {
      return holdWith(this, ts, ["EXHAUSTED"], baseTelemetry);
    }
    if (setup.state === "BREAKOUT_FAILED") {
      return holdWith(this, ts, ["BREAKOUT_FAILED"], baseTelemetry);
    }
    if (setup.state !== "RETEST_ACCEPTED") {
      return holdWith(this, ts, ["NOT_RETEST_ACCEPTED"], baseTelemetry);
    }

    const direction = setup.breakoutDirection;
    if (direction == null || setup.breakoutLevel == null) {
      return holdWith(this, ts, ["NOT_RETEST_ACCEPTED"], baseTelemetry);
    }

    // Optional 1m refinement: micro continuation after 5m acceptance
    if (params.executionTimeframe === "1m") {
      const micro = candles.slice(Math.max(0, i - 30), i + 1);
      const ok = microContinuation(micro, direction);
      if (!ok) {
        return holdWith(this, ts, ["NO_1M_REFINEMENT"], baseTelemetry);
      }
    }

    const feat = context.features[i];
    const atr = feat?.atr ?? null;
    if (atr == null || atr <= 0) {
      return holdWith(this, ts, ["INDICATORS_UNAVAILABLE"], baseTelemetry);
    }

    const pullbackLow = direction === "BUY" ? setup.retestLow : null;
    const pullbackHigh = direction === "SELL" ? setup.retestHigh : null;
    const stopRef = direction === "BUY" ? pullbackLow : pullbackHigh;
    if (stopRef == null) {
      return holdWith(this, ts, ["STOP_INVALID"], baseTelemetry);
    }
    const buffer = atr * params.structureBufferAtr;
    const stop = direction === "BUY" ? stopRef - buffer : stopRef + buffer;
    const entryMid = candle.close;
    const stopDistance = Math.abs(entryMid - stop);
    if (
      stopDistance <= 0 ||
      (direction === "BUY" && stop >= entryMid) ||
      (direction === "SELL" && stop <= entryMid)
    ) {
      return holdWith(this, ts, ["STOP_INVALID"], baseTelemetry);
    }

    // Target room: next 15m swing or compression-range projection
    let targetRef: number | null = null;
    const projectedRange =
      setup.compressionRangeAtr != null ? setup.compressionRangeAtr * atr : null;
    if (typeof baseTelemetry.htf15SwingHigh === "number" && direction === "BUY") {
      targetRef = baseTelemetry.htf15SwingHigh as number;
    } else if (typeof baseTelemetry.htf15SwingLow === "number" && direction === "SELL") {
      targetRef = baseTelemetry.htf15SwingLow as number;
    }
    if (targetRef == null && projectedRange != null && setup.breakoutLevel != null) {
      targetRef =
        direction === "BUY"
          ? setup.breakoutLevel + projectedRange
          : setup.breakoutLevel - projectedRange;
    }

    let structureRoomR: number | null = null;
    let projectedRangeTarget: number | null = targetRef;
    if (targetRef != null) {
      const room = direction === "BUY" ? targetRef - entryMid : entryMid - targetRef;
      if (room > 0) structureRoomR = room / stopDistance;
    }
    baseTelemetry.structuralRoomR = structureRoomR;
    baseTelemetry.projectedRangeTarget = projectedRangeTarget;
    baseTelemetry.intendedR = params.intendedTargetR;
    baseTelemetry.targetStructureReference = targetRef;
    baseTelemetry.stopStructureReference = stopRef;

    if (structureRoomR == null || structureRoomR < params.minStructureRoomR) {
      return holdWith(this, ts, ["TARGET_ROOM_INSUFFICIENT"], baseTelemetry);
    }

    const confidence = Math.min(
      0.95,
      Math.max(
        params.minimumConfidence,
        0.5 + (setup.acceptanceScore ?? 0.5) * 0.2 + (setup.expansionStrength ?? 0) * 0.15
      )
    );

    return {
      action: direction,
      confidence: Number(confidence.toFixed(4)),
      entryReason: [
        `VOL ${setup.state} ${direction}`,
        `retest depthAtr=${setup.retestDepthAtr}`,
        `acceptance=${setup.acceptanceScore}`,
        `roomR=${structureRoomR.toFixed(2)}`
      ],
      invalidationReason: [],
      proposedStake: null,
      expiryDuration: params.expiryCandles,
      expiryUnit: "m",
      signalTimestamp: ts,
      strategyId: this.id,
      strategyVersion: this.version,
      metadata: {
        ...baseTelemetry,
        pullbackLow,
        pullbackHigh,
        intendedR: params.intendedTargetR,
        structuralRoomR: structureRoomR,
        reasonCodes: ["SIGNAL"]
      }
    };
  }
}

function microContinuation(
  candles: ReadonlyArray<import("@regimex/shared").Candle>,
  direction: "BUY" | "SELL"
): boolean {
  if (candles.length < 5) return false;
  const c = candles[candles.length - 1]!;
  const pivots = findConfirmedSwingPivots(candles, candles.length - 1, 2);
  if (direction === "BUY") {
    const hi = latestSwingOfKind(pivots, "high");
    const level = hi?.price ?? Math.max(...candles.slice(-6, -1).map((x) => x.high));
    return c.close > level && c.close > c.open;
  }
  const lo = latestSwingOfKind(pivots, "low");
  const level = lo?.price ?? Math.min(...candles.slice(-6, -1).map((x) => x.low));
  return c.close < level && c.close < c.open;
}
