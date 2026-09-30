/**
 * Out-of-sample forward validation of the frozen R_10 AUTO Pass C hypothesis.
 *
 * C0 = ungated Pass C baseline; C1 = frozen EMA fallback-from-HOLD gate (fast-EMA extension ≤ 0.5 ATR).
 * Selector replay, Pass C fall-through, cooldowns, NEXT_CANDLE_OPEN entry, SINGLE_POSITION_PER_PASS,
 * stop/target proposal, and AMBIGUOUS handling are the existing replay components, unchanged.
 * Only candles opening at/after forwardStart are analyzed; earlier candles are indicator warmup.
 *
 * Research only — descriptive evidence, no verdict, nothing reaches production/DEMO/REAL.
 */
import { type Candle, type PositionDirection } from "@regimex/shared";
import {
  REPLAY_CANDLE_BUFFER_CAPACITY,
  REPLAY_DEFAULT_TICK_SIZE,
  buildReplayEconomicSignals,
  defaultR10ReplayStrategies,
  runAutoSelectionCounterfactualReplay,
  type AutoSelectionReplayConfig
} from "./autoSelectionCounterfactualReplay.js";
import {
  EXTENSION_BUCKETS,
  type EmaDiagnosticGroupStats,
  type EmaFallbackTradeDiagnostic,
  type ExtensionBucket
} from "./autoSelectionEmaFallbackDiagnostics.js";
import {
  PASS_C_VARIANTS,
  runPassCResearchVariants,
  type PassCVariantId,
  type PassCVariantResult
} from "./autoSelectionPassCVariants.js";
import {
  buildPassCVariantWeeklyReport,
  isEmaFallbackFromHoldTrade,
  type PassCVariantWeekly
} from "./autoSelectionPassCWeekly.js";
import {
  analyzeCandleContinuity,
  type ReplayCandleContinuityDiagnostics,
  type ReplayResearchGateRejection
} from "./autoSelectionReplaySimulationDiagnostics.js";

export const R10_FORWARD_START_ISO = "2026-09-29T16:17:00.000Z";
export const R10_FORWARD_DEFAULT_ALLOWLIST = [
  "squeeze-breakout-v1",
  "ema-pullback-v1",
  "breakout-momentum-v1",
  "trend-structure-pullback-v1"
] as const;
export const FORWARD_VARIANT_IDS = ["C0_BASELINE", "C1_EMA_MAX_EXTENSION_0_5"] as const satisfies readonly PassCVariantId[];
/** The frozen definitions — taken from the historical variant table, never redefined here. */
export const FORWARD_VARIANTS = FORWARD_VARIANT_IDS.map((id) => PASS_C_VARIANTS.find((v) => v.id === id)!);

const DAY_MS = 86_400_000;

export interface ForwardValidationConfig
  extends Omit<AutoSelectionReplayConfig, "analysisStartMs" | "analysisEndMs"> {
  forwardStartMs: number;
  /** Exclusive end; default = open time of the latest complete candle + 1 interval. */
  forwardEndMs?: number;
}

export interface ForwardGap {
  afterOpenIso: string;
  nextOpenIso: string;
  missingBars: number;
}

export interface ForwardEmaSummary {
  entries: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  byDirection: Partial<Record<PositionDirection, EmaDiagnosticGroupStats>>;
  byExtensionBucket: Partial<Record<ExtensionBucket, EmaDiagnosticGroupStats>>;
  acceptedTrades: EmaFallbackTradeDiagnostic[];
  /** Gate rejections of EMA fallback-from-HOLD entries (always empty for C0). */
  rejectedSignals: ReplayResearchGateRejection[];
}

export interface ForwardVariantSummary {
  id: PassCVariantId;
  label: string;
  description: string;
  executableSignals: number;
  gateRejections: number;
  entries: number;
  resolvedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalR: number;
  avgR: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  openAtEnd: number;
  maxBarsHeld: number | null;
  skippedWhilePositionOpen: number;
  emaFallbackFromHold: ForwardEmaSummary;
  result: PassCVariantResult;
}

export interface ForwardCumulativeWeekRow {
  weekStartIso: string;
  c0R: number;
  c1R: number;
  deltaR: number;
  c0EmaR: number;
  c1EmaR: number;
  deltaEmaR: number;
  cumulativeC0R: number;
  cumulativeC1R: number;
  cumulativeDeltaR: number;
  cumulativeC0EmaR: number;
  cumulativeC1EmaR: number;
  cumulativeDeltaEmaR: number;
}

export interface ForwardValidationReport {
  generatedAtIso: string;
  kind: "R10_AUTO_PASS_C_FORWARD_VALIDATION";
  config: {
    symbol: string;
    interval: string;
    forwardStartIso: string;
    forwardEndIso: string;
    selectionMode: AutoSelectionReplayConfig["selectionMode"];
    executionBackend: AutoSelectionReplayConfig["executionBackend"];
    strategyAllowlist: string[];
    strategyIds: string[];
    variants: Array<{ id: PassCVariantId; label: string; description: string }>;
  };
  coverage: {
    completeCandlesLoaded: number;
    warmupCandles: number;
    forwardCandles: number;
    forwardAnalysisBars: number;
    /** Forward candles the replay could not analyze because indicator warmup was insufficient. */
    forwardBarsBelowWarmup: number;
    firstLoadedCandleIso: string | null;
    firstForwardCandleIso: string | null;
    lastForwardCandleIso: string | null;
  };
  dataIntegrity: {
    forwardSources: Record<string, number>;
    forwardGaps: { count: number; missingBars: number; gaps: ForwardGap[] };
    forwardContinuity: ReplayCandleContinuityDiagnostics;
    /** Warmup + forward series fed to indicators. */
    loadedContinuity: ReplayCandleContinuityDiagnostics;
    /** Pass C signals with signal timestamp ≤ forwardStart removed before simulation (expected 0). */
    preForwardSignalsExcluded: number;
    /** Trades/rejections in C0/C1 whose signal or entry is ≤ forwardStart (must be 0). */
    preForwardTradesInAnalysis: number;
    noPreForwardLeakage: boolean;
  };
  variants: ForwardVariantSummary[];
  weekly: {
    notes: string[];
    variants: PassCVariantWeekly[];
    cumulative: ForwardCumulativeWeekRow[];
  };
  evidenceStatus: {
    note: string;
    forwardDaysElapsed: number;
    resolvedC1Trades: number;
    resolvedC1EmaFallbackFromHoldTrades: number;
    weeksWithResolvedC1Trade: number;
  };
  limitations: string[];
}

function forwardGaps(candles: ReadonlyArray<Candle>, intervalMs: number): ForwardValidationReport["dataIntegrity"]["forwardGaps"] {
  const gaps: ForwardGap[] = [];
  let missingBars = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (dt > intervalMs * 1.5) {
      const missing = Math.round(dt / intervalMs) - 1;
      missingBars += missing;
      gaps.push({
        afterOpenIso: new Date(candles[i - 1]!.openTime).toISOString(),
        nextOpenIso: new Date(candles[i]!.openTime).toISOString(),
        missingBars: missing
      });
    }
  }
  return { count: gaps.length, missingBars, gaps };
}

function emaSummary(v: PassCVariantResult): ForwardEmaSummary {
  const ema = v.emaFallbackFromHold;
  const entries = v.trades.filter((t) => isEmaFallbackFromHoldTrade(t) && t.outcome !== "UNSCORABLE" && t.entryTimeMs != null).length;
  return {
    entries,
    resolved: ema.stats.resolvedTrades,
    wins: ema.stats.wins,
    losses: ema.stats.losses,
    winRate: ema.stats.winRate,
    totalR: ema.stats.totalR,
    avgR: ema.stats.avgR,
    byDirection: ema.byDirection,
    byExtensionBucket: ema.byExtensionBucket,
    acceptedTrades: ema.records.filter((t) => t.outcome !== "UNSCORABLE" && t.entryTimeMs != null),
    rejectedSignals: v.rejections.filter((r) => r.strategyId === "ema-pullback-v1" && r.fromProductionHold)
  };
}

export function runR10AutoForwardValidation(
  candlesIn: ReadonlyArray<Candle>,
  config: ForwardValidationConfig
): ForwardValidationReport {
  const intervalMs = config.interval === "5m" ? 300_000 : config.interval === "15m" ? 900_000 : 60_000;
  const candles = candlesIn
    .filter((c) => c.isComplete)
    .slice()
    .sort((a, b) => a.openTime - b.openTime);
  const forwardStartMs = config.forwardStartMs;
  const last = candles[candles.length - 1];
  const forwardEndMs = config.forwardEndMs ?? (last ? last.openTime + intervalMs : forwardStartMs);

  const strategies = config.strategies ?? defaultR10ReplayStrategies();
  const replay = runAutoSelectionCounterfactualReplay(candles, {
    ...config,
    strategies,
    analysisStartMs: forwardStartMs,
    analysisEndMs: forwardEndMs
  });

  const passC = buildReplayEconomicSignals(replay.bars).filter((s) => s.pass === "C");
  const signals = passC.filter((s) => s.evaluation.signalTimestampMs > forwardStartMs);
  const preForwardSignalsExcluded = passC.length - signals.length;

  const variantsRun = runPassCResearchVariants({
    candles,
    signals,
    parametersByStrategyId: new Map(strategies.map((s) => [s.strategy.id, s.parameters] as const)),
    tickSize: config.tickSize ?? REPLAY_DEFAULT_TICK_SIZE,
    featureLookback: config.candleBufferCapacity ?? REPLAY_CANDLE_BUFFER_CAPACITY,
    variants: FORWARD_VARIANTS
  });

  let preForwardTradesInAnalysis = 0;
  for (const v of variantsRun.variants) {
    for (const t of v.trades) {
      if (t.signalTimeMs <= forwardStartMs || (t.entryTimeMs != null && t.entryTimeMs < forwardStartMs)) {
        preForwardTradesInAnalysis += 1;
      }
    }
    for (const r of v.rejections) {
      if (r.signalTimeMs <= forwardStartMs) preForwardTradesInAnalysis += 1;
    }
  }

  const variants = variantsRun.variants.map(
    (v): ForwardVariantSummary => ({
      id: v.id,
      label: v.label,
      description: v.description,
      executableSignals: v.signalsConsidered,
      gateRejections: v.signalsRejectedByResearchGate,
      entries: v.entriesOpened,
      resolvedTrades: v.resolvedTrades,
      wins: v.wins,
      losses: v.losses,
      winRate: v.winRate,
      totalR: v.totalR,
      avgR: v.avgR,
      maxDrawdownR: v.maxDrawdownR,
      longestLosingStreak: v.longestLosingStreak,
      openAtEnd: v.openAtEnd,
      maxBarsHeld: v.maxBarsHeld,
      skippedWhilePositionOpen: v.signalsSkippedOpenPosition,
      emaFallbackFromHold: emaSummary(v),
      result: v
    })
  );

  const weekly = buildPassCVariantWeeklyReport({
    variants: variantsRun.variants,
    analysisStartMs: forwardStartMs,
    analysisEndMs: forwardEndMs
  });
  const cumulative: ForwardCumulativeWeekRow[] = [];
  let cC0 = 0;
  let cC1 = 0;
  let cC0Ema = 0;
  let cC1Ema = 0;
  for (const r of weekly.c1VsC0 ?? []) {
    cC0 += r.baseR;
    cC1 += r.compareR;
    cC0Ema += r.baseEmaR;
    cC1Ema += r.compareEmaR;
    cumulative.push({
      weekStartIso: r.weekStartIso,
      c0R: r.baseR,
      c1R: r.compareR,
      deltaR: r.deltaR,
      c0EmaR: r.baseEmaR,
      c1EmaR: r.compareEmaR,
      deltaEmaR: r.deltaEmaR,
      cumulativeC0R: cC0,
      cumulativeC1R: cC1,
      cumulativeDeltaR: cC1 - cC0,
      cumulativeC0EmaR: cC0Ema,
      cumulativeC1EmaR: cC1Ema,
      cumulativeDeltaEmaR: cC1Ema - cC0Ema
    });
  }

  const forwardCandles = candles.filter((c) => c.openTime >= forwardStartMs && c.openTime < forwardEndMs);
  const warmupCandles = candles.filter((c) => c.openTime < forwardStartMs).length;
  const forwardSources: Record<string, number> = {};
  for (const c of forwardCandles) forwardSources[c.source] = (forwardSources[c.source] ?? 0) + 1;

  const c1 = variants.find((v) => v.id === "C1_EMA_MAX_EXTENSION_0_5");
  const c1Weekly = weekly.variants.find((v) => v.id === "C1_EMA_MAX_EXTENSION_0_5");

  const belowWarmup = replay.limitations.filter((l) => l.includes("below warmup")).length;
  const limitations = [
    ...replay.limitations.filter((l) => !l.includes("below warmup")),
    ...(belowWarmup > 0 ? [`${belowWarmup} forward bar(s) skipped — indicator warmup insufficient (load more pre-forward candles)`] : [])
  ];

  return {
    generatedAtIso: new Date().toISOString(),
    kind: "R10_AUTO_PASS_C_FORWARD_VALIDATION",
    config: {
      symbol: config.symbol,
      interval: config.interval,
      forwardStartIso: new Date(forwardStartMs).toISOString(),
      forwardEndIso: new Date(forwardEndMs).toISOString(),
      selectionMode: config.selectionMode,
      executionBackend: config.executionBackend,
      strategyAllowlist: config.strategyAllowlist,
      strategyIds: strategies.map((s) => s.strategy.id),
      variants: FORWARD_VARIANTS.map((v) => ({ id: v.id, label: v.label, description: v.description }))
    },
    coverage: {
      completeCandlesLoaded: candles.length,
      warmupCandles,
      forwardCandles: forwardCandles.length,
      forwardAnalysisBars: replay.coverage.analysisBars,
      forwardBarsBelowWarmup: forwardCandles.length - replay.coverage.analysisBars,
      firstLoadedCandleIso: candles[0] ? new Date(candles[0].openTime).toISOString() : null,
      firstForwardCandleIso: forwardCandles[0] ? new Date(forwardCandles[0].openTime).toISOString() : null,
      lastForwardCandleIso: forwardCandles.length
        ? new Date(forwardCandles[forwardCandles.length - 1]!.openTime).toISOString()
        : null
    },
    dataIntegrity: {
      forwardSources,
      forwardGaps: forwardGaps(forwardCandles, intervalMs),
      forwardContinuity: analyzeCandleContinuity(forwardCandles),
      loadedContinuity: analyzeCandleContinuity(candles),
      preForwardSignalsExcluded,
      preForwardTradesInAnalysis,
      noPreForwardLeakage: preForwardTradesInAnalysis === 0
    },
    variants,
    weekly: { notes: weekly.notes, variants: weekly.variants, cumulative },
    evidenceStatus: {
      note: "Descriptive only — no pass/fail verdict and no deployment recommendation.",
      forwardDaysElapsed: Math.max(0, (forwardEndMs - forwardStartMs) / DAY_MS),
      resolvedC1Trades: c1?.resolvedTrades ?? 0,
      resolvedC1EmaFallbackFromHoldTrades: c1?.emaFallbackFromHold.resolved ?? 0,
      weeksWithResolvedC1Trade: c1Weekly?.all.weeks.filter((w) => w.resolvedTrades > 0).length ?? 0
    },
    limitations
  };
}

export function formatR10ForwardValidationMarkdown(r: ForwardValidationReport): string {
  const n = (v: number | null | undefined, d = 2) =>
    v == null ? "—" : (Math.abs(v) < 1e-6 ? 0 : v).toFixed(d);
  const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  const grp = (s: EmaDiagnosticGroupStats | undefined) =>
    s ? `${s.trades} tr; ${s.wins}/${s.losses}; ${n(s.totalR)}R` : "—";
  const lines: string[] = [];

  lines.push(`# R_10 AUTO Pass C forward validation (out-of-sample)`);
  lines.push("");
  lines.push(`- Forward window: ${r.config.forwardStartIso} → ${r.config.forwardEndIso} (exclusive)`);
  lines.push(`- Variants: ${r.config.variants.map((v) => `${v.label} — ${v.description}`).join(" | ")}`);
  lines.push(`- Allowlist: ${r.config.strategyAllowlist.join(", ") || "(empty)"}; backend ${r.config.executionBackend}; ${r.config.selectionMode}`);
  lines.push(`- Research only. ${r.evidenceStatus.note}`);
  lines.push("");

  lines.push(`## Coverage`);
  const cv = r.coverage;
  lines.push(`- Complete candles loaded: ${cv.completeCandlesLoaded} (warmup ${cv.warmupCandles}, forward ${cv.forwardCandles})`);
  lines.push(`- Forward analysis bars: ${cv.forwardAnalysisBars} (below warmup: ${cv.forwardBarsBelowWarmup})`);
  lines.push(`- First loaded candle: ${cv.firstLoadedCandleIso ?? "—"}; first forward: ${cv.firstForwardCandleIso ?? "—"}; last forward: ${cv.lastForwardCandleIso ?? "—"}`);
  lines.push("");

  lines.push(`## Data integrity`);
  const di = r.dataIntegrity;
  const fc = di.forwardContinuity;
  lines.push(`- Forward candle sources: ${JSON.stringify(di.forwardSources)}`);
  lines.push(`- Forward gaps: ${di.forwardGaps.count} (missing bars ${di.forwardGaps.missingBars})`);
  for (const g of di.forwardGaps.gaps.slice(0, 20)) {
    lines.push(`  - ${g.afterOpenIso} → ${g.nextOpenIso} (${g.missingBars} missing)`);
  }
  lines.push(
    `- Forward close-to-close: max |return| ${fc.maxAbsReturnPct == null ? "—" : `${fc.maxAbsReturnPct.toFixed(3)}%`}; jumps ${Object.entries(fc.jumpCounts).map(([k, v]) => `${k}: ${v}`).join(", ")}`
  );
  lines.push(
    `- Warmup+forward close-to-close: max |return| ${di.loadedContinuity.maxAbsReturnPct == null ? "—" : `${di.loadedContinuity.maxAbsReturnPct.toFixed(3)}%`}; jumps ${Object.entries(di.loadedContinuity.jumpCounts).map(([k, v]) => `${k}: ${v}`).join(", ")}; sources ${JSON.stringify(di.loadedContinuity.sources)}`
  );
  lines.push(`- Pre-forward signals excluded: ${di.preForwardSignalsExcluded}; pre-forward trades in analysis: ${di.preForwardTradesInAnalysis}; no leakage: ${di.noPreForwardLeakage ? "confirmed" : "VIOLATED"}`);
  lines.push("");

  lines.push(`## C0 vs C1`);
  lines.push(`| Metric | ${r.variants.map((v) => v.label).join(" | ")} |`);
  lines.push(`|---|${r.variants.map(() => "---:").join("|")}|`);
  const row = (label: string, f: (v: ForwardVariantSummary) => string) =>
    lines.push(`| ${label} | ${r.variants.map(f).join(" | ")} |`);
  row("Executable signals", (v) => String(v.executableSignals));
  row("Gate rejections", (v) => String(v.gateRejections));
  row("Entries", (v) => String(v.entries));
  row("Resolved trades", (v) => String(v.resolvedTrades));
  row("W/L", (v) => `${v.wins}/${v.losses}`);
  row("Win rate", (v) => pct(v.winRate));
  row("Total R", (v) => n(v.totalR));
  row("Avg R", (v) => n(v.avgR));
  row("Max drawdown R", (v) => n(v.maxDrawdownR));
  row("Longest losing streak", (v) => String(v.longestLosingStreak));
  row("Open at end", (v) => String(v.openAtEnd));
  row("Max bars held", (v) => String(v.maxBarsHeld ?? "—"));
  row("Skipped while position open", (v) => String(v.skippedWhilePositionOpen));
  lines.push("");

  lines.push(`## EMA fallback-from-production-HOLD`);
  lines.push(`| Metric | ${r.variants.map((v) => v.label).join(" | ")} |`);
  lines.push(`|---|${r.variants.map(() => "---:").join("|")}|`);
  row("Entries", (v) => String(v.emaFallbackFromHold.entries));
  row("Resolved", (v) => String(v.emaFallbackFromHold.resolved));
  row("W/L", (v) => `${v.emaFallbackFromHold.wins}/${v.emaFallbackFromHold.losses}`);
  row("Win rate", (v) => pct(v.emaFallbackFromHold.winRate));
  row("Total R", (v) => n(v.emaFallbackFromHold.totalR));
  row("Avg R", (v) => n(v.emaFallbackFromHold.avgR));
  row("BUY", (v) => grp(v.emaFallbackFromHold.byDirection.BUY));
  row("SELL", (v) => grp(v.emaFallbackFromHold.byDirection.SELL));
  row("Rejected EMA signals", (v) => String(v.emaFallbackFromHold.rejectedSignals.length));
  lines.push("");
  const c0 = r.variants.find((v) => v.id === "C0_BASELINE");
  if (c0) {
    lines.push(`### C0 extension buckets (fast-EMA, ATR)`);
    lines.push(`| Bucket | Trades / W-L / R |`);
    lines.push(`|---|---|`);
    for (const b of EXTENSION_BUCKETS) lines.push(`| ${b} | ${grp(c0.emaFallbackFromHold.byExtensionBucket[b])} |`);
    lines.push("");
  }
  const c1 = r.variants.find((v) => v.id === "C1_EMA_MAX_EXTENSION_0_5");
  if (c1) {
    lines.push(`### C1 accepted EMA fallback-from-HOLD trades`);
    if (c1.emaFallbackFromHold.acceptedTrades.length === 0) lines.push(`- None`);
    for (const t of c1.emaFallbackFromHold.acceptedTrades) {
      lines.push(
        `- ${new Date(t.signalTimeMs).toISOString()} ${t.direction} entry ${t.entryPrice ?? "—"} ext ${n(t.extensionFromFastAtr)} ATR stop ${n(t.stopDistanceAtr)} ATR → ${t.outcome} ${t.realizedR == null ? "" : `${n(t.realizedR)}R`}`
      );
    }
    lines.push("");
    lines.push(`### C1 rejected EMA fallback-from-HOLD signals`);
    if (c1.emaFallbackFromHold.rejectedSignals.length === 0) lines.push(`- None`);
    for (const x of c1.emaFallbackFromHold.rejectedSignals) {
      lines.push(
        `- ${new Date(x.signalTimeMs).toISOString()} ${x.direction} ${x.reason} (ext ${n(x.detail?.extensionFromFastAtr ?? null)} ATR)`
      );
    }
    lines.push("");
  }

  lines.push(`## Weekly forward validation (UTC entry week, cumulative)`);
  for (const note of r.weekly.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push(
    `| Week (Mon UTC) | C0 R | C1 R | Δ R | C0 EMA-HOLD R | C1 EMA-HOLD R | Δ EMA-HOLD R | Cum C0 R | Cum C1 R | Cum Δ R | Cum C0 EMA R | Cum C1 EMA R | Cum Δ EMA R |`
  );
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const w of r.weekly.cumulative) {
    lines.push(
      `| ${w.weekStartIso} | ${n(w.c0R)} | ${n(w.c1R)} | ${n(w.deltaR)} | ${n(w.c0EmaR)} | ${n(w.c1EmaR)} | ${n(w.deltaEmaR)} | ${n(w.cumulativeC0R)} | ${n(w.cumulativeC1R)} | ${n(w.cumulativeDeltaR)} | ${n(w.cumulativeC0EmaR)} | ${n(w.cumulativeC1EmaR)} | ${n(w.cumulativeDeltaEmaR)} |`
    );
  }
  lines.push("");

  lines.push(`## Evidence status (descriptive only)`);
  const e = r.evidenceStatus;
  lines.push(`- Forward days elapsed: ${e.forwardDaysElapsed.toFixed(2)}`);
  lines.push(`- Resolved C1 trades: ${e.resolvedC1Trades}`);
  lines.push(`- Resolved C1 EMA fallback-from-HOLD trades: ${e.resolvedC1EmaFallbackFromHoldTrades}`);
  lines.push(`- Weeks with ≥1 resolved C1 trade: ${e.weeksWithResolvedC1Trade}`);
  lines.push(`- ${e.note}`);
  lines.push("");

  lines.push(`## Limitations`);
  for (const l of r.limitations) lines.push(`- ${l}`);
  return `${lines.join("\n")}\n`;
}
