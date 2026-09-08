/**
 * Persistent MT5-native OHLC store (JSONL).
 * Source-tagged MT5 only — never mix with HISTORY_API / MT5_LIVE_TICKS silently.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Mt5Bar, type Mt5BarTimeframe } from "../broker/mt5/types.js";

export interface Mt5StoredBar extends Mt5Bar {
  brokerSymbol: string;
  collectedAt: string;
}

export function mt5BarDedupeKey(bar: {
  brokerSymbol?: string;
  symbol: string;
  timeframe: string;
  openTimeMs: number;
  source: string;
}): string {
  const broker = bar.brokerSymbol ?? bar.symbol;
  return `${broker}|${bar.timeframe}|${bar.openTimeMs}|${bar.source}`;
}

export function loadMt5BarsJsonl(path: string): Mt5StoredBar[] {
  if (!existsSync(path)) return [];
  const out: Mt5StoredBar[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as Mt5StoredBar;
      if (row?.source !== "MT5") continue;
      if (typeof row.openTimeMs !== "number") continue;
      out.push(row);
    } catch {
      // skip corrupt lines
    }
  }
  return dedupeMt5Bars(out);
}

export function dedupeMt5Bars(bars: ReadonlyArray<Mt5StoredBar>): Mt5StoredBar[] {
  const map = new Map<string, Mt5StoredBar>();
  for (const b of bars) {
    map.set(mt5BarDedupeKey(b), b);
  }
  return [...map.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function appendMt5BarsJsonl(
  path: string,
  bars: ReadonlyArray<Mt5Bar>,
  opts?: { brokerSymbol?: string; collectedAt?: string }
): { written: number; skippedDuplicates: number; total: number } {
  mkdirSync(dirname(path), { recursive: true });
  const existing = loadMt5BarsJsonl(path);
  const keys = new Set(existing.map(mt5BarDedupeKey));
  const collectedAt = opts?.collectedAt ?? new Date().toISOString();
  let written = 0;
  let skippedDuplicates = 0;
  const lines: string[] = [];
  for (const bar of bars) {
    if (bar.source !== "MT5") continue;
    const stored: Mt5StoredBar = {
      ...bar,
      brokerSymbol: opts?.brokerSymbol ?? bar.symbol,
      collectedAt
    };
    const key = mt5BarDedupeKey(stored);
    if (keys.has(key)) {
      skippedDuplicates++;
      continue;
    }
    keys.add(key);
    lines.push(JSON.stringify(stored));
    written++;
  }
  if (lines.length) {
    appendFileSync(path, lines.join("\n") + "\n", "utf8");
  }
  return { written, skippedDuplicates, total: keys.size };
}

/** Rewrite file fully from deduped set (compaction). */
export function rewriteMt5BarsJsonl(path: string, bars: ReadonlyArray<Mt5StoredBar>): number {
  mkdirSync(dirname(path), { recursive: true });
  const deduped = dedupeMt5Bars(bars);
  writeFileSync(path, deduped.map((b) => JSON.stringify(b)).join("\n") + (deduped.length ? "\n" : ""), "utf8");
  return deduped.length;
}

export function defaultMt5BarsArtifactPath(
  researchDir: string,
  timeframe: Mt5BarTimeframe,
  symbol = "XAUUSD"
): string {
  return `${researchDir.replace(/\/$/, "")}/${symbol}_mt5_${timeframe}_candles.jsonl`;
}
