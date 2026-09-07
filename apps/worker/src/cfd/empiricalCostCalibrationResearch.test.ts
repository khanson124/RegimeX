/**
 * Empirical MT5 cost calibration + breakout cost-profile comparison (research only).
 * Run: pnpm --filter @regimex/worker exec vitest run src/cfd/empiricalCostCalibrationResearch.test.ts
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  aggregateContiguousCompletedCandles,
  extractMt5CostSamplesFromPositions,
  buildEmpiricalCostCalibrationReport,
  runBreakoutFamilyCostProfileComparison,
  splitHoldout,
  type Mt5PersistedCostRaw
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

async function loadHistoryApiR10(): Promise<Candle[]> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!symbol) return [];
    const rows = await prisma.candle.findMany({
      where: { symbolId: symbol.id, interval: "1m", source: "HISTORY_API", isComplete: true },
      orderBy: { openTime: "asc" }
    });
    return rows.map((r) => ({
      symbol: "R_10",
      interval: "1m" as const,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true as const,
      source: "HISTORY_API" as const
    }));
  } finally {
    await prisma.$disconnect();
  }
}

describe("empirical MT5 cost calibration research", () => {
  it("measures available telemetry and compares breakout holdout under available profiles", async () => {
    const prisma = new PrismaClient();
    let raw: Mt5PersistedCostRaw[] = [];
    try {
      const rows = await prisma.position.findMany({
        where: {
          OR: [
            { symbol: "R_10" },
            { metadata: { path: ["venue"], equals: "MT5_DEMO" } },
            { metadata: { path: ["executionModel"], equals: "broker_demo_mt5" } }
          ]
        }
      });
      raw = rows.map((r) => ({
        positionId: r.id,
        symbol: r.symbol,
        direction: r.direction as "BUY" | "SELL",
        status: r.status,
        entryPrice: r.entryPrice != null ? Number(r.entryPrice) : null,
        closePrice: r.closePrice != null ? Number(r.closePrice) : null,
        openedAtMs: r.openedAt?.getTime() ?? null,
        closedAtMs: r.closedAt?.getTime() ?? null,
        metadata: (r.metadata ?? null) as Record<string, unknown> | null
      }));
    } finally {
      await prisma.$disconnect();
    }

    const bundle = extractMt5CostSamplesFromPositions(raw, { tickSize: 0.001 });
    const calibration = buildEmpiricalCostCalibrationReport({ symbol: "R_10", bundle });

    const candles1m = await loadHistoryApiR10();
    expect(candles1m.length).toBeGreaterThan(1000);
    const contiguous = aggregateContiguousCompletedCandles(candles1m, "5m");
    const holdoutStartOpenTime = splitHoldout(candles1m, 0.3).holdout[0]!.openTime;

    const profiles = calibration.profiles
      .filter((p) => p.label === "ZERO" || p.label === "LEGACY_8_3" || p.dataSufficient)
      .map((p) => ({
        label: p.label,
        spreadBps: p.spreadBps,
        slippageBps: p.slippageBps
      }));

    // Always include ZERO + LEGACY for comparison even if empirical withheld
    const labels = new Set(profiles.map((p) => p.label));
    if (!labels.has("ZERO")) profiles.unshift({ label: "ZERO", spreadBps: 0, slippageBps: 0 });
    if (!labels.has("LEGACY_8_3")) {
      profiles.push({ label: "LEGACY_8_3", spreadBps: 8, slippageBps: 3 });
    }

    const comparison = await runBreakoutFamilyCostProfileComparison({
      candles1m,
      candles5mContiguous: contiguous.validBars,
      holdoutStartOpenTime,
      profiles
    });

    const decision = (() => {
      if (
        calibration.sufficiency.spread === "NONE" &&
        (calibration.sufficiency.entrySlippage === "NONE" ||
          calibration.sufficiency.entrySlippage === "INCONCLUSIVE")
      ) {
        return "COST_CALIBRATION_BLOCKED_INSUFFICIENT_MT5_TELEMETRY";
      }
      const medianRows = comparison.rows.filter((r) => r.profileLabel === "MEDIAN");
      if (medianRows.length === 0) {
        return "COST_CALIBRATION_BLOCKED_INSUFFICIENT_MT5_TELEMETRY";
      }
      const survivesMedianNotConservative = medianRows.some((r) => {
        if (!(r.expectancyR > 0)) return false;
        const cons = comparison.rows.find(
          (x) =>
            x.strategyId === r.strategyId &&
            x.timeframe === r.timeframe &&
            x.profileLabel === "CONSERVATIVE"
        );
        return cons != null && cons.expectancyR <= 0;
      });
      if (survivesMedianNotConservative) return "EDGE_SURVIVES_MEDIAN_NOT_CONSERVATIVE";
      if (medianRows.every((r) => r.expectancyR > 0)) return "EDGE_SURVIVES_EMPIRICAL_COSTS";
      return "EMPIRICAL_COSTS_STILL_KILL_EDGE";
    })();

    const report = {
      calibration,
      holdoutStartIso: new Date(holdoutStartOpenTime).toISOString(),
      profilesUsed: profiles,
      comparison,
      decision,
      confirmations: {
        deployed: false,
        strategyEnabled: false,
        emaPullbackRemainsSuspended: true,
        mt5ExecutionUnchanged: true,
        riskLifecycleAllowlistsUnchanged: true,
        historicalResearchResultsNotAltered: true
      }
    };

    const outDir = resolve(process.cwd(), "../../research-datasets");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, "R_10_mt5_empirical_cost_breakout_comparison.json");
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));

    expect(comparison.notes.holdoutRedefined).toBe(false);
    expect(comparison.notes.emaPullbackRemainsSuspended).toBe(true);
    expect(calibration.exitSlippage.sampleCount).toBe(0);
  }, 600_000);
});
