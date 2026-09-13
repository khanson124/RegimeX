/**
 * XAU Trend Pullback v1 sparsity diagnostic (development only; no holdout tuning / no enablement).
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauTrendPullbackSparsityDiagnostic.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertProductionIntervalsUnchanged,
  chronologicalWeekSplit,
  inventoryXauUsdWeeklySegments,
  runXauTrendPullbackSparsityDiagnostic,
  splitHoldoutByTimestamp,
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

describe("xau-trend-pullback-v1 sparsity diagnostic", () => {
  it(
    "builds development-only funnel + ablations without using consumed holdout",
    async () => {
      assertProductionIntervalsUnchanged();
      expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
      expect(SQUEEZE_BREAKOUT_DEFAULTS).toBeTruthy();
      // Production defaults unchanged (continuationMode remains either)
      expect(XAU_TREND_PULLBACK_DEFAULTS.continuationMode).toBe("either");
      expect(XAU_TREND_PULLBACK_DEFAULTS.adxMinimum).toBe(20);
      expect(XAU_TREND_PULLBACK_DEFAULTS.atrPercentileMin).toBe(0.2);
      expect(XAU_TREND_PULLBACK_DEFAULTS.atrPercentileMax).toBe(0.85);

      const history = await loadCandles();
      expect(history.length).toBeGreaterThan(10_000);

      const inventory = inventoryXauUsdWeeklySegments(history);
      const usable = inventory.filter((w) => w.usable);
      const chrono = chronologicalWeekSplit(usable, 0.3);
      expect(chrono.holdoutStartOpenTime).not.toBeNull();
      const holdoutStart = chrono.holdoutStartOpenTime!;
      const split = splitHoldoutByTimestamp(history, holdoutStart);
      expect(split.development.every((c) => c.openTime < holdoutStart)).toBe(true);

      const spreadPath = resolve(
        process.cwd(),
        "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
      );
      const spread = summarizeObservedXauUsdSpread(spreadPath, {
        preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
      });
      const observedSpreadBps = spread.medianBps ?? 0.61;

      const priorHoldoutEnd =
        split.holdout.length > 0
          ? split.holdout[split.holdout.length - 1]!.openTime
          : holdoutStart;
      const datasetEnd = history[history.length - 1]!.openTime;

      const report = await runXauTrendPullbackSparsityDiagnostic({
        developmentCandles: split.development,
        observedSpreadBps,
        spreadStatus: spread.status,
        priorHoldoutStartOpenTime: holdoutStart,
        priorHoldoutEndOpenTime: priorHoldoutEnd,
        datasetEndOpenTime: datasetEnd
      });

      expect(report.diagnosticOnly).toBe(true);
      expect(report.productionDefaultsUnchanged).toBe(true);
      expect((report.priorHoldout as { status: string }).status).toContain("CONSUMED");
      expect(
        (report.proposedNewUntouchedHoldout as { doNotEvaluateInThisRun: boolean })
          .doNotEvaluateInThisRun
      ).toBe(true);

      const funnel = report.baselineFunnel as {
        stages: Array<{ stage: string; count: number }>;
        primaryBottlenecks: unknown[];
      };
      expect(funnel.stages.length).toBeGreaterThan(5);
      expect(funnel.stages[0]!.stage).toBe("m15_bars");

      const outDir = resolve(process.cwd(), "../../research-datasets");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "XAUUSD_xau_trend_pullback_v1_sparsity_diagnostic.json");
      writeFileSync(outPath, JSON.stringify(report, null, 2));

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            artifact: outPath,
            primaryBottlenecks: report.primaryBottlenecks,
            recommendation: report.recommendation,
            baselineTrades: (report.ablationTable as Array<{ variantId: string; developmentTrades: number }>).find(
              (r) => r.variantId === "baseline"
            )?.developmentTrades,
            proposedNewHoldout: report.proposedNewUntouchedHoldout
          },
          null,
          2
        )
      );
    },
    2_400_000
  );
});
