import type { Candle } from "@regimex/shared";
import { findConfirmedSwingPivots } from "@regimex/trading-engine/structure-swings";
import { isDemoR10HtfShadowSignal, type HtfShadowSignal } from "../engine/demoR10HtfShadow.js";
import { isDemoR10StudyTrade, type StudyTrade } from "./demoR10HtfStudy.js";

export const R10_SR_MODEL = "UTC_M15_48_SWING_3_ATR14_ZONE_0_1";
const MINUTE = 60_000;
const STEP = 15 * MINUTE;
const BARS = 48;
const LOOKBACK = 3;
export interface SrEntry { entryPrice: number | null; initialStopLoss: number | null }
/** Descriptive entry context only; no decision, sizing, cooldown or execution capabilities. */
export function assessDemoR10SupportResistance(signal: HtfShadowSignal, history: readonly Candle[], entry: SrEntry) {
  if (!isDemoR10HtfShadowSignal(signal)) return null;
  const cutoff = signal.decisionCloseTimeMs;
  const lastClose = Math.floor(cutoff / STEP) * STEP;
  const flags = new Set<string>();
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || cutoff % MINUTE !== 0) flags.add("INVALID_DECISION_TIME");
  const minutes = new Map<number, Candle[]>();
  for (const c of history) {
    if (c.openTime >= cutoff || c.closeTime > cutoff) continue;
    const rows = minutes.get(c.openTime) ?? []; rows.push(c); minutes.set(c.openTime, rows);
  }
  function minute(time: number): Candle | null {
    const rows = minutes.get(time);
    if (!rows?.length) { flags.add("MISSING_MINUTE_HISTORY"); return null; }
    if (rows.length !== 1) { flags.add("DUPLICATE_MINUTE_HISTORY"); return null; }
    const c = rows[0]!;
    if (c.symbol !== "R_10" || c.interval !== "1m" || !c.isComplete || c.closeTime !== time + MINUTE ||
      !["MT5_HISTORY", "MT5_LIVE_TICKS"].includes(c.source ?? "") ||
      ![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) ||
      c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low > c.high) {
      flags.add("INVALID_MINUTE_HISTORY"); return null;
    }
    return c;
  }
  const bars: Candle[] = [];
  // Require a fixed contiguous window, including signal minutes after the last completed M15 bar.
  const validated: Candle[] = [];
  if (flags.size === 0) {
    for (let t = lastClose - BARS * STEP; t < cutoff; t += MINUTE) {
      const c = minute(t); if (c) validated.push(c);
    }
    for (let start = lastClose - BARS * STEP; start < lastClose; start += STEP) {
      const rows = validated.filter(c => c.openTime >= start && c.openTime < start + STEP);
      if (rows.length !== 15) continue;
      bars.push({ ...rows[0]!, interval: "15m", closeTime: start + STEP, close: rows.at(-1)!.close,
        high: Math.max(...rows.map(c => c.high)), low: Math.min(...rows.map(c => c.low)),
        tickCount: rows.reduce((sum, c) => sum + c.tickCount, 0) });
    }
  }
  const validHistory = flags.size === 0 && bars.length === BARS;
  // Freeze each zone width using only the 14 M15 ranges available when that pivot was confirmed.
  function zoneWidth(asOf: number): number | null {
    if (asOf < 14) return null; // Also require a previous close for all 14 true ranges.
    const ranges = bars.slice(asOf - 13, asOf + 1).map((b, i) => {
      const previousClose = bars[asOf - 14 + i]!.close;
      return Math.max(b.high - b.low, Math.abs(b.high - previousClose), Math.abs(b.low - previousClose));
    });
    const atr = ranges.reduce((a, b) => a + b, 0) / 14;
    return Number.isFinite(atr) && atr > 0 ? atr * .1 : null;
  }
  const width = validHistory ? zoneWidth(BARS - 1) : null;
  if (validHistory && width == null) flags.add("INVALID_ZONE_ATR");
  const levels = width == null ? [] : findConfirmedSwingPivots(bars, BARS - 1, LOOKBACK).flatMap(p => {
    const confirmationIndex = p.index + LOOKBACK;
    const frozenWidth = zoneWidth(confirmationIndex);
    return frozenWidth == null ? [] : [{ kind: p.kind, price: p.price, low: p.price - frozenWidth, high: p.price + frozenWidth,
      zoneAtrAtConfirmation: frozenWidth / .1, pivotCloseMs: p.time, confirmedAtMs: bars[confirmationIndex]!.closeTime }];
  });
  const finitePositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const validEntry = finitePositive(entry.entryPrice);
  const validStop = validEntry && finitePositive(entry.initialStopLoss) &&
    (signal.action === "BUY" ? entry.initialStopLoss < entry.entryPrice! : entry.initialStopLoss > entry.entryPrice!);
  const risk = validStop ? Math.abs(entry.entryPrice! - entry.initialStopLoss!) : null;
  const support = validEntry ? levels.filter(l => l.high < entry.entryPrice!).sort((a,b) => b.high - a.high)[0] ?? null : null;
  const resistance = validEntry ? levels.filter(l => l.low > entry.entryPrice!).sort((a,b) => a.low - b.low)[0] ?? null : null;
  const insideZone = validEntry && levels.some(l => l.low <= entry.entryPrice! && l.high >= entry.entryPrice!);
  const adverse = signal.action === "BUY" ? resistance : support;
  const distance = insideZone ? 0 : adverse && validEntry ? signal.action === "BUY" ? adverse.low - entry.entryPrice! : entry.entryPrice! - adverse.high : null;
  const roomR = risk != null && distance != null && Number.isFinite(distance / risk) ? distance / risk : null;
  const last = validated.at(-1); const previous = validated.at(-2);
  const directionLevels = levels.filter(l => signal.action === "BUY" ? l.kind === "high" : l.kind === "low");
  const crosses = (a: Candle, b: Candle, l: typeof levels[number]) => a.closeTime >= l.confirmedAtMs &&
    (signal.action === "BUY" ? a.close <= l.high && b.close > l.high : a.close >= l.low && b.close < l.low);
  const breakout = last && previous ? directionLevels.some(l => crosses(previous, last, l)) : false;
  const retest = last ? directionLevels.some(l => {
    const overlap = last.low <= l.high && last.high >= l.low;
    const holds = signal.action === "BUY" ? last.close > l.high : last.close < l.low;
    return overlap && holds && validated.slice(1, -1).some((b, i) => crosses(validated[i]!, b, l));
  }) : false;
  const historyCovered = flags.size === 0;
  return { observationalOnly: true as const, model: R10_SR_MODEL, signalId: signal.signalId, strategyId: signal.strategyId,
    action: signal.action, decisionCloseTimeMs: cutoff, lastCompletedM15CloseMs: lastClose,
    historyCovered, qualityFlags: [...flags], confirmedLevels: levels, zoneAtr: width == null ? null : width / .1,
    entryPrice: validEntry ? entry.entryPrice : null, initialStopDistance: risk, nearestSupport: support, nearestResistance: resistance,
    entryInsideZone: historyCovered && validEntry ? insideZone : null, adverseZoneDistance: historyCovered ? distance : null,
    availableRoomR: historyCovered ? roomR : null,
    roomBucket: !historyCovered ? "MISSING_HISTORY" : !validStop ? "INVALID_ENTRY_OR_INITIAL_STOP" : insideZone ? "INSIDE_ZONE" :
      !adverse ? "NO_ADVERSE_LEVEL" : roomR == null ? "INVALID_ENTRY_OR_INITIAL_STOP" : roomR < 1 ? "<1R" : roomR < 2 ? "1–<2R" : "≥2R",
    signalBreaksConfirmedZone: historyCovered ? breakout : null, signalRetestsPriorBreak: historyCovered ? retest : null };
}
export type SrAssessment = NonNullable<ReturnType<typeof assessDemoR10SupportResistance>>;
export interface SrObservation { positionId: string; supportResistance?: SrAssessment }
const AUTO = ["STOP_LOSS", "TAKE_PROFIT", "STRATEGY_EXIT", "TRAILING_STOP", "BREAK_EVEN_STOP", "MAX_HOLD_TIME"];
export function summarizeR10SupportResistance(trades: readonly StudyTrade[], observations: readonly SrObservation[]) {
  const supplied = new Map(observations.map(o => [o.positionId, o.supportResistance]));
  const index = new Map(trades.filter(t => supplied.has(t.id)).map(t => {
    const a = supplied.get(t.id);
    return [t.id, a?.model === R10_SR_MODEL && a.signalId === t.signalId && a.strategyId === t.strategyId && a.action === t.direction ? a : undefined];
  }));
  const rows = trades.filter(isDemoR10StudyTrade).filter(t => index.has(t.id));
  const automatic = rows.filter(t => t.status === "CLOSED" && AUTO.includes(t.closeReason ?? ""));
  function metrics(sample: StudyTrade[]) {
    const valued = sample.filter(t => t.realizedPnl != null && Number.isFinite(t.realizedPnl));
    const wins = valued.filter(t => t.realizedPnl! > 0), losses = valued.filter(t => t.realizedPnl! < 0);
    const profit = wins.reduce((n,t) => n + t.realizedPnl!,0), loss = -losses.reduce((n,t) => n + t.realizedPnl!,0);
    return { trades: sample.length, missingPnl: sample.length-valued.length, wins:wins.length, losses:losses.length,
      netPnl: valued.length ? profit-loss : null, expectancy: valued.length ? (profit-loss)/valued.length : null,
      profitFactor: loss > 0 ? profit/loss : null };
  }
  const group = (sample: StudyTrade[], key: (a: SrAssessment | undefined) => string) =>
    [...new Set(sample.map(t => key(index.get(t.id))))].sort().map(bucket => ({ bucket,
      ...metrics(sample.filter(t => key(index.get(t.id)) === bucket)) }));
  function cohorts(sample: StudyTrade[]) {
    return { automaticBaseline: metrics(sample), room: group(sample, a => a?.roomBucket ?? "UNOBSERVED"),
      breakout: group(sample, a => a?.signalBreaksConfirmedZone == null ? "UNKNOWN" : String(a.signalBreaksConfirmedZone)),
      retest: group(sample, a => a?.signalRetestsPriorBreak == null ? "UNKNOWN" : String(a.signalRetestsPriorBreak)) };
  }
  return { observationalOnly: true, model: R10_SR_MODEL, ...cohorts(automatic),
    excludedManualCloses: rows.filter(t => t.status === "CLOSED" && t.closeReason === "MANUAL").length,
    excludedSafetyOrUnknownCloses: rows.filter(t => t.status === "CLOSED" && t.closeReason !== "MANUAL" && !AUTO.includes(t.closeReason ?? "")).length,
    byStrategyVersion: [...new Set(automatic.map(t => JSON.stringify([t.strategyId,t.strategyVersion])))].map(key => ({ key,
      ...cohorts(automatic.filter(t => JSON.stringify([t.strategyId,t.strategyVersion]) === key)) })),
    limitations: ["Recorded filled entries against levels available at signal time; no executable counterfactual.",
      "No adverse level is not unlimited room. Missing history is not a failed signal.",
      "Small samples, shared MT5 price history, manual level edits and overlapping zones can confound outcomes.",
      "No trading rule, stop, target or risk change; fixed bins are descriptive, not optimized."] };
}
