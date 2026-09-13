/**
 * Consolidation / structural breakout helpers for xau-trend-breakout-v2.
 * Closed M15 bars only; no lookahead.
 */
import { type Candle } from "@regimex/shared";

export interface ConsolidationRange {
  /** Inclusive start index in M15 series (excludes breakout bar). */
  startIndex: number;
  /** Inclusive end index = breakoutBarIndex - 1. */
  endIndex: number;
  high: number;
  low: number;
  width: number;
  widthAtr: number | null;
  /** Fingerprint for duplicate-structure suppression. */
  structureKey: string;
}

export interface ConsolidationBreakoutSnapshot {
  consolidation: ConsolidationRange | null;
  breakout: boolean;
  direction: "BUY" | "SELL" | null;
  breakoutDistanceAtr: number | null;
  candleRangeAtr: number | null;
  qualityPass: boolean;
  reasons: string[];
}

export function computeConsolidationRange(
  m15: ReadonlyArray<Candle>,
  breakoutBarIndex: number,
  lookback: number,
  atr: number | null
): ConsolidationRange | null {
  if (lookback < 3 || breakoutBarIndex < lookback) return null;
  const start = breakoutBarIndex - lookback;
  const end = breakoutBarIndex - 1;
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= end; i++) {
    const c = m15[i]!;
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  const width = high - low;
  const widthAtr = atr != null && atr > 0 ? width / atr : null;
  return {
    startIndex: start,
    endIndex: end,
    high,
    low,
    width,
    widthAtr,
    structureKey: `${start}:${end}:${high.toFixed(4)}:${low.toFixed(4)}`
  };
}

/** Range width must sit in [minWidthAtr, maxWidthAtr] × ATR when ATR available. */
export function consolidationWidthOk(
  range: ConsolidationRange,
  minWidthAtr: number,
  maxWidthAtr: number
): boolean {
  if (range.widthAtr == null) return range.width > 0;
  return range.widthAtr >= minWidthAtr && range.widthAtr <= maxWidthAtr;
}

export function evaluateConsolidationBreakout(input: {
  m15: ReadonlyArray<Candle>;
  barIndex: number;
  bias: "BULLISH" | "BEARISH";
  atr: number;
  lookback: number;
  minWidthAtr: number;
  maxWidthAtr: number;
  minBreakoutDistanceAtr: number;
  maxBreakoutCandleRangeAtr: number;
  minBreakoutBodyAtr: number;
}): ConsolidationBreakoutSnapshot {
  const reasons: string[] = [];
  const bar = input.m15[input.barIndex];
  if (!bar || input.atr <= 0) {
    return {
      consolidation: null,
      breakout: false,
      direction: null,
      breakoutDistanceAtr: null,
      candleRangeAtr: null,
      qualityPass: false,
      reasons: ["INVALID_BAR"]
    };
  }

  const consolidation = computeConsolidationRange(
    input.m15,
    input.barIndex,
    input.lookback,
    input.atr
  );
  if (consolidation == null) {
    return {
      consolidation: null,
      breakout: false,
      direction: null,
      breakoutDistanceAtr: null,
      candleRangeAtr: null,
      qualityPass: false,
      reasons: ["NO_CONSOLIDATION"]
    };
  }
  if (!consolidationWidthOk(consolidation, input.minWidthAtr, input.maxWidthAtr)) {
    reasons.push("CONSOLIDATION_WIDTH_OUT_OF_RANGE");
    return {
      consolidation,
      breakout: false,
      direction: null,
      breakoutDistanceAtr: null,
      candleRangeAtr: (bar.high - bar.low) / input.atr,
      qualityPass: false,
      reasons
    };
  }

  const candleRangeAtr = (bar.high - bar.low) / input.atr;
  const bodyAtr = Math.abs(bar.close - bar.open) / input.atr;
  let breakout = false;
  let direction: "BUY" | "SELL" | null = null;
  let breakoutDistanceAtr: number | null = null;

  if (input.bias === "BULLISH") {
    breakoutDistanceAtr = (bar.close - consolidation.high) / input.atr;
    if (bar.close > consolidation.high && bar.close > bar.open) {
      breakout = true;
      direction = "BUY";
      reasons.push("BREAK_ABOVE_RANGE_HIGH");
    }
  } else {
    breakoutDistanceAtr = (consolidation.low - bar.close) / input.atr;
    if (bar.close < consolidation.low && bar.close < bar.open) {
      breakout = true;
      direction = "SELL";
      reasons.push("BREAK_BELOW_RANGE_LOW");
    }
  }

  if (!breakout || direction == null || breakoutDistanceAtr == null) {
    reasons.push("NO_BREAKOUT");
    return {
      consolidation,
      breakout: false,
      direction: null,
      breakoutDistanceAtr,
      candleRangeAtr,
      qualityPass: false,
      reasons
    };
  }

  let qualityPass = true;
  if (breakoutDistanceAtr < input.minBreakoutDistanceAtr) {
    qualityPass = false;
    reasons.push("BREAKOUT_DISTANCE_TOO_SMALL");
  }
  if (candleRangeAtr > input.maxBreakoutCandleRangeAtr) {
    qualityPass = false;
    reasons.push("EXHAUSTION_CANDLE");
  }
  if (bodyAtr < input.minBreakoutBodyAtr) {
    qualityPass = false;
    reasons.push("BREAKOUT_BODY_TOO_SMALL");
  }
  if (qualityPass) reasons.push("BREAKOUT_QUALITY_OK");

  return {
    consolidation,
    breakout: true,
    direction,
    breakoutDistanceAtr,
    candleRangeAtr,
    qualityPass,
    reasons
  };
}

/**
 * Retest entry: find a qualifying breakout in the prior 1..maxRetestDelay bars,
 * then require current bar to touch the broken level and close back in trend direction.
 */
export function evaluateBreakoutRetest(input: {
  m15: ReadonlyArray<Candle>;
  barIndex: number;
  bias: "BULLISH" | "BEARISH";
  atr: number;
  lookback: number;
  minWidthAtr: number;
  maxWidthAtr: number;
  minBreakoutDistanceAtr: number;
  maxBreakoutCandleRangeAtr: number;
  minBreakoutBodyAtr: number;
  maxRetestDelayBars: number;
  retestTouchAtr: number;
}): {
  ok: boolean;
  direction: "BUY" | "SELL" | null;
  breakoutBarIndex: number | null;
  consolidation: ConsolidationRange | null;
  reasons: string[];
} {
  const reasons: string[] = [];
  const cur = input.m15[input.barIndex];
  if (!cur || input.atr <= 0) {
    return {
      ok: false,
      direction: null,
      breakoutBarIndex: null,
      consolidation: null,
      reasons: ["INVALID_BAR"]
    };
  }

  const delay = Math.max(1, input.maxRetestDelayBars);
  for (let back = 1; back <= delay; back++) {
    const bIdx = input.barIndex - back;
    if (bIdx < input.lookback) break;
    const snap = evaluateConsolidationBreakout({
      m15: input.m15,
      barIndex: bIdx,
      bias: input.bias,
      atr: input.atr,
      lookback: input.lookback,
      minWidthAtr: input.minWidthAtr,
      maxWidthAtr: input.maxWidthAtr,
      minBreakoutDistanceAtr: input.minBreakoutDistanceAtr,
      maxBreakoutCandleRangeAtr: input.maxBreakoutCandleRangeAtr,
      minBreakoutBodyAtr: input.minBreakoutBodyAtr
    });
    if (!snap.breakout || !snap.qualityPass || snap.consolidation == null || snap.direction == null) {
      continue;
    }
    const level =
      snap.direction === "BUY" ? snap.consolidation.high : snap.consolidation.low;
    const touch =
      snap.direction === "BUY"
        ? cur.low <= level + input.atr * input.retestTouchAtr
        : cur.high >= level - input.atr * input.retestTouchAtr;
    const reclaim =
      snap.direction === "BUY" ? cur.close > level && cur.close > cur.open : cur.close < level && cur.close < cur.open;
    if (touch && reclaim) {
      reasons.push(`RETEST_OF_BREAKOUT_BAR_${back}`, ...snap.reasons);
      return {
        ok: true,
        direction: snap.direction,
        breakoutBarIndex: bIdx,
        consolidation: snap.consolidation,
        reasons
      };
    }
  }
  reasons.push("NO_RETEST_ENTRY");
  return {
    ok: false,
    direction: null,
    breakoutBarIndex: null,
    consolidation: null,
    reasons
  };
}
