import { type Candle, type CandleSource } from "@regimex/shared";
import {
  filterRestorableMt5Candles,
  MT5_RESTORABLE_CANDLE_SOURCES,
  type ExecutionBackend
} from "@regimex/trading-engine";

export function shouldFeedDerivTicksToAggregator(executionBackend: ExecutionBackend): boolean {
  return executionBackend !== "broker_demo_mt5";
}

export function shouldSubscribeDerivTicks(executionBackend: ExecutionBackend): boolean {
  return executionBackend !== "broker_demo_mt5";
}

export function resolvePersistedCandleSources(executionBackend: ExecutionBackend): CandleSource[] | null {
  if (executionBackend === "broker_demo_mt5") {
    return [...MT5_RESTORABLE_CANDLE_SOURCES];
  }
  return null;
}

export interface PersistedCandleRow {
  openTime: Date;
  closeTime: Date;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  tickCount: number;
  source: string;
}

export function mapRestoredSessionCandles(input: {
  executionBackend: ExecutionBackend;
  symbol: string;
  interval: Candle["interval"];
  rows: readonly PersistedCandleRow[];
}): { candles: Candle[]; rejected: boolean; reason: string | null } {
  const mapped: Candle[] = input.rows.map((r) => ({
    symbol: input.symbol,
    interval: input.interval,
    openTime: r.openTime.getTime(),
    closeTime: r.closeTime.getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    tickCount: r.tickCount,
    isComplete: true,
    source: r.source as Candle["source"]
  }));

  if (input.executionBackend !== "broker_demo_mt5") {
    return { candles: mapped, rejected: false, reason: null };
  }

  return filterRestorableMt5Candles(mapped);
}
