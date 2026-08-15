/** Minimal OHLC shape indicators need; independent of DB and UI. */
export interface OhlcCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * All series indicators return arrays aligned with the input:
 * output[i] is computed only from input[0..i] (no look-ahead) and is
 * null while there is insufficient history.
 */
export type Series = ReadonlyArray<number>;
export type NullableSeries = Array<number | null>;
