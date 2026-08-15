import {
  type MarketFeatureSnapshot,
  type MarketRegime,
  type RegimeResult,
  type RegimeScores
} from "@regimex/shared";

export const REGIME_CLASSIFIER_VERSION = "rule-based-1.0.0";

/** Configurable thresholds for the rule-based classifier. Stored in DB. */
export interface RegimeThresholds {
  adxTrendThreshold: number;
  adxRangeThreshold: number;
  /** EMA slope (fraction over slope window) considered meaningfully positive. */
  emaSlopeThreshold: number;
  /** Trend score above this = strong trend, else weak trend. */
  strongTrendScore: number;
  weakTrendScore: number;
  rangeScoreThreshold: number;
  breakoutScoreThreshold: number;
  /** ATR%-percentile below this = volatility compression. */
  compressionVolatilityPercentile: number;
  /** ATR%-percentile above this = high-volatility range. */
  highVolatilityPercentile: number;
  /** Bollinger width percentile proxy: width below this absolute value contributes to compression. */
  compressionBollingerWidth: number;
  /** Minimum indicators available before confidence can exceed the cap. */
  minIndicatorsForConfidence: number;
  /** Confidence cap applied when indicators are missing. */
  lowDataConfidenceCap: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  adxTrendThreshold: 25,
  adxRangeThreshold: 20,
  emaSlopeThreshold: 0.0005,
  strongTrendScore: 65,
  weakTrendScore: 45,
  rangeScoreThreshold: 60,
  breakoutScoreThreshold: 65,
  compressionVolatilityPercentile: 25,
  highVolatilityPercentile: 75,
  compressionBollingerWidth: 0.01,
  minIndicatorsForConfidence: 8,
  lowDataConfidenceCap: 0.3
};

export interface RegimeInput {
  features: MarketFeatureSnapshot;
  thresholds?: RegimeThresholds;
}

export interface RegimeClassifier {
  classify(input: RegimeInput): RegimeResult;
}

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/**
 * Deterministic score-based regime classifier.
 * Produces 0-100 component scores, maps them to a regime, and reports
 * human-readable reasons. Confidence is capped when indicators are missing.
 */
export class RuleBasedRegimeClassifier implements RegimeClassifier {
  classify(input: RegimeInput): RegimeResult {
    const f = input.features;
    const t = input.thresholds ?? DEFAULT_REGIME_THRESHOLDS;
    const reasons: string[] = [];

    const availableIndicators = [
      f.emaFast,
      f.emaSlow,
      f.emaLong,
      f.emaFastSlope,
      f.emaSlowSlope,
      f.rsi,
      f.atr,
      f.atrPercent,
      f.adx,
      f.macdHistogram,
      f.bollingerWidth,
      f.donchianHigh,
      f.volatilityPercentile
    ].filter((v) => v !== null).length;

    const scores = this.computeScores(f, t, reasons);
    const { regime, regimeReasons } = this.mapScoresToRegime(f, t, scores);
    reasons.push(...regimeReasons);

    let confidence = this.computeConfidence(regime, scores);
    if (availableIndicators < t.minIndicatorsForConfidence) {
      confidence = Math.min(confidence, t.lowDataConfidenceCap);
      reasons.push(
        `Only ${availableIndicators} indicators available; confidence capped at ${t.lowDataConfidenceCap}`
      );
    }

    return {
      regime: availableIndicators === 0 ? "UNKNOWN" : regime,
      confidence: Number(confidence.toFixed(3)),
      scores,
      reasons,
      timestamp: f.timestamp,
      classifierVersion: REGIME_CLASSIFIER_VERSION
    };
  }

  private computeScores(
    f: MarketFeatureSnapshot,
    t: RegimeThresholds,
    reasons: string[]
  ): RegimeScores {
    // ---- Trend score ----
    let trend = 0;
    const dir = f.trendDirection;
    if (f.emaFast !== null && f.emaSlow !== null) {
      if (f.emaFast > f.emaSlow) {
        trend += 20;
        reasons.push("Fast EMA is above slow EMA");
      } else if (f.emaFast < f.emaSlow) {
        trend += 20;
        reasons.push("Fast EMA is below slow EMA");
      }
    }
    if (f.emaFastSlope !== null && f.emaSlowSlope !== null) {
      const sameSign =
        (f.emaFastSlope > t.emaSlopeThreshold && f.emaSlowSlope > 0) ||
        (f.emaFastSlope < -t.emaSlopeThreshold && f.emaSlowSlope < 0);
      if (sameSign) {
        trend += 25;
        reasons.push("Both EMAs slope in the same direction");
      }
    }
    if (f.adx !== null) {
      if (f.adx >= t.adxTrendThreshold) {
        trend += 30;
        reasons.push(`ADX ${f.adx.toFixed(1)} exceeds trend threshold ${t.adxTrendThreshold}`);
      } else {
        trend += clamp((f.adx / t.adxTrendThreshold) * 30, 0, 29);
      }
    }
    if (f.higherHighCount >= 2 || f.lowerLowCount >= 2) {
      trend += 10;
    }
    if (f.emaLong !== null) {
      if ((dir === 1 && f.close > f.emaLong) || (dir === -1 && f.close < f.emaLong)) {
        trend += 15;
        reasons.push(dir === 1 ? "Price is above long-term EMA" : "Price is below long-term EMA");
      }
    }
    trend = clamp(trend);

    // ---- Momentum score ----
    let momentum = 0;
    if (f.rsi !== null) {
      // Distance from neutral 50, in either direction.
      momentum += clamp((Math.abs(f.rsi - 50) / 30) * 35, 0, 35);
    }
    if (f.macdHistogram !== null && f.close > 0) {
      const histPct = Math.abs(f.macdHistogram) / f.close;
      momentum += clamp((histPct / 0.0005) * 30, 0, 30);
    }
    if (f.recentReturn !== null) {
      momentum += clamp((Math.abs(f.recentReturn) / 0.005) * 35, 0, 35);
    }
    momentum = clamp(momentum);

    // ---- Volatility score ----
    let volatility = 0;
    if (f.volatilityPercentile !== null) {
      volatility += clamp(f.volatilityPercentile * 0.6, 0, 60);
    }
    if (f.bollingerWidth !== null) {
      volatility += clamp((f.bollingerWidth / 0.03) * 40, 0, 40);
    }
    volatility = clamp(volatility);

    // ---- Range score ----
    let range = 0;
    if (f.adx !== null && f.adx < t.adxRangeThreshold) {
      range += 40;
      reasons.push(`ADX ${f.adx.toFixed(1)} is below range threshold ${t.adxRangeThreshold}`);
    }
    if (
      f.emaFastSlope !== null &&
      f.emaSlowSlope !== null &&
      Math.abs(f.emaFastSlope) < t.emaSlopeThreshold &&
      Math.abs(f.emaSlowSlope) < t.emaSlopeThreshold
    ) {
      range += 30;
      reasons.push("Moving averages are flat");
    }
    if (f.priceDistanceFromEma !== null && Math.abs(f.priceDistanceFromEma) < 0.002) {
      range += 15;
    }
    if (f.higherHighCount === 0 && f.lowerLowCount === 0) {
      range += 15;
    }
    range = clamp(range);

    // ---- Breakout score ----
    let breakout = 0;
    if (f.donchianHigh !== null && f.donchianLow !== null) {
      if (f.close > f.donchianHigh) {
        breakout += 40;
        reasons.push("Close is above the recent Donchian high");
      } else if (f.close < f.donchianLow) {
        breakout += 40;
        reasons.push("Close is below the recent Donchian low");
      }
    }
    if (f.volatilityPercentile !== null && f.volatilityPercentile > 60) {
      breakout += 20;
    }
    if (f.bollingerWidth !== null && f.bollingerWidth > 0.015) {
      breakout += 15;
    }
    if (f.macdHistogram !== null && f.recentReturn !== null) {
      const aligned =
        (f.macdHistogram > 0 && f.recentReturn > 0) ||
        (f.macdHistogram < 0 && f.recentReturn < 0);
      if (aligned) breakout += 25;
    }
    breakout = clamp(breakout);

    return {
      trend: Math.round(trend),
      momentum: Math.round(momentum),
      volatility: Math.round(volatility),
      range: Math.round(range),
      breakout: Math.round(breakout)
    };
  }

  private mapScoresToRegime(
    f: MarketFeatureSnapshot,
    t: RegimeThresholds,
    s: RegimeScores
  ): { regime: MarketRegime; regimeReasons: string[] } {
    const reasons: string[] = [];
    const dir = f.trendDirection;

    const compression =
      f.volatilityPercentile !== null &&
      f.volatilityPercentile <= t.compressionVolatilityPercentile &&
      f.bollingerWidth !== null &&
      f.bollingerWidth <= t.compressionBollingerWidth;

    if (s.breakout >= t.breakoutScoreThreshold && s.trend >= t.weakTrendScore) {
      reasons.push("Breakout score exceeds threshold with trend support");
      return { regime: "BREAKOUT_EXPANSION", regimeReasons: reasons };
    }

    if (s.trend >= t.strongTrendScore && dir !== 0) {
      reasons.push("Trend score exceeds strong-trend threshold");
      return {
        regime: dir === 1 ? "STRONG_UPTREND" : "STRONG_DOWNTREND",
        regimeReasons: reasons
      };
    }

    if (s.trend >= t.weakTrendScore && dir !== 0) {
      reasons.push("Trend score is in the weak-trend band");
      return {
        regime: dir === 1 ? "WEAK_UPTREND" : "WEAK_DOWNTREND",
        regimeReasons: reasons
      };
    }

    if (compression) {
      reasons.push("Volatility percentile and Bollinger width indicate compression");
      return { regime: "VOLATILITY_COMPRESSION", regimeReasons: reasons };
    }

    if (s.range >= t.rangeScoreThreshold) {
      const highVol =
        f.volatilityPercentile !== null && f.volatilityPercentile >= t.highVolatilityPercentile;
      reasons.push("Range score exceeds threshold");
      return {
        regime: highVol ? "RANGE_HIGH_VOLATILITY" : "RANGE_LOW_VOLATILITY",
        regimeReasons: reasons
      };
    }

    reasons.push("No component score dominates; treating as transition");
    return { regime: "TRANSITION", regimeReasons: reasons };
  }

  private computeConfidence(regime: MarketRegime, s: RegimeScores): number {
    switch (regime) {
      case "STRONG_UPTREND":
      case "STRONG_DOWNTREND":
        return clamp(s.trend + s.momentum / 4, 0, 100) / 100;
      case "WEAK_UPTREND":
      case "WEAK_DOWNTREND":
        return clamp(s.trend * 0.8, 0, 100) / 100;
      case "RANGE_LOW_VOLATILITY":
      case "RANGE_HIGH_VOLATILITY":
        return clamp(s.range, 0, 100) / 100;
      case "BREAKOUT_EXPANSION":
        return clamp(s.breakout, 0, 100) / 100;
      case "VOLATILITY_COMPRESSION":
        return clamp(100 - s.volatility, 0, 100) / 100;
      case "TRANSITION":
        return 0.35;
      case "UNKNOWN":
        return 0;
    }
  }
}
