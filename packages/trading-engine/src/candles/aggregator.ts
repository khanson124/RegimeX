import {
  candleCloseTime,
  candleOpenTime,
  intervalMs,
  roundPrice,
  type Candle,
  type CandleInterval,
  type Tick
} from "@regimex/shared";

export interface CandleAggregatorOptions {
  symbol: string;
  interval: CandleInterval;
  pricePrecision: number;
  /** Called exactly once per completed candle, in order. */
  onCandleClosed: (candle: Candle) => void;
  /** Called on updates to the in-progress candle (throttling is the caller's job). */
  onCandleUpdated?: (candle: Candle) => void;
}

/**
 * Deterministic tick→OHLC aggregator for one symbol+interval.
 *
 * - Closes candles strictly on bucket boundaries derived from tick timestamps.
 * - Ignores duplicate ticks (same epoch) and out-of-order ticks older than
 *   the current bucket (they cannot be applied deterministically).
 * - Emits empty-gap awareness: if ticks jump multiple buckets, the current
 *   candle is closed and the gap is reported via `detectGaps`.
 * - Can be restored after a restart with `restore()`.
 */
export class CandleAggregator {
  private current: Candle | null = null;
  private lastTickEpoch = 0;
  private readonly gaps: Array<{ fromCloseTime: number; toOpenTime: number }> = [];

  constructor(private readonly options: CandleAggregatorOptions) {}

  /** Restore the in-progress candle after a process restart. */
  restore(candle: Candle | null): void {
    this.current = candle;
    if (candle) this.lastTickEpoch = candle.openTime;
  }

  get currentCandle(): Candle | null {
    return this.current;
  }

  /** Gaps observed since start (missing buckets between processed candles). */
  drainGaps(): Array<{ fromCloseTime: number; toOpenTime: number }> {
    return this.gaps.splice(0);
  }

  processTick(tick: Tick): void {
    if (tick.symbol !== this.options.symbol) return;
    if (tick.epochMs <= this.lastTickEpoch) return; // duplicate or out-of-order
    this.lastTickEpoch = tick.epochMs;

    const { interval, pricePrecision } = this.options;
    const openTime = candleOpenTime(tick.epochMs, interval);
    const quote = roundPrice(tick.quote, pricePrecision);

    if (this.current && openTime > this.current.openTime) {
      // Close the previous candle before starting a new bucket.
      const closed: Candle = { ...this.current, isComplete: true };
      this.current = null;
      this.options.onCandleClosed(closed);

      if (openTime > closed.closeTime) {
        this.gaps.push({ fromCloseTime: closed.closeTime, toOpenTime: openTime });
      }
    }

    if (!this.current) {
      this.current = {
        symbol: this.options.symbol,
        interval,
        openTime,
        closeTime: candleCloseTime(openTime, interval),
        open: quote,
        high: quote,
        low: quote,
        close: quote,
        tickCount: 1,
        isComplete: false,
        source: "LIVE_TICKS"
      };
    } else {
      this.current = {
        ...this.current,
        high: Math.max(this.current.high, quote),
        low: Math.min(this.current.low, quote),
        close: quote,
        tickCount: this.current.tickCount + 1
      };
    }
    this.options.onCandleUpdated?.(this.current);
  }

  /**
   * Force-close the current candle if wall-clock time has passed its close
   * boundary and no tick has arrived (missing-tick handling). Safe to call
   * on a timer.
   */
  flushIfExpired(nowMs: number): void {
    if (this.current && nowMs >= this.current.closeTime) {
      const closed: Candle = { ...this.current, isComplete: true };
      this.current = null;
      this.options.onCandleClosed(closed);
    }
  }
}

/**
 * Detect missing buckets in a chronologically-sorted list of completed
 * candles. Returns [expectedOpenTime, ...] of missing candles.
 */
export function detectMissingBuckets(
  candles: ReadonlyArray<Pick<Candle, "openTime">>,
  interval: CandleInterval
): number[] {
  const missing: number[] = [];
  const step = intervalMs(interval);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.openTime;
    const curr = candles[i]!.openTime;
    for (let t = prev + step; t < curr; t += step) missing.push(t);
  }
  return missing;
}
