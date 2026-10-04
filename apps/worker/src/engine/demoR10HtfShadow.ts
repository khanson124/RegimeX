import type { Candle } from "@regimex/shared";

const MINUTE = 60_000;
export const DEMO_R10_HTF_HISTORY_LIMIT = 6000;
const PERIODS = [15, 240] as const;
const SLOW_PERIOD = 21;
export interface HtfShadowSignal {
  enabled: boolean;
  executionBackend: string;
  mode: string;
  symbol: string;
  interval: string;
  action: string;
  decisionCloseTimeMs: number;
  signalId: string;
  strategyId: string;
  correlationId: string;
}
export interface HtfShadowComparison {
  interval: "15m" | "4h";
  lastCompletedCloseMs: number;
  requiredBars: 21;
  emaFast: number | null;
  emaSlow: number | null;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "INDETERMINATE";
  wouldPassTrendFilter: boolean | null;
  qualityFlags: string[];
}
export function isDemoR10HtfShadowSignal(s: HtfShadowSignal): boolean {
  return s.enabled === true && s.executionBackend === "broker_demo_mt5" && s.mode === "DEMO_TRADING" &&
    s.symbol === "R_10" && s.interval === "1m" && (s.action === "BUY" || s.action === "SELL");
}
function ema(values: number[], period: number): number {
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value += (values[i]! - value) * 2 / (period + 1);
  return value;
}
/** UTC buckets require every constituent minute. No partial bars, forward-fill or future bars. */
export function assessDemoR10HtfShadow(s: HtfShadowSignal, candles: readonly Candle[]) {
  if (!isDemoR10HtfShadowSignal(s)) return null;
  const cutoff = s.decisionCloseTimeMs;
  const byOpen = new Map<number, Candle[]>();
  for (const candle of candles) {
    // Ignore unclosed/future rows altogether, even when marked complete upstream.
    if (candle.openTime >= cutoff || candle.closeTime > cutoff) continue;
    const rows = byOpen.get(candle.openTime) ?? [];
    rows.push(candle); byOpen.set(candle.openTime, rows);
  }
  const comparisons: HtfShadowComparison[] = PERIODS.map(minutes => {
    const step = minutes * MINUTE;
    const lastClose = Math.floor(cutoff / step) * step;
    const flags = new Set<string>();
    const closes: number[] = [];
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff % MINUTE !== 0) flags.add("INVALID_DECISION_TIME");
    for (let bucket = lastClose - SLOW_PERIOD * step; bucket < lastClose; bucket += step) {
      for (let time = bucket; time < bucket + step; time += MINUTE) {
        const rows = byOpen.get(time);
        if (!rows?.length) { flags.add("MISSING_MINUTE_HISTORY"); continue; }
        if (rows.length !== 1) { flags.add("DUPLICATE_MINUTE_HISTORY"); continue; }
        const c = rows[0]!;
        if (c.symbol !== "R_10" || c.interval !== "1m" || !c.isComplete || c.closeTime !== time + MINUTE ||
            (c.source !== "MT5_HISTORY" && c.source !== "MT5_LIVE_TICKS")) flags.add("INVALID_MINUTE_PROVENANCE_OR_TIME");
        if (![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) ||
            c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low > c.high) flags.add("INVALID_MINUTE_OHLC");
        if (time + MINUTE === bucket + step) closes.push(c.close);
      }
    }
    const valid = flags.size === 0 && closes.length === SLOW_PERIOD;
    let fast = valid ? ema(closes, 8) : null;
    let slow = valid ? ema(closes, SLOW_PERIOD) : null;
    if (fast != null && slow != null && (!Number.isFinite(fast) || !Number.isFinite(slow))) {
      flags.add("INVALID_EMA"); fast = null; slow = null;
    }
    const bias = fast == null || slow == null ? "INDETERMINATE" : fast > slow ? "BULLISH" : fast < slow ? "BEARISH" : "NEUTRAL";
    return { interval: minutes === 15 ? "15m" : "4h", lastCompletedCloseMs: lastClose, requiredBars: 21,
      emaFast: fast, emaSlow: slow, bias,
      wouldPassTrendFilter: bias === "INDETERMINATE" ? null : s.action === "BUY" ? bias === "BULLISH" : bias === "BEARISH",
      qualityFlags: [...flags] };
  });
  return { telemetryVersion: 1 as const, observationalOnly: true as const, model: "UTC_COMPLETED_EMA_8_21_LAST_21" as const,
    executionBackend: s.executionBackend, mode: s.mode, symbol: s.symbol, interval: s.interval,
    signalId: s.signalId, strategyId: s.strategyId, correlationId: s.correlationId,
    action: s.action, decisionCloseTimeMs: cutoff, baselineWouldPass: true, comparisons };
}
export type HtfShadowAssessment = NonNullable<ReturnType<typeof assessDemoR10HtfShadow>>;

/** One best-effort DB read at a time per session. Never awaited by the trade pipeline. */
export class DemoR10HtfShadowObserver {
  private busy = false;
  constructor(private readonly read: (cutoff: number) => Promise<Candle[]>,
    private readonly emit: (assessment: HtfShadowAssessment) => void,
    private readonly unavailable: (signal: HtfShadowSignal, reason: string) => void) {}
  observe(signal: HtfShadowSignal): void {
    if (!isDemoR10HtfShadowSignal(signal)) return;
    if (this.busy) { this.report(signal, "RESEARCH_READ_BUSY"); return; }
    this.busy = true;
    void Promise.resolve().then(() => this.read(signal.decisionCloseTimeMs)).then(candles => {
      const assessment = assessDemoR10HtfShadow(signal, candles);
      if (assessment) this.emit(assessment);
    }).catch(() => this.report(signal, "RESEARCH_READ_OR_LOG_FAILED")).finally(() => { this.busy = false; });
  }
  private report(signal: HtfShadowSignal, reason: string): void {
    try { this.unavailable(signal, reason); } catch { /* Observation must never block execution. */ }
  }
}
