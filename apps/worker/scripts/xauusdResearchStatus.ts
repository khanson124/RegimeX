#!/usr/bin/env tsx
/**
 * Report XAUUSD research readiness without inventing history or enabling trading.
 *
 *   pnpm exec tsx scripts/xauusdResearchStatus.ts
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrisma, disconnectPrisma } from "@regimex/database";
import { XAUUSD_INTERNAL_SYMBOL, loadPassiveSpreadSamples } from "@regimex/trading-engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");
const outPath = resolve(root, "research-datasets/XAUUSD_research_status.json");

function loadEnvFile(): void {
  for (const path of [resolve(root, ".env"), resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const prisma = getPrisma();
  const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: XAUUSD_INTERNAL_SYMBOL } });
  const candleCount = symbol
    ? await prisma.candle.count({ where: { symbolId: symbol.id, interval: "1m" } })
    : 0;
  const mapping = symbol
    ? await prisma.brokerSymbolMapping.findFirst({
        where: {
          internalSymbolId: symbol.id,
          broker: "Deriv",
          venue: "MT5",
          executionMode: "broker_demo_mt5"
        }
      })
    : null;

  const passivePath = resolve(root, "research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl");
  const passiveSamples = existsSync(passivePath) ? loadPassiveSpreadSamples(passivePath) : [];
  const discoveryPath = resolve(root, "research-datasets/XAUUSD_mt5_discovery.json");

  const insufficient = candleCount < 5_000;
  const report = {
    datasetId: "XAUUSD_1m",
    symbol: XAUUSD_INTERNAL_SYMBOL,
    interval: "1m",
    candleCount,
    cataloguePresent: Boolean(symbol),
    mapping: mapping
      ? { brokerSymbol: mapping.brokerSymbol, verified: mapping.verified, source: mapping.source }
      : null,
    passiveSpreadSampleCount: passiveSamples.length,
    discoveryArtifactPresent: existsSync(discoveryPath),
    researchStatus: insufficient
      ? "XAUUSD_RESEARCH_BLOCKED_INSUFFICIENT_HISTORY"
      : "XAUUSD_HISTORY_PRESENT_REVIEW_BEFORE_BENCHMARK",
    note: insufficient
      ? "No fabricated history. Forward MT5 1m collection + optional historical API only when available."
      : "History present — run gap-safe audit before any strategy benchmark.",
    strategiesBenchmarked: [],
    empiricalSlippageSamples: 0,
    enablement: {
      allowlist: false,
      autonomousTrading: false,
      deployed: false
    },
    generatedAt: new Date().toISOString()
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  await disconnectPrisma();
}

void main();
