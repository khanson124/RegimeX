#!/usr/bin/env tsx
/**
 * Read-only MT5 XAUUSD candle collection + parity status.
 * Places NO trades. Does NOT enable XAUUSD / strategies / allowlists.
 *
 *   pnpm --filter @regimex/worker exec tsx scripts/collectXauUsdMt5Bars.ts --recent-count 500
 *   pnpm --filter @regimex/worker exec tsx scripts/collectXauUsdMt5Bars.ts --from-ms ... --to-ms ...
 *
 * Writes:
 *   research-datasets/XAUUSD_mt5_{1m,5m,15m}_candles.jsonl
 *   research-datasets/XAUUSD_mt5_data_parity_status.json
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { loadConfig } from "@regimex/config";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  appendMt5BarsJsonl,
  buildMt5DataParityStatus,
  defaultMt5BarsArtifactPath,
  fetchMt5BarsChunked,
  fetchRecentMt5Bars,
  loadMt5BarsJsonl,
  loadPassiveSpreadSamples,
  selectBestGoldSymbol,
  XAUUSD_INTERNAL_SYMBOL,
  type Mt5BarTimeframe
} from "@regimex/trading-engine";
import { createConfiguredMt5Client } from "../src/cfd/mt5AdapterFactory.js";
import { researchDatasetPath, resolveResearchDatasetsDir } from "../src/lib/researchDatasetsPath.js";

function loadEnvFile(): void {
  for (const path of [
    "/app/.env",
    process.cwd() + "/.env",
    process.cwd() + "/../../.env",
    process.cwd() + "/../../../.env"
  ]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function loadFrx1m(): Promise<Candle[]> {
  if (!process.env.DATABASE_URL) return [];
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "XAUUSD" } });
    if (!symbol) return [];
    const rows = await prisma.candle.findMany({
      where: {
        symbolId: symbol.id,
        interval: "1m",
        isComplete: true,
        source: "HISTORY_API"
      },
      orderBy: { openTime: "asc" }
    });
    return rows.map((r) => ({
      symbol: "XAUUSD",
      interval: "1m" as const,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true,
      source: "HISTORY_API" as const
    }));
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  if (config.MT5_EXPECTED_ENVIRONMENT !== "demo") {
    throw new Error("Collection refused unless MT5_EXPECTED_ENVIRONMENT=demo");
  }

  const researchDir = resolveResearchDatasetsDir();
  const timeframes = (arg("timeframes") ?? "1m,5m,15m")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Mt5BarTimeframe[];
  const recentCount = Number(arg("recent-count") ?? 500);
  const fromMs = arg("from-ms") ? Number(arg("from-ms")) : null;
  const toMs = arg("to-ms") ? Number(arg("to-ms")) : null;
  const statusOnly = hasFlag("status-only");

  const adapter = await createConfiguredMt5Client(config);
  try {
    let brokerSymbol = arg("broker-symbol");
    if (!brokerSymbol) {
      const symbols = await adapter.discoverSymbols();
      const gold = selectBestGoldSymbol(symbols);
      if (!gold) throw new Error("No gold symbol — pass --broker-symbol");
      brokerSymbol = gold.brokerSymbol;
    }

    if (!statusOnly) {
      for (const tf of timeframes) {
        const path = defaultMt5BarsArtifactPath(researchDir, tf, XAUUSD_INTERNAL_SYMBOL);
        let bars;
        let semantics: string | null = null;
        if (fromMs != null && toMs != null) {
          const chunked = await fetchMt5BarsChunked(adapter, {
            symbol: brokerSymbol,
            timeframe: tf,
            fromMs,
            toMs,
            completedBarsOnly: true
          });
          bars = chunked.bars;
          semantics = chunked.timestampSemantics;
          console.log(
            JSON.stringify({
              timeframe: tf,
              mode: "range",
              chunks: chunked.chunks,
              returned: bars.length,
              first: chunked.firstOpenTimeMs,
              last: chunked.lastOpenTimeMs,
              truncatedChunks: chunked.truncatedChunks
            })
          );
        } else {
          const result = await fetchRecentMt5Bars(adapter, {
            symbol: brokerSymbol,
            timeframe: tf,
            count: recentCount,
            completedBarsOnly: true
          });
          bars = result.bars;
          semantics = result.timestampSemantics;
          console.log(
            JSON.stringify({
              timeframe: tf,
              mode: "recent",
              returned: bars.length,
              offsetSec: result.brokerServerUtcOffsetSeconds,
              semantics
            })
          );
        }
        const write = appendMt5BarsJsonl(path, bars, { brokerSymbol });
        console.log(JSON.stringify({ path, ...write }));
      }
    }

    const bars1m = loadMt5BarsJsonl(defaultMt5BarsArtifactPath(researchDir, "1m"));
    const bars5m = loadMt5BarsJsonl(defaultMt5BarsArtifactPath(researchDir, "5m"));
    const bars15m = loadMt5BarsJsonl(defaultMt5BarsArtifactPath(researchDir, "15m"));
    const frx1m = await loadFrx1m();
    const spreadPath = researchDatasetPath(`${XAUUSD_INTERNAL_SYMBOL}_mt5_passive_spread_samples.jsonl`);
    const spreadRows = loadPassiveSpreadSamples(spreadPath);

    const status = buildMt5DataParityStatus({
      bars1m,
      bars5m,
      bars15m,
      frx1m,
      spreadRows,
      spreadPath,
      brokerSymbol
    });
    const statusPath = researchDatasetPath(`${XAUUSD_INTERNAL_SYMBOL}_mt5_data_parity_status.json`);
    writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log(
      JSON.stringify(
        {
          statusPath,
          counts: status.counts,
          overallOhlcVerdict: status.overallOhlcVerdict,
          signalParity: status.signalParity?.verdict ?? null,
          sufficientForIndependentResearch: status.sufficientForIndependentResearch,
          frxResultsLikelyTransferable: status.frxResultsLikelyTransferable,
          spreadN: status.spread.sampleCount,
          safety: status.safety
        },
        null,
        2
      )
    );
  } finally {
    await adapter.disconnect?.();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
