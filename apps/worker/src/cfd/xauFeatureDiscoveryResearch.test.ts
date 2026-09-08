/**
 * XAUUSD feature discovery / edge mapping (NO new strategies).
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauFeatureDiscoveryResearch.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertSegmentBoundaryIntegrity,
  CFD_CAPABLE_STRATEGY_IDS,
  inventoryXauUsdWeeklySegments,
  runFeatureDiscovery,
  summarizeObservedXauUsdSpread
} from "@regimex/trading-engine";
import { STRATEGY_KINDS } from "@regimex/shared";

function loadDatabaseUrlFromEnvFile(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const path of [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ]) {
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_URL="));
    if (!line) continue;
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const databaseUrl = loadDatabaseUrlFromEnvFile();
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

async function loadCandles(): Promise<Candle[]> {
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
      source: r.source as Candle["source"]
    }));
  } finally {
    await prisma.$disconnect();
  }
}

describe("XAUUSD feature discovery research", () => {
  it(
    "maps features to forward outcomes without creating strategies or enabling XAUUSD",
    async () => {
      expect(STRATEGY_KINDS as readonly string[]).not.toContain("xau-feature-discovery");
      expect(CFD_CAPABLE_STRATEGY_IDS as readonly string[]).not.toContain(
        "xau-feature-discovery-v1"
      );

      const history = await loadCandles();
      expect(history.length).toBeGreaterThan(5000);

      const inventory = inventoryXauUsdWeeklySegments(history);
      assertSegmentBoundaryIntegrity(inventory);
      const usable = inventory.filter((w) => w.usable);
      expect(usable.length).toBeGreaterThanOrEqual(8);

      const spreadPath = resolve(
        process.cwd(),
        "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
      );
      const spread = summarizeObservedXauUsdSpread(spreadPath, {
        preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
      });

      const report = runFeatureDiscovery({
        usableWeeks: usable,
        spreadBps: spread.medianBps ?? 0.61,
        spreadStatus: spread.status,
        assumedSlipBps: [0.1, 0.25, 0.5],
        timeframes: ["5m", "15m", "1m"],
        seed: 20260908
      });

      expect(report.safety.noStrategyCreated).toBe(true);
      expect(report.splits.holdoutWeeks.length).toBeGreaterThan(0);
      expect(report.featureInventory.length).toBeGreaterThan(10);

      const outDir = resolve(process.cwd(), "../../research-datasets");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "XAUUSD_feature_discovery.json");
      writeFileSync(outPath, JSON.stringify(report, null, 2));

      console.log(
        JSON.stringify(
          {
            observationCounts: report.observationCounts,
            splits: report.splits,
            anyMeaningfulRepeatableEdge: report.anyMeaningfulRepeatableEdge,
            recommendNewStrategy: report.recommendNewStrategy,
            topCandidates: report.candidates.slice(0, 5).map((c) => ({
              description: c.description,
              disc: c.discoveryEffect,
              val: c.validationEffect,
              hold: c.holdoutEffect,
              warnings: c.warnings
            })),
            negatives: report.negativeFindings.slice(0, 5),
            artifact: outPath
          },
          null,
          2
        )
      );
    },
    600_000
  );
});
