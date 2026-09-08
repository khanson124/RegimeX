import { existsSync } from "node:fs";
import {
  loadPassiveSpreadSamples,
  type PassiveSpreadSampleRecord
} from "./mt5PassiveSpreadSampler.js";

export interface ObservedSpreadDistribution {
  symbol: string;
  sampleCount: number;
  status: "SUFFICIENT" | "PRELIMINARY" | "UNAVAILABLE";
  label: "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST";
  medianBps: number | null;
  p75Bps: number | null;
  p90Bps: number | null;
  p95Bps: number | null;
  p99Bps: number | null;
  medianSpreadPrice: number | null;
  sourcePath: string | null;
  note: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarizeObservedXauUsdSpread(
  path: string,
  opts?: { preliminaryFromOperator?: { sampleCount: number; medianBps: number; medianSpreadPrice?: number } }
): ObservedSpreadDistribution {
  const label = "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST" as const;
  if (!existsSync(path)) {
    if (opts?.preliminaryFromOperator) {
      return {
        symbol: "XAUUSD",
        sampleCount: opts.preliminaryFromOperator.sampleCount,
        status: "PRELIMINARY",
        label,
        medianBps: opts.preliminaryFromOperator.medianBps,
        p75Bps: null,
        p90Bps: null,
        p95Bps: null,
        p99Bps: null,
        medianSpreadPrice: opts.preliminaryFromOperator.medianSpreadPrice ?? null,
        sourcePath: null,
        note: "Sample file missing locally; using operator-reported production passive-sample summary (<30 → PRELIMINARY)."
      };
    }
    return {
      symbol: "XAUUSD",
      sampleCount: 0,
      status: "UNAVAILABLE",
      label,
      medianBps: null,
      p75Bps: null,
      p90Bps: null,
      p95Bps: null,
      p99Bps: null,
      medianSpreadPrice: null,
      sourcePath: path,
      note: "No passive spread samples available."
    };
  }

  const rows = loadPassiveSpreadSamples(path).filter((r) => r.symbol === "XAUUSD");
  return summarizeObservedSpreadRows(rows, path);
}

export function summarizeObservedSpreadRows(
  rows: ReadonlyArray<PassiveSpreadSampleRecord>,
  sourcePath: string | null = null
): ObservedSpreadDistribution {
  const label = "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST" as const;
  const bps = rows.map((r) => r.spreadBps).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const prices = rows
    .map((r) => r.spreadPrice)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const status = rows.length >= 30 ? "SUFFICIENT" : rows.length > 0 ? "PRELIMINARY" : "UNAVAILABLE";
  return {
    symbol: "XAUUSD",
    sampleCount: rows.length,
    status,
    label,
    medianBps: percentile(bps, 50),
    p75Bps: percentile(bps, 75),
    p90Bps: percentile(bps, 90),
    p95Bps: percentile(bps, 95),
    p99Bps: percentile(bps, 99),
    medianSpreadPrice: percentile(prices, 50),
    sourcePath,
    note:
      status === "PRELIMINARY"
        ? `sampleCount=${rows.length} < 30 — PRELIMINARY spread estimate`
        : status === "SUFFICIENT"
          ? `sampleCount=${rows.length} ≥ 30 — distribution reported`
          : "No OK samples"
  };
}
