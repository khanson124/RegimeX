import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { type Candle } from "@regimex/shared";

export interface ResearchDatasetManifest {
  datasetId: string;
  symbol: string;
  interval: string;
  sources: string[];
  startOpenTime: number | null;
  endOpenTime: number | null;
  startIso: string | null;
  endIso: string | null;
  rowCount: number;
  coveragePct: number | null;
  missingMinutes: number | null;
  gapCount: number | null;
  contentHash: string;
  createdAt: string;
  notes?: string;
}

export function hashCandleSeries(candles: ReadonlyArray<Candle>): string {
  const h = createHash("sha256");
  for (const c of candles) {
    h.update(
      `${c.symbol}|${c.interval}|${c.openTime}|${c.open}|${c.high}|${c.low}|${c.close}|${c.source}\n`
    );
  }
  return h.digest("hex");
}

export function buildResearchDatasetManifest(input: {
  datasetId: string;
  symbol: string;
  interval: string;
  sources: string[];
  candles: ReadonlyArray<Candle>;
  coveragePct?: number | null;
  missingMinutes?: number | null;
  gapCount?: number | null;
  notes?: string;
}): ResearchDatasetManifest {
  const first = input.candles[0] ?? null;
  const last = input.candles[input.candles.length - 1] ?? null;
  return {
    datasetId: input.datasetId,
    symbol: input.symbol,
    interval: input.interval,
    sources: input.sources,
    startOpenTime: first?.openTime ?? null,
    endOpenTime: last?.openTime ?? null,
    startIso: first ? new Date(first.openTime).toISOString() : null,
    endIso: last ? new Date(last.openTime).toISOString() : null,
    rowCount: input.candles.length,
    coveragePct: input.coveragePct ?? null,
    missingMinutes: input.missingMinutes ?? null,
    gapCount: input.gapCount ?? null,
    contentHash: hashCandleSeries(input.candles),
    createdAt: new Date().toISOString(),
    notes: input.notes
  };
}

export function writeResearchDatasetManifest(
  path: string,
  manifest: ResearchDatasetManifest
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
