import { type Candle, type CandleInterval, CANDLE_INTERVALS } from "@regimex/shared";

/**
 * Research candle intervals. Production/live contracts are `1m` | `5m` | `15m`
 * ({@link CANDLE_INTERVALS}). `4h` remains research-only (aggregated; not a live engine interval).
 */
export const RESEARCH_CANDLE_INTERVALS = ["1m", "5m", "15m", "4h"] as const;
export type ResearchCandleInterval = (typeof RESEARCH_CANDLE_INTERVALS)[number];

export const RESEARCH_CANDLE_INTERVAL_SECONDS: Record<ResearchCandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "4h": 14_400
};

export function isProductionCandleInterval(interval: string): interval is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(interval);
}

export function isResearchCandleInterval(interval: string): interval is ResearchCandleInterval {
  return (RESEARCH_CANDLE_INTERVALS as readonly string[]).includes(interval);
}

export function researchIntervalMs(interval: ResearchCandleInterval): number {
  return RESEARCH_CANDLE_INTERVAL_SECONDS[interval] * 1000;
}

export function researchCandleOpenTime(epochMs: number, interval: ResearchCandleInterval): number {
  const ms = researchIntervalMs(interval);
  return Math.floor(epochMs / ms) * ms;
}

export function researchCandleCloseTime(openTime: number, interval: ResearchCandleInterval): number {
  return openTime + researchIntervalMs(interval);
}

/**
 * Tag a research HTF bar for the CFD backtester.
 * Production unions are `1m`|`5m`|`15m`; research-only `4h` is cast for backtest candles.
 */
export function toBacktestCandle(
  candle: Omit<Candle, "interval"> & { interval: ResearchCandleInterval }
): Candle {
  return {
    ...candle,
    interval: candle.interval as CandleInterval
  };
}

/** Assert production schema interval enum stays the locked live set (includes 15m). */
export function assertProductionIntervalsUnchanged(): void {
  if (
    CANDLE_INTERVALS.length !== 3 ||
    CANDLE_INTERVALS[0] !== "1m" ||
    CANDLE_INTERVALS[1] !== "5m" ||
    CANDLE_INTERVALS[2] !== "15m"
  ) {
    throw new Error(
      "Production CANDLE_INTERVALS mutated; expected locked live set [1m, 5m, 15m]"
    );
  }
}
