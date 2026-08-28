/** Supported candle intervals. Extend cautiously — aggregation must stay deterministic. */
export const CANDLE_INTERVALS = ["1m", "5m"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "5m": 300
};

export type CandleSource =
  | "LIVE_TICKS" // Deriv live ticks (legacy name retained for backward compatibility)
  | "HISTORY_API" // Deriv historical / research backfill
  | "SEED"
  | "MT5_LIVE_TICKS"; // MT5 broker live quotes — broker_demo_mt5 session domain

/**
 * Engine-facing candle. Times are epoch milliseconds (UTC).
 * Prices are numbers; persistence uses Postgres NUMERIC and rounds
 * via the symbol's price precision at the storage boundary.
 */
export interface Candle {
  symbol: string;
  interval: CandleInterval;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  isComplete: boolean;
  source: CandleSource;
}

export interface Tick {
  symbol: string;
  /** Epoch milliseconds. */
  epochMs: number;
  quote: number;
}
