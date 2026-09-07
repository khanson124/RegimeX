#!/usr/bin/env tsx
/**
 * Research-safe R_10 (or other catalogue) historical candle backfill via Deriv HISTORY_API.
 *
 * Usage:
 *   pnpm --filter @regimex/worker exec tsx scripts/backfillR10Candles.ts \
 *     --symbol R_10 --interval 1m \
 *     --from 2026-05-01T00:00:00.000Z --to 2026-09-07T00:00:00.000Z
 *
 * Flags:
 *   --dry-run          validate/fetch only; do not persist
 *   --no-persist       fetch/validate but do not write candles
 *   --purge-seed       delete R_10 (symbol) SEED mock 1m candles before backfill
 *                      so HISTORY_API can occupy those timestamps (conflicts otherwise)
 *   --manifest <path>  write dataset manifest JSON after backfill
 *
 * Does NOT deploy strategies or alter MT5/live execution.
 *
 * Semantics: Deriv ticks_history style=candles; epoch = bar open UTC; max 1000 bars/request.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig } from "@regimex/config";
import { PrismaClient } from "@regimex/database";
import {
  DerivClient,
  runHistoricalCandleBackfill,
  auditOneMinuteDataset,
  aggregateContiguousCompletedCandles,
  buildResearchDatasetManifest,
  writeResearchDatasetManifest,
  detectContinuousSegments,
  type Candle
} from "@regimex/trading-engine";
import { type CandleInterval } from "@regimex/shared";

function loadEnvFile(): void {
  const candidates = [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!.trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();

  const symbol = arg("symbol") ?? "R_10";
  const interval = (arg("interval") ?? "1m") as CandleInterval;
  if (interval !== "1m" && interval !== "5m") {
    throw new Error(`Unsupported interval ${interval}`);
  }
  const fromIso = arg("from") ?? "2026-05-01T00:00:00.000Z";
  const toIso = arg("to") ?? new Date().toISOString();
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error(`Invalid from/to: ${fromIso} → ${toIso}`);
  }
  const dryRun = hasFlag("dry-run");
  const persist = dryRun ? false : !hasFlag("no-persist");
  const purgeSeed = hasFlag("purge-seed");
  const manifestPath =
    arg("manifest") ??
    resolve(process.cwd(), `../../research-datasets/${symbol}_${interval}_manifest.json`);

  const prisma = new PrismaClient();
  const client = new DerivClient({
    wsUrl: config.DERIV_WS_URL,
    appId: config.DERIV_APP_ID,
    restUrl: config.DERIV_REST_URL
  });

  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: symbol } });
    if (!sym) throw new Error(`Symbol ${symbol} not found in DB catalogue`);

    let purgedSeed = 0;
    if (purgeSeed && !dryRun) {
      const del = await prisma.candle.deleteMany({
        where: { symbolId: sym.id, interval, source: "SEED" }
      });
      purgedSeed = del.count;
    }

    console.log(
      JSON.stringify(
        {
          action: "backfill-start",
          symbol,
          interval,
          fromIso,
          toIso,
          dryRun,
          persist,
          purgeSeed,
          purgedSeed,
          source: "HISTORY_API",
          semantics:
            "Deriv ticks_history style=candles; open epoch = bar open UTC; max 1000 candles/request (trailing)"
        },
        null,
        2
      )
    );

    await client.connect();

    const result = await runHistoricalCandleBackfill({
      client,
      symbol,
      interval,
      fromMs,
      toMs,
      dryRun: !persist,
      loadExisting: async (a, b) => {
        const rows = await prisma.candle.findMany({
          where: {
            symbolId: sym.id,
            interval,
            openTime: { gte: new Date(a), lt: new Date(b) }
          },
          select: {
            openTime: true,
            open: true,
            high: true,
            low: true,
            close: true,
            source: true
          }
        });
        return rows.map((r) => ({
          openTimeMs: r.openTime.getTime(),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          source: r.source
        }));
      },
      persist: async (candles) => {
        const data = candles.map((c) => ({
          symbolId: sym.id,
          interval: c.interval,
          openTime: new Date(c.openTime),
          closeTime: new Date(c.closeTime),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          tickCount: 0,
          isComplete: true,
          source: "HISTORY_API"
        }));
        const res = await prisma.candle.createMany({ data, skipDuplicates: true });
        return res.count;
      },
      onProgress: (p) => {
        if (p.percent % 10 === 0) {
          console.log(
            JSON.stringify({
              progress: p.percent,
              fetched: p.fetched,
              inserted: p.inserted,
              duplicates: p.duplicates,
              conflicts: p.conflicts,
              invalid: p.invalid
            })
          );
        }
      }
    });

    // Post-audit: load HISTORY_API (+ optional all) for continuity
    const histRows = await prisma.candle.findMany({
      where: { symbolId: sym.id, interval: "1m", source: "HISTORY_API", isComplete: true },
      orderBy: { openTime: "asc" }
    });
    const histCandles: Candle[] = histRows.map((r) => ({
      symbol,
      interval: "1m",
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true,
      source: "HISTORY_API"
    }));

    const audit = auditOneMinuteDataset(histCandles);
    const segments = detectContinuousSegments(histCandles, 2 * 60_000);
    const contiguous5m = aggregateContiguousCompletedCandles(histCandles, "5m");

    const manifest = buildResearchDatasetManifest({
      datasetId: `${symbol}_1m_HISTORY_API_${Date.now()}`,
      symbol,
      interval: "1m",
      sources: ["HISTORY_API"],
      candles: histCandles,
      coveragePct: audit.coveragePct,
      missingMinutes: audit.missingCandleCount,
      gapCount: audit.gapCount,
      notes:
        "Deriv HISTORY_API candles. Prefer this source for research vs mixed LIVE_TICKS/MT5. Gaps are real source gaps, not interpolated."
    });
    writeResearchDatasetManifest(manifestPath, manifest);

    const reportPath = resolve(dirname(manifestPath), `${symbol}_1m_backfill_report.json`);

    const report = {
      backfill: result,
      auditAfterHistoryApi: {
        actualCandleCount: audit.actualCandleCount,
        firstIso: audit.firstIso,
        lastIso: audit.lastIso,
        expectedContinuous1mCount: audit.expectedContinuous1mCount,
        missingCandleCount: audit.missingCandleCount,
        missingCandlePct: audit.missingCandlePct,
        coveragePct: audit.coveragePct,
        gapCount: audit.gapCount,
        gapSizeDistribution: audit.gapSizeDistribution,
        longestGaps: audit.longestGaps.slice(0, 10)
      },
      segments: {
        maxGapMs: segments.maxGapMs,
        segmentCount: segments.segmentCount,
        largestSegmentCandleCount: segments.largestSegmentCandleCount,
        largestSegmentSpanMs: segments.largestSegmentSpanMs,
        segments: segments.segments.map((s) => ({
          index: s.segmentIndex,
          startIso: s.startIso,
          endIso: s.endIso,
          candleCount: s.candleCount
        }))
      },
      contiguous5m: {
        valid: contiguous5m.validCount,
        excluded: contiguous5m.excludedCount
      },
      manifestPath,
      manifest
    };

    mkdirSync(resolve(manifestPath, ".."), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Wrote manifest: ${manifestPath}`);
    console.log(`Wrote report: ${reportPath}`);
  } finally {
    await client.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
