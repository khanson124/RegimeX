import { type Candle, type CandleInterval, CANDLE_INTERVALS } from "@regimex/shared";

/**
 * Research-only candle intervals. Production/live contracts remain `1m` | `5m`
 * ({@link CANDLE_INTERVALS} / engine schemas). Do not add `15m` to shared live types.
 */
export const RESEARCH_CANDLE_INTERVALS = ["1m", "5m", "15m"] as const;
export type ResearchCandleInterval = (typeof RESEARCH_CANDLE_INTERVALS)[number];

export const RESEARCH_CANDLE_INTERVAL_SECONDS: Record<ResearchCandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900
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
 * Tag a research HTF bar for the CFD backtester without widening production CandleInterval.
 * Runtime `interval` may be `"15m"`; TypeScript production unions stay `1m`|`5m`.
 */
export function toBacktestCandle(
  candle: Omit<Candle, "interval"> & { interval: ResearchCandleInterval }
): Candle {
  return {
    ...candle,
    interval: candle.interval as CandleInterval
  };
}

/** Assert production schema interval enum was not widened for research. */
export function assertProductionIntervalsUnchanged(): void {
  if (CANDLE_INTERVALS.length !== 2 || CANDLE_INTERVALS[0] !== "1m" || CANDLE_INTERVALS[1] !== "5m") {
    throw new Error("Production CANDLE_INTERVALS mutated; research must not widen live contracts");
  }
}
