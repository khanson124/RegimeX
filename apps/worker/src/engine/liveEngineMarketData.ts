import { type Candle, type CandleSource } from "@regimex/shared";
import {
  filterRestorableMt5Candles,
  MT5_RESTORABLE_CANDLE_SOURCES,
  type ExecutionBackend,
  type Mt5CandleValidationDiagnostic
} from "@regimex/trading-engine";

function isMt5ExecutionBackend(executionBackend: ExecutionBackend): boolean {
  return executionBackend === "broker_demo_mt5" || executionBackend === "broker_real_mt5";
}

export function shouldFeedDerivTicksToAggregator(executionBackend: ExecutionBackend): boolean {
  return !isMt5ExecutionBackend(executionBackend);
}

export function shouldSubscribeDerivTicks(executionBackend: ExecutionBackend): boolean {
  return !isMt5ExecutionBackend(executionBackend);
}

export function resolvePersistedCandleSources(executionBackend: ExecutionBackend): CandleSource[] | null {
  if (isMt5ExecutionBackend(executionBackend)) {
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
  interval: Candle["interval"] | string;
  rows: readonly PersistedCandleRow[];
  pricePrecision?: number | null;
  tickSize?: number | null;
}): {
  candles: Candle[];
  rejected: boolean;
  reason: string | null;
  diagnostics: Mt5CandleValidationDiagnostic[];
} {
  const mapped: Candle[] = input.rows.map((r) => ({
    symbol: input.symbol,
    interval: input.interval as Candle["interval"],
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

  if (!isMt5ExecutionBackend(input.executionBackend)) {
    return { candles: mapped, rejected: false, reason: null, diagnostics: [] };
  }

  return filterRestorableMt5Candles(mapped, {
    digits: input.pricePrecision,
    tickSize: input.tickSize
  });
}
