/**
 * XAU Trend Pullback v1 research (no enablement / no DEMO auto-promotion).
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauTrendPullbackResearch.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertProductionIntervalsUnchanged,
  assertSegmentBoundaryIntegrity,
  CFD_CAPABLE_STRATEGY_IDS,
  chronologicalWeekSplit,
  inventoryXauUsdWeeklySegments,
  runXauTrendPullbackResearch,
  summarizeObservedXauUsdSpread,
  SQUEEZE_BREAKOUT_DEFAULTS,
  XAU_TREND_PULLBACK_DEFAULTS
} from "@regimex/trading-engine";

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

describe("xau-trend-pullback-v1 research", () => {
  it(
    "runs train / validation / holdout + cost sensitivity without enabling XAUUSD",
    async () => {
      assertProductionIntervalsUnchanged();
      expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
      expect(SQUEEZE_BREAKOUT_DEFAULTS).toBeTruthy();
      expect(XAU_TREND_PULLBACK_DEFAULTS.targetRMultiple).toBe(2);
      expect(CFD_CAPABLE_STRATEGY_IDS).toContain("xau-trend-pullback-v1");

      const history = await loadCandles();
      expect(history.length).toBeGreaterThan(10_000);

      const inventory = inventoryXauUsdWeeklySegments(history);
      assertSegmentBoundaryIntegrity(inventory);
      const usable = inventory.filter((w) => w.usable);
      expect(usable.length).toBeGreaterThanOrEqual(8);

      const chrono = chronologicalWeekSplit(usable, 0.3);
      expect(chrono.developmentWeeks.length).toBeGreaterThan(0);
      expect(chrono.holdoutWeeks.length).toBeGreaterThan(0);

      const spreadPath = resolve(
        process.cwd(),
        "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
      );
      const spread = summarizeObservedXauUsdSpread(spreadPath, {
        preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
      });
      const observedSpreadBps = spread.medianBps ?? 0.61;

      const report = await runXauTrendPullbackResearch({
        candles1m: history,
        usableWeeks: usable,
        observedSpreadBps,
        spreadStatus: spread.status ?? "PRELIMINARY_OPERATOR_MEDIAN"
      });

      expect(report.strategyId).toBe("xau-trend-pullback-v1");
      expect(report.safety).toMatchObject({
        noStrategyEnabled: true,
        notOnMt5Allowlist: true,
        r10SqueezeForwardTrialUntouched: true,
        nothingDeployed: true
      });
      expect(typeof report.passesDemoCandidate).toBe("boolean");
      expect(report.classification).toBeTruthy();

      const outDir = resolve(process.cwd(), "../../research-datasets");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "XAUUSD_xau_trend_pullback_v1_research.json");
      writeFileSync(outPath, JSON.stringify(report, null, 2));
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            artifact: outPath,
            classification: report.classification,
            passesDemoCandidate: report.passesDemoCandidate,
            reasons: report.classificationReasons,
            holdoutTrades: (report.holdout as { trades?: number })?.trades,
            holdoutExpectancyR: (report.holdout as { expectancyR?: number })?.expectancyR,
            holdoutProfitFactor: (report.holdout as { profitFactor?: number | null })?.profitFactor
          },
          null,
          2
        )
      );
    },
    1_800_000
  );
});
