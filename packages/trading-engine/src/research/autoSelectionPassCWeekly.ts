/**
 * Time-sliced robustness view of the Pass C research variants.
 *
 * Post-processing only: trades come from each variant's single full chronological simulation and are
 * grouped by the UTC calendar week (Monday 00:00 UTC) of their ENTRY time. No per-week simulation,
 * no state reset at week boundaries. Research only — not a deployment signal.
 */
import { EMA_FALLBACK_STRATEGY_ID } from "./autoSelectionEmaFallbackDiagnostics.js";
import { utcWeekStartMs } from "./xauUsdWeeklyRobustness.js";
import { type PassCVariantId, type PassCVariantResult } from "./autoSelectionPassCVariants.js";
import {
  aggregatePassEconomicMetrics,
  type ReplaySimulatedTrade
} from "./autoSelectionReplayOutcomes.js";

const WEEK_MS = 7 * 86_400_000;
/** Simulated R carries tick-rounding residue (~1e-8 per trade), so "flat" needs a real tolerance. */
export const WEEKLY_FLAT_EPSILON_R = 1e-6;
const FLAT_EPSILON_R = WEEKLY_FLAT_EPSILON_R;

/** Every week start (Monday 00:00 UTC) overlapping [startMs, endMs). */
export function utcWeekStartsInRange(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  if (!(endMs > startMs)) return out;
  for (let w = utcWeekStartMs(startMs); w < endMs; w += WEEK_MS) out.push(w);
  return out;
}

export interface WeeklyEconomicBucket {
  weekStartMs: number;
  weekStartIso: string;
  entries: number;
  resolvedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  /** Entered this week and still open at the end of the full simulation. */
  openAtEnd: number;
  /** Entered this week; stop and target touched in the same bar (excluded from R). */
  ambiguous: number;
}

export interface WeeklyStabilitySummary {
  weeks: number;
  weeksWithNoEntries: number;
  positiveWeeks: number;
  negativeWeeks: number;
  /** |week R| ≤ WEEKLY_FLAT_EPSILON_R, including weeks with no entries. */
  flatWeeks: number;
  bestWeekR: number | null;
  worstWeekR: number | null;
  medianWeekR: number | null;
  totalR: number;
}

export interface WeeklyBreakdown {
  weeks: WeeklyEconomicBucket[];
  stability: WeeklyStabilitySummary;
}

export interface PassCVariantWeekly {
  id: PassCVariantId;
  label: string;
  all: WeeklyBreakdown;
  emaFallbackFromHold: WeeklyBreakdown;
}

export interface WeeklyDeltaRow {
  weekStartIso: string;
  baseR: number;
  compareR: number;
  deltaR: number;
  baseEmaR: number;
  compareEmaR: number;
  deltaEmaR: number;
}

export interface PassCVariantWeeklyReport {
  notes: string[];
  variants: PassCVariantWeekly[];
  /** C1 minus C0 realized R per entry week (null when either variant is missing). */
  c1VsC0: WeeklyDeltaRow[] | null;
}

/** Trades that actually opened a position (UNSCORABLE never did). */
function isEntry(t: ReplaySimulatedTrade): t is ReplaySimulatedTrade & { entryTimeMs: number } {
  return t.entryTimeMs != null && t.outcome !== "UNSCORABLE";
}

export const isEmaFallbackFromHoldTrade = (t: ReplaySimulatedTrade) =>
  t.pass === "C" && t.fromProductionHold && t.strategyId === EMA_FALLBACK_STRATEGY_ID;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/**
 * Group a finished trade list by entry week. `weekStarts` fixes the row set so empty weeks appear
 * and variants align; weeks holding an entry outside that set are appended.
 */
export function buildWeeklyEconomicBreakdown(
  trades: ReadonlyArray<ReplaySimulatedTrade>,
  weekStarts: ReadonlyArray<number> = []
): WeeklyBreakdown {
  const byWeek = new Map<number, ReplaySimulatedTrade[]>();
  for (const w of weekStarts) byWeek.set(w, []);
  for (const t of trades) {
    if (!isEntry(t)) continue;
    const w = utcWeekStartMs(t.entryTimeMs);
    const list = byWeek.get(w) ?? [];
    list.push(t);
    byWeek.set(w, list);
  }

  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekStartMs, list]): WeeklyEconomicBucket => {
      const m = aggregatePassEconomicMetrics(list);
      return {
        weekStartMs,
        weekStartIso: new Date(weekStartMs).toISOString().slice(0, 10),
        entries: list.length,
        resolvedTrades: m.targetHits + m.stopHits,
        wins: m.targetHits,
        losses: m.stopHits,
        winRate: m.winRate,
        totalR: m.totalRealizedR,
        avgR: m.avgRPerResolvedTrade,
        maxDrawdownR: m.maxDrawdownR,
        longestLosingStreak: m.longestLosingStreak,
        openAtEnd: m.openAtEnd,
        ambiguous: m.ambiguous
      };
    });

  const weekR = weeks.map((w) => w.totalR);
  return {
    weeks,
    stability: {
      weeks: weeks.length,
      weeksWithNoEntries: weeks.filter((w) => w.entries === 0).length,
      positiveWeeks: weekR.filter((r) => r > FLAT_EPSILON_R).length,
      negativeWeeks: weekR.filter((r) => r < -FLAT_EPSILON_R).length,
      flatWeeks: weekR.filter((r) => Math.abs(r) <= FLAT_EPSILON_R).length,
      bestWeekR: weekR.length ? Math.max(...weekR) : null,
      worstWeekR: weekR.length ? Math.min(...weekR) : null,
      medianWeekR: median(weekR),
      totalR: weekR.reduce((a, b) => a + b, 0)
    }
  };
}

export function buildPassCVariantWeeklyReport(input: {
  variants: ReadonlyArray<Pick<PassCVariantResult, "id" | "label" | "trades">>;
  analysisStartMs: number;
  analysisEndMs: number;
}): PassCVariantWeeklyReport {
  const weekStarts = utcWeekStartsInRange(input.analysisStartMs, input.analysisEndMs);
  const variants = input.variants.map(
    (v): PassCVariantWeekly => ({
      id: v.id,
      label: v.label,
      all: buildWeeklyEconomicBreakdown(v.trades, weekStarts),
      emaFallbackFromHold: buildWeeklyEconomicBreakdown(v.trades.filter(isEmaFallbackFromHoldTrade), weekStarts)
    })
  );

  const c0 = variants.find((v) => v.id === "C0_BASELINE");
  const c1 = variants.find((v) => v.id === "C1_EMA_MAX_EXTENSION_0_5");
  let c1VsC0: WeeklyDeltaRow[] | null = null;
  if (c0 && c1) {
    const rOf = (b: WeeklyBreakdown) => new Map(b.weeks.map((w) => [w.weekStartIso, w.totalR]));
    const [c0All, c1All, c0Ema, c1Ema] = [c0.all, c1.all, c0.emaFallbackFromHold, c1.emaFallbackFromHold].map(rOf) as [
      Map<string, number>,
      Map<string, number>,
      Map<string, number>,
      Map<string, number>
    ];
    const keys = [...new Set([...c0All.keys(), ...c1All.keys()])].sort();
    c1VsC0 = keys.map((k) => {
      const baseR = c0All.get(k) ?? 0;
      const compareR = c1All.get(k) ?? 0;
      const baseEmaR = c0Ema.get(k) ?? 0;
      const compareEmaR = c1Ema.get(k) ?? 0;
      return {
        weekStartIso: k,
        baseR,
        compareR,
        deltaR: compareR - baseR,
        baseEmaR,
        compareEmaR,
        deltaEmaR: compareEmaR - baseEmaR
      };
    });
  }

  return {
    notes: [
      "Weeks are UTC calendar weeks starting Monday 00:00 UTC; trades are assigned by ENTRY time, never exit time.",
      "Trades come from each variant's single full chronological simulation — no per-week rerun and no state reset at week boundaries.",
      "A trade entered in one week and resolved in a later week counts entirely in its entry week.",
      "Per-week drawdown / losing streak use the same definitions as the variant totals, over that week's entries in order.",
      "Open-at-end and ambiguous trades are listed by entry week and excluded from R.",
      "Weeks overlapping the analysis window with no entries are shown and count as flat.",
      "Research only — not a deployment signal."
    ],
    variants,
    c1VsC0
  };
}
