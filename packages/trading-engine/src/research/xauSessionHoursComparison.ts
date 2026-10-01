/**
 * Research-only XAUUSD session-hours comparison for xau-trend-pullback-v1.
 *
 * Production-faithful chronological replay (same walk, cooldown, one-position, next-open
 * economics as the risk-cap comparison). Variants differ only in sessionStartHourUtc /
 * sessionEndHourUtc. Risk is held at the DEMO XAU 0.20% cap for every variant.
 *
 * Does not change strategy defaults, DEMO/REAL, risk override code, stops, or the DB.
 */
import {
  type Candle,
  type InstrumentMetadata,
  type PositionDirection
} from "@regimex/shared";
import { MIN_VOLUME_EXCEEDS_RISK } from "../broker/mt5/engineVolume.js";
import { validateCandleOhlc } from "../candles/candleIntegrity.js";
import { XAU_TREND_PULLBACK_H4_MINIMUM_BARS } from "../candles/mt5MtfWarmup.js";
import { XauTrendPullbackStrategy, XAU_TREND_PULLBACK_DEFAULTS } from "../strategies/xauTrendPullback.js";
import { isWithinUtcSessionHours } from "../strategies/xauTrendPullbackHtf.js";
import { type TradingStrategy } from "../strategies/types.js";
import { aggregatePassEconomicMetrics, type ReplaySimulatedTrade } from "./autoSelectionReplayOutcomes.js";
import { analyzeCandleContinuity } from "./autoSelectionReplaySimulationDiagnostics.js";
import {
  XAU_BROKER_MIN_VOLUME,
  XAU_BROKER_VOLUME_STEP,
  XAU_H4_CONTEXT_WINDOW,
  XAU_M15_BUFFER_CAPACITY,
  generateXauTrendPullbackSignals,
  simulateXauProductionFaithfulCap,
  type XauDataIntegrity,
  type XauGroupStats,
  type XauProductionFaithfulCapResult,
  type XauProductionSignalEvent
} from "./xauRiskCapComparison.js";

export const XAU_SESSION_HOURS_STRATEGY_ID = "xau-trend-pullback-v1";
/** Held constant for this study — DEMO XAU override cap; not read from env here. */
export const XAU_SESSION_HOURS_RISK_PERCENT = 0.2;
export const XAU_SESSION_HOURS_LOCKED_PARAM_KEYS = (
  Object.keys(XAU_TREND_PULLBACK_DEFAULTS) as Array<keyof typeof XAU_TREND_PULLBACK_DEFAULTS>
).filter((k) => k !== "sessionStartHourUtc" && k !== "sessionEndHourUtc");

const M15_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAY_MAINTENANCE_MIN_MS = 45 * 60_000;
const WEEKDAY_MAINTENANCE_MAX_MS = 3 * 60 * 60_000;

export interface XauSessionHoursVariantDef {
  id: "CURRENT" | "BROAD_LIQUID" | "ASIA_PLUS_LONDON" | "FULL_WEEKDAY";
  label: string;
  sessionStartHourUtc: number;
  sessionEndHourUtc: number;
  /** Inclusive start, exclusive end, matching isWithinUtcSessionHours. */
  windowLabel: string;
  rationale: string;
}

export const XAU_SESSION_HOURS_VARIANTS: readonly XauSessionHoursVariantDef[] = [
  {
    id: "CURRENT",
    label: "Current production",
    sessionStartHourUtc: 7,
    sessionEndHourUtc: 17,
    windowLabel: "07:00–17:00 UTC",
    rationale:
      "Exact xau-trend-pullback-v1 defaults (sessionStartHourUtc=7, sessionEndHourUtc=17). End hour is exclusive, as isWithinUtcSessionHours."
  },
  {
    id: "BROAD_LIQUID",
    label: "Broader liquid hours",
    sessionStartHourUtc: 6,
    sessionEndHourUtc: 18,
    windowLabel: "06:00–18:00 UTC",
    rationale:
      "Reuses the existing Gold research window session_06_18 from xauTrendPullbackSparsityDiagnostic: modest widening around London (≈07:00–16:00 UTC) and New York overlap (≈13:00–17:00 UTC), plus one adjacent hour on each side. Does not include late New York (18:00–21:00 UTC)."
  },
  {
    id: "ASIA_PLUS_LONDON",
    label: "Asia plus London/NY overlap",
    sessionStartHourUtc: 0,
    sessionEndHourUtc: 17,
    windowLabel: "00:00–17:00 UTC",
    rationale:
      "Adds the Tokyo/Sydney overnight session (00:00–07:00 UTC) onto the production 07:00–17:00 window so extra trades are overnight/Asia rather than late New York. Still exclusive of 17:00+."
  },
  {
    id: "FULL_WEEKDAY",
    label: "All broker-available bars",
    sessionStartHourUtc: 0,
    sessionEndHourUtc: 24,
    windowLabel: "00:00–24:00 UTC (all hours present in the MT5 M15 series)",
    rationale:
      "No session HOLD. Evaluates every complete native M15 bar the broker actually stored. Does not invent bars for weekends or daily maintenance — those remain gaps in the candle series. hour < 24 is always true in isWithinUtcSessionHours(0, 24)."
  }
];

export const XAU_SESSION_HOUR_BUCKETS = [
  { id: "00:00–03:59", startHour: 0, endHour: 4 },
  { id: "04:00–06:59", startHour: 4, endHour: 7 },
  { id: "07:00–09:59", startHour: 7, endHour: 10 },
  { id: "10:00–12:59", startHour: 10, endHour: 13 },
  { id: "13:00–16:59", startHour: 13, endHour: 17 },
  { id: "17:00–20:59", startHour: 17, endHour: 21 },
  { id: "21:00–23:59", startHour: 21, endHour: 24 }
] as const;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function applyXauSessionHours(
  base: Record<string, number | boolean | string>,
  variant: XauSessionHoursVariantDef
): Record<string, number | boolean | string> {
  return {
    ...base,
    sessionStartHourUtc: variant.sessionStartHourUtc,
    sessionEndHourUtc: variant.sessionEndHourUtc
  };
}

export function lockedXauSessionHoursParams(
  params: Record<string, number | boolean | string>
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const k of XAU_SESSION_HOURS_LOCKED_PARAM_KEYS) out[k] = params[k]!;
  return out;
}

export interface XauSessionBucketStats extends XauGroupStats {
  bucket: string;
  admitted: number;
}

export interface XauSessionWeekdayStats extends XauGroupStats {
  weekday: string;
  utcDay: number;
  admitted: number;
}

export interface XauSessionHoursVariantResult {
  def: XauSessionHoursVariantDef;
  parameters: Record<string, number | boolean | string>;
  evaluatedBars: number;
  inSessionBars: number;
  faithful: XauProductionFaithfulCapResult;
  hourBuckets: XauSessionBucketStats[];
  weekdays: XauSessionWeekdayStats[];
}

export interface XauSessionHoursIncrement {
  variantId: XauSessionHoursVariantDef["id"];
  extraSignals: number;
  extraAdmitted: number;
  extraTrades: XauGroupStats;
  extraMaxDrawdownR: number;
  currentSignalsAbsentFromVariant: number;
  currentAdmittedAbsentFromVariant: number;
  extraSignalTimes: string[];
}

export interface XauSessionHoursInterpretation {
  sampleSizeIncreased: Record<string, { currentSignals: number; variantSignals: number; extraSignals: number }>;
  additionalTradesR: Record<string, { extraTrades: number; totalR: number; avgR: number | null; sign: "positive" | "negative" | "flat" }>;
  drawdownChanged: Record<string, { currentMaxDrawdownR: number; variantMaxDrawdownR: number; delta: number }>;
  concentration: string[];
  sampleSizeLimitations: string[];
}

export interface XauSessionHoursComparisonReport {
  generatedAtIso: string;
  kind: "XAU_SESSION_HOURS_COMPARISON";
  config: {
    symbol: string;
    interval: "15m";
    strategyId: string;
    riskPercent: number;
    engineMaxVolume: number;
    instrument: InstrumentMetadata;
    instrumentSource: string;
    parametersSource: string;
    baseParameters: Record<string, number | boolean | string>;
    lockedParametersIdentical: boolean;
    m15BufferCapacity: number;
    h4ContextWindow: number;
    noLookahead: true;
  };
  variants: XauSessionHoursVariantResult[];
  increments: XauSessionHoursIncrement[];
  interpretation: XauSessionHoursInterpretation;
  dataIntegrity: XauDataIntegrity;
  limitations: string[];
}

function emptyStats(): XauGroupStats {
  return {
    signals: 0,
    entries: 0,
    resolved: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    totalR: 0,
    avgR: null,
    ambiguous: 0,
    openAtEnd: 0,
    unscorable: 0
  };
}

function addTrade(s: XauGroupStats, t: ReplaySimulatedTrade): void {
  s.signals += 1;
  if (t.outcome !== "UNSCORABLE" && t.entryTimeMs != null) s.entries += 1;
  if (t.outcome === "TARGET" || t.outcome === "STOP") {
    s.resolved += 1;
    s.totalR += t.realizedR ?? 0;
    if (t.outcome === "TARGET") s.wins += 1;
    else s.losses += 1;
  } else if (t.outcome === "AMBIGUOUS") s.ambiguous += 1;
  else if (t.outcome === "OPEN_AT_END") s.openAtEnd += 1;
  else s.unscorable += 1;
}

function finishStats(s: XauGroupStats): XauGroupStats {
  s.winRate = s.resolved > 0 ? s.wins / s.resolved : null;
  s.avgR = s.resolved > 0 ? s.totalR / s.resolved : null;
  return s;
}

function tradeStats(trades: ReadonlyArray<ReplaySimulatedTrade>): XauGroupStats {
  const s = emptyStats();
  for (const t of trades) addTrade(s, t);
  return finishStats(s);
}

function utcHour(iso: string): number {
  return new Date(iso).getUTCHours() + new Date(iso).getUTCMinutes() / 60;
}

function bucketOf(iso: string): string {
  const h = utcHour(iso);
  const b = XAU_SESSION_HOUR_BUCKETS.find((x) => h >= x.startHour && h < x.endHour);
  return b?.id ?? "21:00–23:59";
}

function signalKey(e: { signalCandleIndex: number; direction: PositionDirection }): string {
  return `${e.signalCandleIndex}:${e.direction}`;
}

function countInSession(m15: ReadonlyArray<Candle>, startMs: number, endMs: number, v: XauSessionHoursVariantDef): number {
  let n = 0;
  for (const c of m15) {
    if (c.openTime < startMs || c.openTime >= endMs) continue;
    if (isWithinUtcSessionHours(c.closeTime, v.sessionStartHourUtc, v.sessionEndHourUtc)) n += 1;
  }
  return n;
}

function bucketStats(
  events: ReadonlyArray<XauProductionSignalEvent>,
  trades: ReadonlyArray<ReplaySimulatedTrade>
): XauSessionBucketStats[] {
  const tradesBy = new Map(trades.map((t) => [signalKey(t), t] as const));
  return XAU_SESSION_HOUR_BUCKETS.map((b) => {
    const ev = events.filter((e) => bucketOf(e.signalTimeIso) === b.id);
    const ts = ev.map((e) => tradesBy.get(signalKey(e))).filter((t): t is ReplaySimulatedTrade => t != null);
    const s = tradeStats(ts);
    s.signals = ev.length;
    return {
      bucket: b.id,
      admitted: ev.filter((e) => e.outcome === "OPENED").length,
      ...s
    };
  });
}

function weekdayStats(
  events: ReadonlyArray<XauProductionSignalEvent>,
  trades: ReadonlyArray<ReplaySimulatedTrade>
): XauSessionWeekdayStats[] {
  const tradesBy = new Map(trades.map((t) => [signalKey(t), t] as const));
  return WEEKDAYS.map((name, utcDay) => {
    const ev = events.filter((e) => new Date(e.signalTimeIso).getUTCDay() === utcDay);
    const ts = ev.map((e) => tradesBy.get(signalKey(e))).filter((t): t is ReplaySimulatedTrade => t != null);
    const s = tradeStats(ts);
    s.signals = ev.length;
    return {
      weekday: name,
      utcDay,
      admitted: ev.filter((e) => e.outcome === "OPENED").length,
      ...s
    };
  });
}

function rSign(totalR: number): "positive" | "negative" | "flat" {
  if (totalR > 1e-9) return "positive";
  if (totalR < -1e-9) return "negative";
  return "flat";
}

function spansWeekend(fromMs: number, toMs: number): boolean {
  for (let t = fromMs; t <= toMs; t += DAY_MS / 4) {
    const d = new Date(t).getUTCDay();
    if (d === 6 || d === 0) return true;
  }
  return false;
}

function tally<T>(items: ReadonlyArray<T>, key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function malformedCounts(candles: ReadonlyArray<Candle>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candles) {
    const v = validateCandleOhlc(c);
    if (!v.valid) out[v.code] = (out[v.code] ?? 0) + 1;
  }
  return out;
}

function m15Gaps(candles: ReadonlyArray<Candle>): XauDataIntegrity["m15"]["gaps"] & {
  weekdayMaintenanceGaps: number;
} {
  const all: Array<{
    afterIso: string;
    nextIso: string;
    missingBars: number;
    weekend: boolean;
    weekdayMaintenance: boolean;
  }> = [];
  let missingBars = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (dt <= M15_MS * 1.5) continue;
    const missing = Math.round(dt / M15_MS) - 1;
    missingBars += missing;
    const weekend = spansWeekend(candles[i - 1]!.openTime, candles[i]!.openTime);
    all.push({
      afterIso: new Date(candles[i - 1]!.openTime).toISOString(),
      nextIso: new Date(candles[i]!.openTime).toISOString(),
      missingBars: missing,
      weekend,
      weekdayMaintenance: !weekend && dt >= WEEKDAY_MAINTENANCE_MIN_MS && dt <= WEEKDAY_MAINTENANCE_MAX_MS
    });
  }
  const weekendGaps = all.filter((g) => g.weekend).length;
  return {
    count: all.length,
    weekendGaps,
    nonWeekendGaps: all.length - weekendGaps,
    missingBars,
    weekdayMaintenanceGaps: all.filter((g) => g.weekdayMaintenance).length,
    largest: [...all].sort((a, b) => b.missingBars - a.missingBars).slice(0, 15)
  };
}

function interpret(variants: XauSessionHoursVariantResult[], increments: XauSessionHoursIncrement[]): XauSessionHoursInterpretation {
  const current = variants.find((v) => v.def.id === "CURRENT")!;
  const sampleSizeIncreased: XauSessionHoursInterpretation["sampleSizeIncreased"] = {};
  const additionalTradesR: XauSessionHoursInterpretation["additionalTradesR"] = {};
  const drawdownChanged: XauSessionHoursInterpretation["drawdownChanged"] = {};
  const concentration: string[] = [];
  for (const v of variants) {
    if (v.def.id === "CURRENT") continue;
    const inc = increments.find((x) => x.variantId === v.def.id)!;
    sampleSizeIncreased[v.def.id] = {
      currentSignals: current.faithful.signalsGenerated,
      variantSignals: v.faithful.signalsGenerated,
      extraSignals: inc.extraSignals
    };
    additionalTradesR[v.def.id] = {
      extraTrades: inc.extraTrades.entries,
      totalR: inc.extraTrades.totalR,
      avgR: inc.extraTrades.avgR,
      sign: rSign(inc.extraTrades.totalR)
    };
    drawdownChanged[v.def.id] = {
      currentMaxDrawdownR: current.faithful.maxDrawdownR,
      variantMaxDrawdownR: v.faithful.maxDrawdownR,
      delta: v.faithful.maxDrawdownR - current.faithful.maxDrawdownR
    };
    const hotHours = v.hourBuckets
      .filter((b) => b.signals > 0)
      .sort((a, b) => Math.abs(b.totalR) - Math.abs(a.totalR));
    const top = hotHours[0];
    if (top && v.faithful.resolvedTrades >= 4) {
      const share = v.faithful.totalR === 0 ? 0 : top.totalR / v.faithful.totalR;
      if (Math.abs(share) >= 0.6) {
        concentration.push(
          `${v.def.id}: ${top.bucket} accounts for ${(share * 100).toFixed(0)}% of variant total R (${top.resolved} resolved).`
        );
      }
    }
    const hotDays = v.weekdays.filter((d) => d.utcDay >= 1 && d.utcDay <= 5 && d.resolved > 0);
    if (hotDays.length === 1 && v.faithful.resolvedTrades >= 4) {
      concentration.push(`${v.def.id}: all weekday resolved R is on ${hotDays[0]!.weekday}.`);
    }
    if (inc.currentAdmittedAbsentFromVariant > 0) {
      concentration.push(
        `${v.def.id}: ${inc.currentAdmittedAbsentFromVariant} CURRENT admitted signal(s) did not enter here because an earlier extra trade held the single slot or consumed cooldown — not because session eligibility removed them.`
      );
    }
  }
  return {
    sampleSizeIncreased,
    additionalTradesR,
    drawdownChanged,
    concentration,
    sampleSizeLimitations: [
      "R is gross next-open replay (no spread/commission/slippage); live fills differ.",
      "Session variants share one historical sample; extra trades are not an independent holdout.",
      "A handful of extra trades can swing total R; weekday and hour buckets are even smaller.",
      "FULL_WEEKDAY still cannot trade bars the broker never stored (weekend close, daily maintenance)."
    ]
  };
}

export function runXauSessionHoursComparison(input: {
  symbol: string;
  m15: ReadonlyArray<Candle>;
  h4: ReadonlyArray<Candle>;
  analysisStartMs: number;
  analysisEndMs: number;
  equity: number;
  instrument: InstrumentMetadata;
  engineMaxVolume: number;
  parameters?: Record<string, number | boolean | string>;
  parametersSource?: string;
  instrumentSource?: string;
  strategy?: TradingStrategy;
  integrityInputs?: {
    m15RowsLoaded: number;
    m15RestoreDiagnostics: string[];
    m15Raw: ReadonlyArray<Candle>;
    h4RowsLoaded: number;
    h4Raw: ReadonlyArray<Candle>;
  };
  extraLimitations?: string[];
}): XauSessionHoursComparisonReport {
  const strategy = input.strategy ?? new XauTrendPullbackStrategy();
  const base = { ...(input.parameters ?? { ...XAU_TREND_PULLBACK_DEFAULTS }) };
  const m15 = [...input.m15].sort((a, b) => a.openTime - b.openTime);
  const h4 = [...input.h4].sort((a, b) => a.openTime - b.openTime);
  const locked = lockedXauSessionHoursParams(base);

  const variants = XAU_SESSION_HOURS_VARIANTS.map((def): XauSessionHoursVariantResult => {
    const parameters = applyXauSessionHours(base, def);
    const faithful = simulateXauProductionFaithfulCap({
      m15,
      h4,
      analysisStartMs: input.analysisStartMs,
      analysisEndMs: input.analysisEndMs,
      parameters,
      strategy,
      capPercent: XAU_SESSION_HOURS_RISK_PERCENT,
      equity: input.equity,
      instrument: input.instrument,
      engineMaxVolume: input.engineMaxVolume
    });
    return {
      def,
      parameters,
      evaluatedBars: faithful.strategyEvaluations,
      inSessionBars: countInSession(m15, input.analysisStartMs, input.analysisEndMs, def),
      faithful,
      hourBuckets: bucketStats(faithful.events, faithful.trades),
      weekdays: weekdayStats(faithful.events, faithful.trades)
    };
  });

  const lockedIdentical = variants.every(
    (v) => JSON.stringify(lockedXauSessionHoursParams(v.parameters)) === JSON.stringify(locked)
  );
  const current = variants.find((v) => v.def.id === "CURRENT")!;
  const currentSignalIds = new Set(current.faithful.events.map(signalKey));
  const currentAdmittedIds = new Set(
    current.faithful.events.filter((e) => e.outcome === "OPENED").map(signalKey)
  );

  const increments = variants
    .filter((v) => v.def.id !== "CURRENT")
    .map((v): XauSessionHoursIncrement => {
      const ids = new Set(v.faithful.events.map(signalKey));
      const extraEvents = v.faithful.events.filter((e) => !currentSignalIds.has(signalKey(e)));
      const extraIds = new Set(extraEvents.map(signalKey));
      const extraTrades = v.faithful.trades.filter((t) => extraIds.has(signalKey(t)));
      const extraStats = tradeStats(extraTrades);
      extraStats.signals = extraEvents.length;
      return {
        variantId: v.def.id,
        extraSignals: extraEvents.length,
        extraAdmitted: extraEvents.filter((e) => e.outcome === "OPENED").length,
        extraTrades: extraStats,
        extraMaxDrawdownR: aggregatePassEconomicMetrics(extraTrades).maxDrawdownR,
        currentSignalsAbsentFromVariant: [...currentSignalIds].filter((k) => !ids.has(k)).length,
        currentAdmittedAbsentFromVariant: [...currentAdmittedIds].filter((k) => !ids.has(k)).length,
        extraSignalTimes: extraEvents.map((e) => e.signalTimeIso)
      };
    });

  const warmup = generateXauTrendPullbackSignals({
    m15,
    h4,
    analysisStartMs: input.analysisStartMs,
    analysisEndMs: input.analysisEndMs,
    parameters: current.parameters,
    strategy
  });
  const analysisM15 = m15.filter((c) => c.openTime >= input.analysisStartMs && c.openTime < input.analysisEndMs);
  const ii = input.integrityInputs;
  const gaps = m15Gaps(analysisM15);
  const h4Gaps = h4.reduce((n, c, i) => (i > 0 && c.openTime - h4[i - 1]!.openTime > 4 * 3_600_000 * 1.5 ? n + 1 : n), 0);

  return {
    generatedAtIso: new Date().toISOString(),
    kind: "XAU_SESSION_HOURS_COMPARISON",
    config: {
      symbol: input.symbol,
      interval: "15m",
      strategyId: strategy.id,
      riskPercent: XAU_SESSION_HOURS_RISK_PERCENT,
      engineMaxVolume: input.engineMaxVolume,
      instrument: input.instrument,
      instrumentSource: input.instrumentSource ?? "provided",
      parametersSource: input.parametersSource ?? "XAU_TREND_PULLBACK_DEFAULTS",
      baseParameters: base,
      lockedParametersIdentical: lockedIdentical,
      m15BufferCapacity: XAU_M15_BUFFER_CAPACITY,
      h4ContextWindow: XAU_H4_CONTEXT_WINDOW,
      noLookahead: true
    },
    variants,
    increments,
    interpretation: interpret(variants, increments),
    dataIntegrity: {
      analysisStartIso: new Date(input.analysisStartMs).toISOString(),
      analysisEndIso: new Date(input.analysisEndMs).toISOString(),
      m15: {
        rowsLoaded: ii?.m15RowsLoaded ?? m15.length,
        completeCleanCandles: m15.length,
        analysisWindowCandles: analysisM15.length,
        excludedByRestoreFilter: (ii?.m15RowsLoaded ?? m15.length) - m15.length,
        restoreFilterDiagnostics: ii?.m15RestoreDiagnostics ?? [],
        sources: tally(m15, (c) => c.source),
        firstIso: m15[0] ? new Date(m15[0].openTime).toISOString() : null,
        lastIso: m15.length ? new Date(m15[m15.length - 1]!.openTime).toISOString() : null,
        gaps,
        malformed: malformedCounts(ii?.m15Raw ?? m15),
        continuity: analyzeCandleContinuity(analysisM15)
      },
      h4: {
        rowsLoaded: ii?.h4RowsLoaded ?? h4.length,
        completeCleanCandles: h4.length,
        sources: tally(h4, (c) => c.source),
        firstIso: h4[0] ? new Date(h4[0].openTime).toISOString() : null,
        lastIso: h4.length ? new Date(h4[h4.length - 1]!.openTime).toISOString() : null,
        malformed: malformedCounts(ii?.h4Raw ?? h4),
        gaps: h4Gaps,
        analysisBarsWithInsufficientH4: warmup.barsWithInsufficientH4,
        firstBarWithFullWarmupIso: warmup.firstBarWithFullWarmupIso
      }
    },
    limitations: [
      ...(input.extraLimitations ?? []),
      "Research only. Session hours are injected per variant; production XAU_TREND_PULLBACK_DEFAULTS and DEMO/REAL are not modified.",
      `Risk held at ${XAU_SESSION_HOURS_RISK_PERCENT.toFixed(2)}% (current XAU DEMO override cap) with minVolume ${XAU_BROKER_MIN_VOLUME} / step ${XAU_BROKER_VOLUME_STEP} via calculateRaw → resolveMt5EngineVolume.`,
      "Production-faithful cooldown: last-signal advances only when shouldConsumeStrategySignalCooldown is true (OPENED consumes; MIN_VOLUME_EXCEEDS_RISK does not).",
      "Entry NEXT_CANDLE_OPEN; same-bar stop+target = AMBIGUOUS; one position per variant; no spread/commission/slippage.",
      "FULL_WEEKDAY uses stored MT5 M15 bars only — weekend and maintenance closures appear as gaps, not synthetic candles.",
      "H4 context: last completed native H4 bars with closeTime ≤ M15 close (no lookahead).",
      "The DEMO XAU risk-override helper is not called and not changed."
    ]
  };
}

export function formatXauSessionHoursComparisonMarkdown(r: XauSessionHoursComparisonReport): string {
  const n = (v: number | null | undefined, d = 2) => (v == null ? "—" : (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d));
  const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  const lines: string[] = [];
  const c = r.config;
  lines.push(`# XAUUSD session-hours comparison — ${c.strategyId}`);
  lines.push("");
  lines.push(`- Symbol ${c.symbol} ${c.interval}; analysis ${r.dataIntegrity.analysisStartIso} → ${r.dataIntegrity.analysisEndIso}`);
  lines.push(`- Risk held at ${c.riskPercent.toFixed(2)}% for every variant (DEMO XAU cap); engine max volume ${c.engineMaxVolume}`);
  lines.push(`- Parameters: ${c.parametersSource}; locked non-session keys identical: ${c.lockedParametersIdentical ? "yes" : "NO"}`);
  lines.push(`- No lookahead: rolling M15 buffer ${c.m15BufferCapacity}, H4 window ${c.h4ContextWindow}, completed H4 only.`);
  lines.push(`- Research only. This report does not recommend or apply a session change.`);
  lines.push("");
  lines.push(`## Session windows`);
  for (const v of r.variants) {
    lines.push(`- **${v.def.id}** (${v.def.windowLabel}): ${v.def.rationale}`);
  }
  lines.push("");
  lines.push(`## Per-variant results`);
  lines.push(`| Metric | ${r.variants.map((v) => v.def.id).join(" | ")} |`);
  lines.push(`|---|${r.variants.map(() => "---:").join("|")}|`);
  const row = (label: string, f: (v: XauSessionHoursVariantResult) => string) =>
    lines.push(`| ${label} | ${r.variants.map(f).join(" | ")} |`);
  row("Window", (v) => v.def.windowLabel);
  row("M15 bars evaluated", (v) => String(v.evaluatedBars));
  row("In-session bars", (v) => String(v.inSessionBars));
  row("BUY/SELL signals", (v) => `${v.faithful.signalsGenerated} (${v.faithful.buySignals}/${v.faithful.sellSignals})`);
  row("Admitted by sizing", (v) => String(v.faithful.admittedSignals));
  row("Rejected MIN_VOLUME_EXCEEDS_RISK", (v) => String(v.faithful.rejectedMinVolumeExceedsRisk));
  row("Entries", (v) => String(v.faithful.entries));
  row("Resolved", (v) => String(v.faithful.resolvedTrades));
  row("W/L", (v) => `${v.faithful.wins}/${v.faithful.losses}`);
  row("Win rate", (v) => pct(v.faithful.winRate));
  row("Total R", (v) => n(v.faithful.totalR));
  row("Avg R", (v) => n(v.faithful.avgR));
  row("Max drawdown R", (v) => n(v.faithful.maxDrawdownR));
  row("Longest losing streak", (v) => String(v.faithful.longestLosingStreak));
  row("Open at end", (v) => String(v.faithful.openAtEnd));
  row("Skipped cooldown", (v) => String(v.faithful.skippedCooldown));
  row("Skipped open position", (v) => String(v.faithful.skippedOpenPosition));
  lines.push("");
  lines.push(`HOLD reasons (top codes):`);
  for (const v of r.variants) {
    const holds = Object.entries(v.faithful.holdReasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, x]) => `${k} ${x}`)
      .join(", ");
    lines.push(`- ${v.def.id}: ${holds || "—"}`);
  }
  lines.push("");

  lines.push(`## Time-of-day (UTC close hour)`);
  for (const v of r.variants) {
    lines.push(`### ${v.def.id}`);
    lines.push(`| Bucket | Signals | Admitted | Trades | W/L | Total R | Avg R |`);
    lines.push(`|---|---:|---:|---:|---|---:|---:|`);
    for (const b of v.hourBuckets) {
      lines.push(
        `| ${b.bucket} | ${b.signals} | ${b.admitted} | ${b.entries} | ${b.wins}/${b.losses} | ${n(b.totalR)} | ${n(b.avgR)} |`
      );
    }
    lines.push("");
  }

  lines.push(`## Weekday (UTC)`);
  for (const v of r.variants) {
    lines.push(`### ${v.def.id}`);
    lines.push(`| Day | Signals | Trades | W/L | Total R | Avg R |`);
    lines.push(`|---|---:|---:|---|---:|---:|`);
    for (const d of v.weekdays) {
      if (d.utcDay === 0 || d.utcDay === 6) {
        if (d.signals === 0) continue;
      }
      lines.push(`| ${d.weekday} | ${d.signals} | ${d.entries} | ${d.wins}/${d.losses} | ${n(d.totalR)} | ${n(d.avgR)} |`);
    }
    lines.push("");
  }

  lines.push(`## Incremental vs CURRENT`);
  lines.push(
    `| Variant | Extra signals | Extra admitted | Extra trades / W-L / R / avg | Extra max DD R | CURRENT signals absent |`
  );
  lines.push(`|---|---:|---:|---|---:|---:|`);
  for (const x of r.increments) {
    const t = x.extraTrades;
    lines.push(
      `| ${x.variantId} | ${x.extraSignals} | ${x.extraAdmitted} | ${t.entries} / ${t.wins}-${t.losses} / ${n(t.totalR)} / ${n(t.avgR)} | ${n(x.extraMaxDrawdownR)} | ${x.currentSignalsAbsentFromVariant} |`
    );
  }
  lines.push("");
  lines.push(
    `"Extra" means the signal timestamp exists in the broader variant and not in CURRENT. Extra max DD is the standalone R path of those extra trades only.`
  );
  lines.push("");

  const ip = r.interpretation;
  lines.push(`## Interpretation (no ranking)`);
  for (const [id, s] of Object.entries(ip.sampleSizeIncreased)) {
    lines.push(
      `- ${id}: signals ${s.currentSignals} → ${s.variantSignals} (extra ${s.extraSignals}). Additional trades R is ${ip.additionalTradesR[id]!.sign} (${n(ip.additionalTradesR[id]!.totalR)}R on ${ip.additionalTradesR[id]!.extraTrades} extra entries). Drawdown R ${n(ip.drawdownChanged[id]!.currentMaxDrawdownR)} → ${n(ip.drawdownChanged[id]!.variantMaxDrawdownR)} (Δ ${n(ip.drawdownChanged[id]!.delta)}).`
    );
  }
  for (const note of ip.concentration) lines.push(`- ${note}`);
  for (const note of ip.sampleSizeLimitations) lines.push(`- Limitation: ${note}`);
  lines.push("");

  const d = r.dataIntegrity;
  lines.push(`## Data integrity`);
  lines.push(`- Analysis window: ${d.analysisStartIso} → ${d.analysisEndIso}`);
  lines.push(
    `- M15: loaded ${d.m15.rowsLoaded}; clean ${d.m15.completeCleanCandles}; analysis ${d.m15.analysisWindowCandles}; restore-excluded ${d.m15.excludedByRestoreFilter}`
  );
  lines.push(`- M15 sources: ${JSON.stringify(d.m15.sources)}; malformed: ${JSON.stringify(d.m15.malformed)}`);
  const g = d.m15.gaps as typeof d.m15.gaps & { weekdayMaintenanceGaps?: number };
  lines.push(
    `- M15 gaps: ${g.count} (weekend ${g.weekendGaps}, weekday-maintenance-sized ${g.weekdayMaintenanceGaps ?? "—"}, other non-weekend ${g.nonWeekendGaps}; missing bars ${g.missingBars})`
  );
  lines.push(
    `- M15 close-to-close max |move| ${d.m15.continuity.maxAbsReturnPct == null ? "—" : `${d.m15.continuity.maxAbsReturnPct.toFixed(3)}%`}`
  );
  lines.push(
    `- H4: loaded ${d.h4.rowsLoaded}; clean ${d.h4.completeCleanCandles}; gaps ${d.h4.gaps}; insufficient-H4 analysis bars ${d.h4.analysisBarsWithInsufficientH4}; first full warmup ${d.h4.firstBarWithFullWarmupIso ?? "—"}`
  );
  lines.push(`- Lookahead: each evaluation uses M15 bars up through the decision close and H4 with closeTime ≤ that close.`);
  lines.push("");
  lines.push(`## Limitations`);
  for (const l of r.limitations) lines.push(`- ${l}`);
  return `${lines.join("\n")}\n`;
}
