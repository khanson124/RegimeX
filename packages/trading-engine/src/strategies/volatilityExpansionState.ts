/**
 * Deterministic volatility-state machine for XAU expansion-retest research.
 * Advances using only completed bars — no future leakage.
 */
import { type Candle } from "@regimex/shared";

export type VolatilityState =
  | "COMPRESSION"
  | "EXPANSION_INITIATED"
  | "EXPANSION_CONFIRMED"
  | "RETEST_IN_PROGRESS"
  | "RETEST_ACCEPTED"
  | "BREAKOUT_FAILED"
  | "EXHAUSTED"
  | "NEUTRAL";

export interface VolatilityStateParams {
  compressionLookback: number;
  maxNormalizedRange: number;
  minCompressionBars: number;
  minExpansionRangeAtr: number;
  minBreakoutBodyAtr: number;
  minCloseLocation: number;
  retestZoneWidthAtr: number;
  maxRetestDelayBars: number;
  maxChaseExtensionAtr: number;
  minAcceptanceCloseBeyondAtr: number;
  exhaustionExtensionAtr: number;
}

export interface VolatilitySetupSnapshot {
  state: VolatilityState;
  compressionScore: number;
  compressionDurationBars: number;
  compressionRangeAtr: number | null;
  normalizedRange: number | null;
  normalizedAtr: number | null;
  bandWidthNorm: number | null;
  breakoutDirection: "BUY" | "SELL" | null;
  breakoutLevel: number | null;
  breakoutDistanceAtr: number | null;
  expansionStrength: number | null;
  expansionBarRangeAtr: number | null;
  expansionCloseLocation: number | null;
  barsSinceExpansion: number | null;
  maxExtensionSinceExpansionAtr: number | null;
  retestWindowRemaining: number | null;
  retestSeen: boolean;
  retestDepthAtr: number | null;
  retestDistanceFromBreakout: number | null;
  retestZoneWidthAtr: number | null;
  acceptanceScore: number | null;
  breakoutFailureFlag: boolean;
  exhaustionScore: number | null;
  retestLow: number | null;
  retestHigh: number | null;
  compressionHigh: number | null;
  compressionLow: number | null;
  reasonCodes: string[];
}

export interface VolatilityFunnelCounts {
  compressionDetected: number;
  expansionDetected: number;
  retestObserved: number;
  accepted: number;
  failed: number;
  exhausted: number;
  expired: number;
}

function wilderAtr(candles: ReadonlyArray<Candle>, endInclusive: number, period: number): number | null {
  const usePeriod = Math.min(period, Math.max(3, Math.floor(endInclusive / 2)));
  if (endInclusive < usePeriod) return null;
  const start = Math.max(1, endInclusive - usePeriod * 3);
  const trs: number[] = [];
  for (let i = Math.max(1, start); i <= endInclusive; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < usePeriod) return null;
  let atr = trs.slice(0, usePeriod).reduce((a, b) => a + b, 0) / usePeriod;
  for (let i = usePeriod; i < trs.length; i++) atr = (atr * (usePeriod - 1) + trs[i]!) / usePeriod;
  return atr;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function percentileRank(value: number, sample: number[]): number {
  if (sample.length === 0) return 0.5;
  const below = sample.filter((x) => x <= value).length;
  return below / sample.length;
}

function emptySnapshot(extras?: Partial<VolatilitySetupSnapshot>): VolatilitySetupSnapshot {
  return {
    state: "NEUTRAL",
    compressionScore: 0,
    compressionDurationBars: 0,
    compressionRangeAtr: null,
    normalizedRange: null,
    normalizedAtr: null,
    bandWidthNorm: null,
    breakoutDirection: null,
    breakoutLevel: null,
    breakoutDistanceAtr: null,
    expansionStrength: null,
    expansionBarRangeAtr: null,
    expansionCloseLocation: null,
    barsSinceExpansion: null,
    maxExtensionSinceExpansionAtr: null,
    retestWindowRemaining: null,
    retestSeen: false,
    retestDepthAtr: null,
    retestDistanceFromBreakout: null,
    retestZoneWidthAtr: null,
    acceptanceScore: null,
    breakoutFailureFlag: false,
    exhaustionScore: null,
    retestLow: null,
    retestHigh: null,
    compressionHigh: null,
    compressionLow: null,
    reasonCodes: [],
    ...extras
  };
}

function compressionMetrics(
  candles: ReadonlyArray<Candle>,
  i: number,
  lookback: number,
  atr: number
): {
  score: number;
  duration: number;
  rangeAtr: number;
  normalizedRange: number;
  normalizedAtr: number;
  bandWidthNorm: number;
  high: number;
  low: number;
} {
  const from = Math.max(0, i - lookback + 1);
  const window = candles.slice(from, i + 1);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const range = high - low;
  const rangeAtr = range / atr;
  const ranges = window.map((c) => c.high - c.low);
  const avgRange = mean(ranges);
  const normalizedRange = avgRange / atr;
  // ATR vs longer baseline
  const longer = wilderAtr(candles, i, Math.min(40, i)) ?? atr;
  const normalizedAtr = atr / Math.max(longer, 1e-9);
  // Pseudo band width: (high-low of closes) / atr
  const closes = window.map((c) => c.close);
  const bandWidthNorm = (Math.max(...closes) - Math.min(...closes)) / atr;
  // Directional efficiency: |net| / path
  let path = 0;
  for (let k = 1; k < window.length; k++) path += Math.abs(window[k]!.close - window[k - 1]!.close);
  const net = Math.abs(window[window.length - 1]!.close - window[0]!.close);
  const efficiency = path > 0 ? net / path : 1;
  // Inside-bar-ish: fraction of bars with range < median range
  const medRange = [...ranges].sort((a, b) => a - b)[Math.floor(ranges.length / 2)] ?? avgRange;
  const insideFrac = ranges.filter((r) => r <= medRange).length / ranges.length;

  let score = 0;
  if (rangeAtr <= 2.2) score += 0.25;
  if (normalizedRange <= 0.7) score += 0.2;
  if (normalizedAtr <= 0.9) score += 0.15;
  if (bandWidthNorm <= 1.5) score += 0.15;
  if (efficiency <= 0.45) score += 0.15;
  if (insideFrac >= 0.55) score += 0.1;

  // Duration: consecutive soft-compression bars using current atr scale
  let duration = 0;
  for (let k = i; k >= from; k--) {
    const r = (candles[k]!.high - candles[k]!.low) / atr;
    if (r > 1.15) break;
    duration++;
  }

  return {
    score: Number(score.toFixed(4)),
    duration,
    rangeAtr: Number(rangeAtr.toFixed(4)),
    normalizedRange: Number(normalizedRange.toFixed(4)),
    normalizedAtr: Number(normalizedAtr.toFixed(4)),
    bandWidthNorm: Number(bandWidthNorm.toFixed(4)),
    high,
    low
  };
}

interface ActiveSetup {
  state: VolatilityState;
  direction: "BUY" | "SELL";
  level: number;
  compressionHigh: number;
  compressionLow: number;
  expansionIndex: number;
  maxExtensionAtr: number;
  retestSeen: boolean;
  retestLow: number;
  retestHigh: number;
  compressionScore: number;
  compressionDuration: number;
  compressionRangeAtr: number;
  expansionStrength: number;
  expansionBarRangeAtr: number;
  expansionCloseLocation: number;
  breakoutDistanceAtr: number;
}

/**
 * Replay 5m series to asOfIndex and return the live setup snapshot.
 * Only scans a trailing window large enough for compression + retest lifecycle
 * (older setups would already have expired).
 */
export function evaluateVolatilitySetupAsOf(
  candles5m: ReadonlyArray<Candle>,
  asOfIndex: number,
  params: VolatilityStateParams
): VolatilitySetupSnapshot {
  if (asOfIndex < params.compressionLookback + 5) {
    return emptySnapshot({ reasonCodes: ["INSUFFICIENT_HISTORY"] });
  }

  const scanStart = Math.max(
    params.compressionLookback,
    asOfIndex - (params.compressionLookback + params.maxRetestDelayBars + 25)
  );

  let active: ActiveSetup | null = null;
  let lastCompression: ReturnType<typeof compressionMetrics> | null = null;

  for (let i = scanStart; i <= asOfIndex; i++) {
    const atr = wilderAtr(candles5m, i, 14);
    if (atr == null || atr <= 0) continue;
    const c = candles5m[i]!;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const closeLoc = range > 0 ? (c.close - c.low) / range : 0.5;
    const comp = compressionMetrics(candles5m, i, params.compressionLookback, atr);
    lastCompression = comp;

    if (active == null) {
      // Compression must be measured on bars BEFORE the candidate expansion bar.
      if (i < params.compressionLookback + 1) continue;
      const atrPrev = wilderAtr(candles5m, i - 1, 14);
      if (atrPrev == null || atrPrev <= 0) continue;
      const compPrev = compressionMetrics(
        candles5m,
        i - 1,
        params.compressionLookback,
        atrPrev
      );
      lastCompression = compPrev;
      const compressed =
        compPrev.score >= 0.45 &&
        compPrev.duration >= params.minCompressionBars &&
        (compPrev.normalizedRange <= params.maxNormalizedRange ||
          compPrev.rangeAtr <= params.maxNormalizedRange * 2.5);

      if (!compressed) continue;

      const priorFrom = Math.max(0, i - params.compressionLookback);
      const prior = candles5m.slice(priorFrom, i);
      if (prior.length < 3) continue;
      const pHigh = Math.max(...prior.map((x) => x.high));
      const pLow = Math.min(...prior.map((x) => x.low));
      const expansionRangeAtr = range / atr;
      const bodyAtr = body / atr;

      const bull =
        c.close > pHigh &&
        expansionRangeAtr >= params.minExpansionRangeAtr &&
        bodyAtr >= params.minBreakoutBodyAtr &&
        closeLoc >= params.minCloseLocation;
      const bear =
        c.close < pLow &&
        expansionRangeAtr >= params.minExpansionRangeAtr &&
        bodyAtr >= params.minBreakoutBodyAtr &&
        closeLoc <= 1 - params.minCloseLocation;

      if (!bull && !bear) continue;

      const direction = bull ? "BUY" : "SELL";
      const level = bull ? pHigh : pLow;
      const breakoutDistanceAtr = Math.abs(c.close - level) / atr;
      active = {
        state: breakoutDistanceAtr >= 0.15 ? "EXPANSION_CONFIRMED" : "EXPANSION_INITIATED",
        direction,
        level,
        compressionHigh: pHigh,
        compressionLow: pLow,
        expansionIndex: i,
        maxExtensionAtr: breakoutDistanceAtr,
        retestSeen: false,
        retestLow: c.low,
        retestHigh: c.high,
        compressionScore: compPrev.score,
        compressionDuration: compPrev.duration,
        compressionRangeAtr: (pHigh - pLow) / atrPrev,
        expansionStrength: Number(
          Math.min(
            1,
            expansionRangeAtr / 2 + bodyAtr / 2 + (bull ? closeLoc : 1 - closeLoc) * 0.3
          ).toFixed(4)
        ),
        expansionBarRangeAtr: Number(expansionRangeAtr.toFixed(4)),
        expansionCloseLocation: Number(closeLoc.toFixed(4)),
        breakoutDistanceAtr: Number(breakoutDistanceAtr.toFixed(4))
      };
      if (i === asOfIndex) {
        return snapshotFromActive(active, atr, params, 0, { compression: compPrev });
      }
      continue;
    }

    // Active setup transitions
    const barsSince = i - active.expansionIndex;
    const zone = atr * params.retestZoneWidthAtr;
    let extensionAtr = active.maxExtensionAtr;
    if (active.direction === "BUY") {
      extensionAtr = Math.max(extensionAtr, (c.high - active.level) / atr);
    } else {
      extensionAtr = Math.max(extensionAtr, (active.level - c.low) / atr);
    }
    active.maxExtensionAtr = extensionAtr;

    // Failure: close back through opposite compression side
    const failed =
      active.direction === "BUY"
        ? c.close < active.compressionLow
        : c.close > active.compressionHigh;
    if (failed) {
      active.state = "BREAKOUT_FAILED";
      if (i === asOfIndex) break;
      active = null;
      continue;
    }

    // Exhaustion / chase without retest
    if (!active.retestSeen && extensionAtr >= params.exhaustionExtensionAtr) {
      active.state = "EXHAUSTED";
      if (i === asOfIndex) break;
      active = null;
      continue;
    }
    if (!active.retestSeen && barsSince > params.maxRetestDelayBars) {
      active.state = "NEUTRAL"; // expired
      if (i === asOfIndex) break;
      active = null;
      continue;
    }
    if (!active.retestSeen && extensionAtr >= params.maxChaseExtensionAtr && barsSince >= 2) {
      active.state = "EXHAUSTED";
      if (i === asOfIndex) break;
      active = null;
      continue;
    }

    // Retest zone visit
    const inZone =
      active.direction === "BUY"
        ? c.low <= active.level + zone && c.low >= active.level - zone * 1.5
        : c.high >= active.level - zone && c.high <= active.level + zone * 1.5;

    if (
      inZone &&
      barsSince >= 1 &&
      (active.state === "EXPANSION_INITIATED" ||
        active.state === "EXPANSION_CONFIRMED" ||
        active.state === "RETEST_IN_PROGRESS")
    ) {
      active.retestSeen = true;
      active.state = "RETEST_IN_PROGRESS";
      active.retestLow = Math.min(active.retestLow, c.low);
      active.retestHigh = Math.max(active.retestHigh, c.high);
    }

    // Acceptance after retest
    if (active.retestSeen && active.state === "RETEST_IN_PROGRESS") {
      const beyond =
        active.direction === "BUY"
          ? (c.close - active.level) / atr
          : (active.level - c.close) / atr;
      const bodyOk = body / atr >= params.minBreakoutBodyAtr * 0.6;
      const dirClose = active.direction === "BUY" ? c.close > c.open : c.close < c.open;
      const closeLocOk =
        active.direction === "BUY" ? closeLoc >= 0.55 : closeLoc <= 0.45;
      const acceptanceScore =
        (beyond >= params.minAcceptanceCloseBeyondAtr ? 0.4 : 0) +
        (bodyOk ? 0.25 : 0) +
        (dirClose ? 0.2 : 0) +
        (closeLocOk ? 0.15 : 0);

      if (beyond >= params.minAcceptanceCloseBeyondAtr && (bodyOk || closeLocOk) && dirClose) {
        active.state = "RETEST_ACCEPTED";
      } else if (
        active.direction === "BUY"
          ? c.close < active.level - zone
          : c.close > active.level + zone
      ) {
        // Lost the level after retest
        active.state = "BREAKOUT_FAILED";
        if (i === asOfIndex) break;
        active = null;
        continue;
      }

      if (i === asOfIndex && active.state === "RETEST_IN_PROGRESS") {
        // expose acceptanceScore even if not yet accepted
        return snapshotFromActive(active, atr, params, barsSince, {
          acceptanceScore: Number(acceptanceScore.toFixed(4)),
          compression: lastCompression
        });
      }
    }

    if (active.state === "EXPANSION_INITIATED" && barsSince >= 1 && extensionAtr >= 0.25) {
      active.state = "EXPANSION_CONFIRMED";
    }

    if (i === asOfIndex) {
      return snapshotFromActive(active, atr, params, barsSince, { compression: lastCompression });
    }

    // Accepted setups expire next bar if not consumed by strategy (strategy decides entry)
    if (active.state === "RETEST_ACCEPTED" && i < asOfIndex) {
      // Keep accepted only on the acceptance bar; later bars require fresh acceptance or stay accepted briefly
      if (barsSince > params.maxRetestDelayBars) {
        active = null;
      }
    }
  }

  if (active) {
    const atr = wilderAtr(candles5m, asOfIndex, 14) ?? 1;
    return snapshotFromActive(active, atr, params, asOfIndex - active.expansionIndex, {
      compression: lastCompression
    });
  }

  if (lastCompression && lastCompression.score >= 0.55) {
    return emptySnapshot({
      state: "COMPRESSION",
      compressionScore: lastCompression.score,
      compressionDurationBars: lastCompression.duration,
      compressionRangeAtr: lastCompression.rangeAtr,
      normalizedRange: lastCompression.normalizedRange,
      normalizedAtr: lastCompression.normalizedAtr,
      bandWidthNorm: lastCompression.bandWidthNorm,
      compressionHigh: lastCompression.high,
      compressionLow: lastCompression.low,
      reasonCodes: ["IN_COMPRESSION"]
    });
  }

  return emptySnapshot({ reasonCodes: ["NEUTRAL"] });
}

function snapshotFromActive(
  active: ActiveSetup,
  atr: number,
  params: VolatilityStateParams,
  barsSince: number,
  opts?: {
    acceptanceScore?: number | null;
    compression?: ReturnType<typeof compressionMetrics> | null;
  }
): VolatilitySetupSnapshot {
  const zone = params.retestZoneWidthAtr;
  const retestDepth =
    active.retestSeen && active.direction === "BUY"
      ? (active.level - active.retestLow) / atr
      : active.retestSeen
        ? (active.retestHigh - active.level) / atr
        : null;
  const exhaustionScore = Math.min(
    1,
    active.maxExtensionAtr / Math.max(params.exhaustionExtensionAtr, 0.1)
  );
  return emptySnapshot({
    state: active.state,
    compressionScore: active.compressionScore,
    compressionDurationBars: active.compressionDuration,
    compressionRangeAtr: active.compressionRangeAtr,
    normalizedRange: opts?.compression?.normalizedRange ?? null,
    normalizedAtr: opts?.compression?.normalizedAtr ?? null,
    bandWidthNorm: opts?.compression?.bandWidthNorm ?? null,
    breakoutDirection: active.direction,
    breakoutLevel: active.level,
    breakoutDistanceAtr: active.breakoutDistanceAtr,
    expansionStrength: active.expansionStrength,
    expansionBarRangeAtr: active.expansionBarRangeAtr,
    expansionCloseLocation: active.expansionCloseLocation,
    barsSinceExpansion: barsSince,
    maxExtensionSinceExpansionAtr: Number(active.maxExtensionAtr.toFixed(4)),
    retestWindowRemaining: Math.max(0, params.maxRetestDelayBars - barsSince),
    retestSeen: active.retestSeen,
    retestDepthAtr: retestDepth != null ? Number(retestDepth.toFixed(4)) : null,
    retestDistanceFromBreakout: retestDepth,
    retestZoneWidthAtr: zone,
    acceptanceScore: opts?.acceptanceScore ?? (active.state === "RETEST_ACCEPTED" ? 1 : null),
    breakoutFailureFlag: active.state === "BREAKOUT_FAILED",
    exhaustionScore: Number(exhaustionScore.toFixed(4)),
    retestLow: active.retestLow,
    retestHigh: active.retestHigh,
    compressionHigh: active.compressionHigh,
    compressionLow: active.compressionLow,
    reasonCodes: [active.state]
  });
}

/** Scan full 5m series for funnel transition counts (single pass). */
export function countVolatilityFunnel(
  candles5m: ReadonlyArray<Candle>,
  params: VolatilityStateParams
): VolatilityFunnelCounts {
  const counts: VolatilityFunnelCounts = {
    compressionDetected: 0,
    expansionDetected: 0,
    retestObserved: 0,
    accepted: 0,
    failed: 0,
    exhausted: 0,
    expired: 0
  };
  let prev: VolatilityState = "NEUTRAL";
  // Sample every bar but use trailing-window evaluate (bounded cost).
  const step = candles5m.length > 800 ? 2 : 1;
  for (let i = params.compressionLookback; i < candles5m.length; i += step) {
    const snap = evaluateVolatilitySetupAsOf(candles5m, i, params);
    if (snap.state === "COMPRESSION" && prev !== "COMPRESSION") counts.compressionDetected++;
    if (
      (snap.state === "EXPANSION_INITIATED" || snap.state === "EXPANSION_CONFIRMED") &&
      prev !== "EXPANSION_INITIATED" &&
      prev !== "EXPANSION_CONFIRMED"
    ) {
      counts.expansionDetected++;
    }
    if (snap.state === "RETEST_IN_PROGRESS" && prev !== "RETEST_IN_PROGRESS" && snap.retestSeen) {
      counts.retestObserved++;
    }
    if (snap.state === "RETEST_ACCEPTED" && prev !== "RETEST_ACCEPTED") counts.accepted++;
    if (snap.state === "BREAKOUT_FAILED" && prev !== "BREAKOUT_FAILED") counts.failed++;
    if (snap.state === "EXHAUSTED" && prev !== "EXHAUSTED") counts.exhausted++;
    if (
      prev !== "NEUTRAL" &&
      snap.state === "NEUTRAL" &&
      (prev === "EXPANSION_CONFIRMED" ||
        prev === "EXPANSION_INITIATED" ||
        prev === "RETEST_IN_PROGRESS")
    ) {
      counts.expired++;
    }
    prev = snap.state;
  }
  return counts;
}

export { percentileRank };
