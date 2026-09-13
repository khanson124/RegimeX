/**
 * XAU Trend Breakout v2 research (development only; no holdout selection / no enablement).
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauTrendBreakoutV2Research.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertProductionIntervalsUnchanged,
  chronologicalWeekSplit,
  FUTURE_UNTOUCHED_HOLDOUT_START_MS,
  inventoryXauUsdWeeklySegments,
  runXauTrendBreakoutV2Research,
  splitHoldoutByTimestamp,
  summarizeObservedXauUsdSpread,
  SQUEEZE_BREAKOUT_DEFAULTS,
  XAU_TREND_BREAKOUT_V2_DEFAULTS,
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

describe("xau-trend-breakout-v2 research", () => {
  it(
    "runs development architectures without evaluating consumed/future holdouts",
    async () => {
      assertProductionIntervalsUnchanged();
      expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
      expect(SQUEEZE_BREAKOUT_DEFAULTS).toBeTruthy();
      expect(XAU_TREND_PULLBACK_DEFAULTS.adxMinimum).toBe(20);
      expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.adxMinimum).toBe(0);
      expect(XAU_TREND_BREAKOUT_V2_DEFAULTS.entryMode).toBe("immediate");

      const history = await loadCandles();
      expect(history.length).toBeGreaterThan(10_000);

      const inventory = inventoryXauUsdWeeklySegments(history);
      const usable = inventory.filter((w) => w.usable);
      const chrono = chronologicalWeekSplit(usable, 0.3);
      expect(chrono.holdoutStartOpenTime).not.toBeNull();
      const priorHoldoutStart = chrono.holdoutStartOpenTime!;
      const split = splitHoldoutByTimestamp(history, priorHoldoutStart);
      // Development only — exclude prior consumed holdout AND anything at/after future boundary
      const development = split.development.filter(
        (c) => c.openTime < FUTURE_UNTOUCHED_HOLDOUT_START_MS
      );
      expect(development.every((c) => c.openTime < priorHoldoutStart)).toBe(true);
      expect(development.every((c) => c.openTime < FUTURE_UNTOUCHED_HOLDOUT_START_MS)).toBe(true);

      const spreadPath = resolve(
        process.cwd(),
        "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
      );
      const spread = summarizeObservedXauUsdSpread(spreadPath, {
        preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
      });

      const report = await runXauTrendBreakoutV2Research({
        developmentCandles: development,
        developmentWeeks: chrono.developmentWeeks,
        observedSpreadBps: spread.medianBps ?? 0.61,
        spreadStatus: spread.status,
        datasetEndOpenTime: history[history.length - 1]!.openTime
      });

      expect(report.strategyId).toBe("xau-trend-breakout-v2");
      expect(report.safety).toMatchObject({
        nothingDeployed: true,
        xauTrendPullbackV1Untouched: true,
        futureHoldoutNotEvaluated: true
      });
      expect((report.futureUntouchedHoldout as { evaluated: boolean }).evaluated).toBe(false);

      const outDir = resolve(process.cwd(), "../../research-datasets");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "XAUUSD_xau_trend_breakout_v2_research.json");
      writeFileSync(outPath, JSON.stringify(report, null, 2));

      const arch = report.architectureComparison as {
        A_immediateBreakout: { observedSpread: { trades: number; expectancyR: number } };
        B_breakoutRetest: { observedSpread: { trades: number } };
        C_xauTrendPullbackV1Reference: { observedSpread: { trades: number } };
      };
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            artifact: outPath,
            sampleClassification: report.sampleClassification,
            meritsContinuedResearch: report.meritsContinuedResearch,
            reasons: report.classificationReasons,
            immediateTrades: arch.A_immediateBreakout.observedSpread.trades,
            immediateExpR: arch.A_immediateBreakout.observedSpread.expectancyR,
            retestTrades: arch.B_breakoutRetest.observedSpread.trades,
            v1RefTrades: arch.C_xauTrendPullbackV1Reference.observedSpread.trades,
            futureHoldout: report.futureUntouchedHoldout,
            funnelFinal: (report.funnelImmediate as { stages: Array<{ stage: string; count: number }> })
              .stages
          },
          null,
          2
        )
      );
    },
    2_400_000
  );
});
