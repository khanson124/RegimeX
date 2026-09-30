/**
 * Offline Pass C research variants: EMA pullback fallback-from-HOLD entry-quality gates.
 *
 * Each variant reruns the full Pass C economic state machine (its own pending/open state) on the
 * same Pass C signal stream. The selector's Pass C cooldown advances on the selector signal, not on
 * economic acceptance, so the signal stream is identical across variants by construction.
 *
 * Gates see only signal-candle features, the entry open, and the entry-time stop/target plan.
 * Research only — not a recommended gate; nothing here reaches production selection, DEMO, or REAL.
 */
import { type Candle } from "@regimex/shared";
import {
  EMA_FALLBACK_STRATEGY_ID,
  computeEmaEntryGeometry,
  type EmaDiagnosticGroupStats,
  type EmaFallbackTradeDiagnostic,
  type ExtensionBucket
} from "./autoSelectionEmaFallbackDiagnostics.js";
import {
  aggregatePassEconomicMetrics,
  simulatePassEconomicOutcomes,
  type ReplayEconomicSignal,
  type ReplayEntryGate,
  type ReplayEntryGateContext,
  type ReplayPassEconomicMetrics,
  type ReplaySimulatedTrade
} from "./autoSelectionReplayOutcomes.js";
import { type ReplayResearchGateRejection } from "./autoSelectionReplaySimulationDiagnostics.js";

export const PASS_C_VARIANT_IDS = [
  "C0_BASELINE",
  "C1_EMA_MAX_EXTENSION_0_5",
  "C2_EMA_EXTENSION_0_25_TO_0_5",
  "C3_EMA_MAX_EXTENSION_0_5_AND_STOP_0_5_TO_1_0"
] as const;
export type PassCVariantId = (typeof PASS_C_VARIANT_IDS)[number];

export const EMA_GEOMETRY_UNAVAILABLE = "EMA_GEOMETRY_UNAVAILABLE";

export interface PassCVariantDefinition {
  id: PassCVariantId;
  label: string;
  description: string;
  /** null = baseline (no gate). */
  gate: ReplayEntryGate | null;
}

/** Scope shared by every EMA research gate: Pass C, EMA pullback, production was HOLD. */
export function isEmaFallbackFromHold(ctx: Pick<ReplayEntryGateContext, "pass" | "strategyId" | "fromProductionHold">): boolean {
  return ctx.pass === "C" && ctx.strategyId === EMA_FALLBACK_STRATEGY_ID && ctx.fromProductionHold;
}

/** Entry-time geometry identical to the EMA diagnostic (stop distance = |entry − stop|). */
export function gateGeometry(ctx: ReplayEntryGateContext) {
  return computeEmaEntryGeometry({
    direction: ctx.direction,
    entryPrice: ctx.entryPrice,
    stopDistance: ctx.plan.stopLoss != null ? Math.abs(ctx.entryPrice - ctx.plan.stopLoss) : null,
    features: ctx.signalFeatures
  });
}

const ACCEPT = { reject: false, reason: null } as const;

function emaGate(
  check: (g: { ext: number; stop: number | null }) => string | null,
  needsStop: boolean
): ReplayEntryGate {
  return (ctx) => {
    if (!isEmaFallbackFromHold(ctx)) return ACCEPT;
    const g = gateGeometry(ctx);
    const detail = { extensionFromFastAtr: g.extensionFromFastAtr, stopDistanceAtr: g.stopDistanceAtr };
    if (g.extensionFromFastAtr == null || (needsStop && g.stopDistanceAtr == null)) {
      return { reject: true, reason: EMA_GEOMETRY_UNAVAILABLE, detail };
    }
    const reason = check({ ext: g.extensionFromFastAtr, stop: g.stopDistanceAtr });
    return reason ? { reject: true, reason, detail } : ACCEPT;
  };
}

export const PASS_C_VARIANTS: readonly PassCVariantDefinition[] = [
  {
    id: "C0_BASELINE",
    label: "C0 baseline",
    description: "Current Pass C behavior unchanged.",
    gate: null
  },
  {
    id: "C1_EMA_MAX_EXTENSION_0_5",
    label: "C1 EMA ext ≤ 0.5",
    description: "EMA fallback-from-HOLD: reject if direction-signed fast-EMA extension > 0.5 ATR.",
    gate: emaGate(({ ext }) => (ext > 0.5 ? "EMA_EXTENSION_GT_0_5" : null), false)
  },
  {
    id: "C2_EMA_EXTENSION_0_25_TO_0_5",
    label: "C2 EMA 0.25 < ext ≤ 0.5",
    description: "EMA fallback-from-HOLD: allow only 0.25 < extension ≤ 0.5 ATR.",
    gate: emaGate(({ ext }) => {
      if (ext <= 0.25) return "EMA_EXTENSION_LE_0_25";
      if (ext > 0.5) return "EMA_EXTENSION_GT_0_5";
      return null;
    }, false)
  },
  {
    id: "C3_EMA_MAX_EXTENSION_0_5_AND_STOP_0_5_TO_1_0",
    label: "C3 EMA ext ≤ 0.5 & 0.5 ≤ stop ≤ 1.0",
    description:
      "EMA fallback-from-HOLD: require extension ≤ 0.5 ATR and 0.5 ≤ stop distance ≤ 1.0 ATR (inclusive).",
    gate: emaGate(({ ext, stop }) => {
      if (ext > 0.5) return "EMA_EXTENSION_GT_0_5";
      if (stop! < 0.5) return "EMA_STOP_LT_0_5_ATR";
      if (stop! > 1.0) return "EMA_STOP_GT_1_0_ATR";
      return null;
    }, true)
  }
];

export interface PassCVariantEmaSummary {
  stats: EmaDiagnosticGroupStats;
  byDirection: Partial<Record<"BUY" | "SELL", EmaDiagnosticGroupStats>>;
  byExtensionBucket: Partial<Record<ExtensionBucket, EmaDiagnosticGroupStats>>;
  /** Per-trade EMA fallback-from-HOLD records (entry geometry, outcome). */
  records: EmaFallbackTradeDiagnostic[];
}

export interface PassCVariantResult {
  id: PassCVariantId;
  label: string;
  description: string;
  signalsConsidered: number;
  signalsRejectedByResearchGate: number;
  rejectionsByReason: Record<string, number>;
  entriesOpened: number;
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
  signalsSkippedOpenPosition: number;
  metrics: ReplayPassEconomicMetrics;
  byStrategyDirection: Record<string, Partial<Record<"BUY" | "SELL", ReplayPassEconomicMetrics>>>;
  emaFallbackFromHold: PassCVariantEmaSummary;
  rejections: ReplayResearchGateRejection[];
  trades: ReplaySimulatedTrade[];
}

export interface PassCVariantsReport {
  notes: string[];
  variants: PassCVariantResult[];
}

function byStrategyDirection(trades: ReadonlyArray<ReplaySimulatedTrade>): PassCVariantResult["byStrategyDirection"] {
  const groups = new Map<string, Map<"BUY" | "SELL", ReplaySimulatedTrade[]>>();
  for (const t of trades) {
    let dirs = groups.get(t.strategyId);
    if (!dirs) groups.set(t.strategyId, (dirs = new Map()));
    const dir = t.direction as "BUY" | "SELL";
    const list = dirs.get(dir) ?? [];
    list.push(t);
    dirs.set(dir, list);
  }
  const out: PassCVariantResult["byStrategyDirection"] = {};
  for (const [id, dirs] of groups) {
    const row: Partial<Record<"BUY" | "SELL", ReplayPassEconomicMetrics>> = {};
    for (const [dir, list] of dirs) row[dir] = aggregatePassEconomicMetrics(list);
    out[id] = row;
  }
  return out;
}

export function runPassCResearchVariants(input: {
  candles: ReadonlyArray<Candle>;
  signals: ReadonlyArray<ReplayEconomicSignal>;
  parametersByStrategyId: Map<string, Record<string, number | boolean | string>>;
  tickSize: number;
  featureLookback?: number;
  variants?: readonly PassCVariantDefinition[];
}): PassCVariantsReport {
  const passCSignals = input.signals.filter((s) => s.pass === "C");
  const variants = (input.variants ?? PASS_C_VARIANTS).map((v): PassCVariantResult => {
    const economic = simulatePassEconomicOutcomes({
      candles: input.candles,
      signals: passCSignals,
      parametersByStrategyId: input.parametersByStrategyId,
      tickSize: input.tickSize,
      featureLookback: input.featureLookback,
      ...(v.gate ? { entryGate: v.gate } : {})
    });
    const sim = economic.simulationDiagnostics.C;
    const m = economic.passC;
    const trades = economic.trades.filter((t) => t.pass === "C");
    const rejectionsByReason: Record<string, number> = {};
    for (const r of sim.researchGateRejections) {
      rejectionsByReason[r.reason] = (rejectionsByReason[r.reason] ?? 0) + 1;
    }
    const ema = economic.emaFallbackFromHold;
    return {
      id: v.id,
      label: v.label,
      description: v.description,
      signalsConsidered: sim.executableSignalsSeen,
      signalsRejectedByResearchGate: sim.signalsRejectedByResearchGate,
      rejectionsByReason,
      entriesOpened: sim.entriesOpened,
      resolvedTrades: m.targetHits + m.stopHits,
      wins: m.targetHits,
      losses: m.stopHits,
      winRate: m.winRate,
      totalR: m.totalRealizedR,
      avgR: m.avgRPerResolvedTrade,
      maxDrawdownR: m.maxDrawdownR,
      longestLosingStreak: m.longestLosingStreak,
      openAtEnd: m.openAtEnd,
      maxBarsHeld: sim.maxBarsHeld,
      signalsSkippedOpenPosition: sim.signalsSkippedOpenPosition,
      metrics: m,
      byStrategyDirection: byStrategyDirection(trades),
      emaFallbackFromHold: {
        stats: ema.overall,
        byDirection: ema.byDirection,
        byExtensionBucket: ema.byExtensionBucket,
        records: ema.trades
      },
      rejections: sim.researchGateRejections,
      trades
    };
  });

  return {
    notes: [
      "Research variants only — not recommended gates; not applied to production selection, DEMO, or REAL.",
      "Each variant reruns the full Pass C economic sequence with its own pending/open state (SINGLE_POSITION_PER_PASS).",
      "A rejected entry leaves the pass flat, so later signals (including on the entry bar) may execute; results are not bucket subtraction.",
      "Gate inputs: signal-candle features (candles[..signal]), the next-candle entry open, and the entry-time stop plan. No later candle is used.",
      "Pass C selector cooldown advances on the selector signal regardless of economic acceptance, so the signal stream is identical across variants.",
      `EMA fallback-from-HOLD entries without computable ATR/EMA geometry are rejected (${EMA_GEOMETRY_UNAVAILABLE}) by C1–C3.`,
      "Gates only touch Pass C ema-pullback-v1 trades with fromProductionHold === true; other strategies and production-selected EMA trades are unchanged."
    ],
    variants
  };
}
