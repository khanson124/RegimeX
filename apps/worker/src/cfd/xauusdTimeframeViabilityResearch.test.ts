/**
 * XAUUSD timeframe viability research (1m / 5m / research-only 15m).
 * No enablement, no strategy mutation, no production interval changes.
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauusdTimeframeViabilityResearch.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertNoStrategyParameterMutation,
  assertProductionIntervalsUnchanged,
  assertSegmentBoundaryIntegrity,
  buildCrossTimeframeTable,
  buildXauUsdCostProfiles,
  candlesForResearchTimeframe,
  chronologicalWeekSplit,
  evaluateStrategyTimeframe,
  inventoryUsableBarsByTimeframe,
  inventoryXauUsdWeeklySegments,
  listBenchmarkStrategies,
  runWeeklyStrategyMatrixOnTimeframe,
  runWeeksPooledOnTimeframe,
  summarizeCostToMoveForTimeframe,
  summarizeObservedXauUsdSpread,
  type ResearchCandleInterval,
  type StrategyTimeframeBundle
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

async function loadCandles(source?: string): Promise<Candle[]> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "XAUUSD" } });
    if (!symbol) return [];
    const rows = await prisma.candle.findMany({
      where: {
        symbolId: symbol.id,
        interval: "1m",
        isComplete: true,
        ...(source ? { source } : { source: "HISTORY_API" })
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

describe("XAUUSD timeframe viability research", () => {
  it(
    "benchmarks CFD strategies on 1m/5m/research-15m without enabling XAUUSD",
    async () => {
      assertProductionIntervalsUnchanged();
      assertNoStrategyParameterMutation();
      expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);

      const history = await loadCandles("HISTORY_API");
      expect(history.length).toBeGreaterThan(5000);

      const inventory = inventoryXauUsdWeeklySegments(history);
      assertSegmentBoundaryIntegrity(inventory);
      const usable = inventory.filter((w) => w.usable);
      expect(usable.length).toBeGreaterThanOrEqual(10);

      const barInventory = inventoryUsableBarsByTimeframe(usable);
      const bars5m = barInventory.find((b) => b.timeframe === "5m")!.usableBars;
      const bars15m = barInventory.find((b) => b.timeframe === "15m")!.usableBars;
      expect(bars5m).toBeGreaterThan(1000);
      expect(bars15m).toBeGreaterThan(300);

      const spreadPath = resolve(
        process.cwd(),
        "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
      );
      const spread = summarizeObservedXauUsdSpread(spreadPath, {
        preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
      });
      const observedSpreadBps = spread.medianBps ?? 0.61;
      const profiles = buildXauUsdCostProfiles(observedSpreadBps);

      const strategyIds = listBenchmarkStrategies()
        .map((s) => s.strategyId)
        .filter(
          (id) =>
            id !== "xau-mtf-structure-momentum-v1" &&
            id !== "xau-volatility-expansion-retest-v1" &&
            id !== "xau-trend-pullback-v1" &&
            id !== "xau-trend-breakout-v2"
        );
      expect(strategyIds).toHaveLength(6);

      const timeframes: ResearchCandleInterval[] = ["1m", "5m", "15m"];
      const bundles: StrategyTimeframeBundle[] = [];
      const weeklyByTf: Record<string, Awaited<ReturnType<typeof runWeeklyStrategyMatrixOnTimeframe>>> =
        {};

      for (const tf of timeframes) {
        weeklyByTf[tf] = await runWeeklyStrategyMatrixOnTimeframe(
          usable,
          tf,
          strategyIds,
          profiles
        );
        for (const strategyId of strategyIds) {
          const bundle = await evaluateStrategyTimeframe({
            weeks: usable,
            timeframe: tf,
            strategyId,
            profiles,
            weeklyRows: weeklyByTf[tf]!,
            observedSpreadBps
          });
          bundles.push(bundle);
        }
      }

      // Cost-to-move: dataset ATR + trades from squeeze OBSERVED across usable weeks
      const costSummaries = [];
      for (const tf of timeframes) {
        const allTfCandles = usable.flatMap((w) => candlesForResearchTimeframe(w.candles, tf));
        const pooled = await runWeeksPooledOnTimeframe(
          usable,
          tf,
          "squeeze-breakout-v1",
          observedSpreadBps,
          0
        );
        costSummaries.push(
          summarizeCostToMoveForTimeframe({
            timeframe: tf,
            candles: allTfCandles,
            trades: pooled.trades,
            observedSpreadBps
          })
        );
      }

      const comparison = buildCrossTimeframeTable(bundles, costSummaries);
      const chrono = chronologicalWeekSplit(usable, 0.3);

      const artifact = {
        generatedAt: new Date().toISOString(),
        researchOnly15mImplemented: true,
        productionIntervalsUnchanged: [...CANDLE_INTERVALS],
        usableWeeks: usable.length,
        excludedWeeks: inventory.filter((w) => !w.usable).map((w) => ({
          segmentId: w.segmentId,
          reason: w.reason
        })),
        barInventory,
        spread,
        costToMove: costSummaries,
        strategiesTested: strategyIds,
        chronologicalSplit: {
          developmentWeeks: chrono.developmentWeeks.map((w) => w.segmentId),
          holdoutWeeks: chrono.holdoutWeeks.map((w) => w.segmentId)
        },
        perStrategyTimeframe: bundles.map((b) => ({
          strategyId: b.strategyId,
          timeframe: b.timeframe,
          classification: b.classification,
          classificationReasons: b.classificationReasons,
          pooledObserved: b.pooled.OBSERVED_SPREAD_ONLY,
          pooledZero: b.pooled.ZERO,
          holdout: b.holdout,
          development: b.development,
          wfPositivePct: b.wfPositivePct,
          buySell: b.buySell,
          sessions: b.sessions,
          costSensitivity: b.costSensitivity,
          weeklyObserved: b.weeklyObserved.map((w) => ({
            segmentId: w.segmentId,
            trades: w.metrics.trades,
            expectancyR: w.metrics.expectancyR,
            profitFactor: w.metrics.profitFactor,
            netR: w.metrics.netR
          }))
        })),
        crossTimeframeComparison: comparison,
        safety: {
          nothingDeployed: true,
          xauusdNotEnabled: true,
          noXauusdTrades: true,
          strategyParametersUnchanged: true,
          r10Unchanged: true,
          r10EmaRemainsSuspended: true,
          riskLifecycleUnchanged: true,
          realMoneyDisabled: true
        }
      };

      const outDir = resolve(process.cwd(), "../../research-datasets");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "XAUUSD_timeframe_viability.json");
      writeFileSync(outPath, JSON.stringify(artifact, null, 2));

      // Structural assertions
      expect(comparison.length).toBe(strategyIds.length * timeframes.length);
      expect(bundles.every((b) => b.classification.length > 0)).toBe(true);

      // Segment resets: separate weeks must not share candle identity
      const w0 = candlesForResearchTimeframe(usable[0]!.candles, "5m");
      const w1 = candlesForResearchTimeframe(usable[1]!.candles, "5m");
      expect(w0[0]?.openTime).not.toBe(w1[0]?.openTime);

      console.log(
        JSON.stringify(
          {
            usableWeeks: usable.length,
            bars5m,
            bars15m,
            spreadStatus: spread.status,
            promising: comparison.filter((c) => c.classification === "PROMISING_FOR_DEEPER_RESEARCH")
              .length,
            noEdge: comparison.filter((c) => c.classification === "NO_EDGE").length,
            artifact: outPath
          },
          null,
          2
        )
      );
    },
    1_800_000
  );
});
