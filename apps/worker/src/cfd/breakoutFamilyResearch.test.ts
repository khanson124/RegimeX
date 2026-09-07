/**
 * Breakout-family 1m vs contiguous-5m research (no strategy mutation).
 * Run: pnpm --filter @regimex/worker exec vitest run src/cfd/breakoutFamilyResearch.test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  auditOneMinuteDataset,
  aggregateContiguousCompletedCandles,
  aggregateCompletedCandles,
  runBreakoutFamilyResearch
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

async function loadAllR10OneMinute(): Promise<{
  candles: Candle[];
  totalInDb: number;
  historyApiCount: number;
}> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!symbol) return { candles: [], totalInDb: 0, historyApiCount: 0 };
    const totalInDb = await prisma.candle.count({
      where: { symbolId: symbol.id, interval: "1m" }
    });
    // Prefer Deriv HISTORY_API for research continuity (exclude SEED mocks / mixed live).
    const historyApiCount = await prisma.candle.count({
      where: { symbolId: symbol.id, interval: "1m", source: "HISTORY_API" }
    });
    const sourceFilter =
      historyApiCount >= 1000
        ? ({ source: "HISTORY_API" as const } as const)
        : ({} as const);
    const rows = await prisma.candle.findMany({
      where: { symbolId: symbol.id, interval: "1m", ...sourceFilter },
      orderBy: { openTime: "asc" }
    });
    const candles = rows.map((r) => ({
      symbol: "R_10" as const,
      interval: "1m" as const,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount,
      isComplete: true as const,
      source: r.source as Candle["source"]
    }));
    return { candles, totalInDb, historyApiCount };
  } finally {
    await prisma.$disconnect();
  }
}

describe("breakout family 1m vs contiguous 5m research", () => {
  it("audits dataset, aggregates gap-aware 5m, evaluates breakout strategies", async () => {
    const { candles, totalInDb, historyApiCount } = await loadAllR10OneMinute();
    if (candles.length < 1000) {
      console.warn(`Skipping: only ${candles.length} R_10 1m candles`);
      expect(candles.length).toBeGreaterThanOrEqual(0);
      return;
    }

    const audit = auditOneMinuteDataset(candles);
    const legacy5m = aggregateCompletedCandles(candles, "5m");
    const contiguous = aggregateContiguousCompletedCandles(candles, "5m");
    const excludeReasons: Record<string, number> = {};
    for (const e of contiguous.excluded) {
      excludeReasons[e.reason] = (excludeReasons[e.reason] ?? 0) + 1;
    }

    // How many legacy 5m bars cross major gaps? (bucket present in legacy but excluded as incomplete)
    const legacyOpens = new Set(legacy5m.map((c) => c.openTime));
    const excludedOpens = new Set(contiguous.excluded.map((e) => e.bucketOpenTime));
    let legacyBarsThatWouldBridgeGaps = 0;
    for (const o of legacyOpens) {
      if (excludedOpens.has(o)) legacyBarsThatWouldBridgeGaps++;
    }

    const research = await runBreakoutFamilyResearch({
      candles1m: candles,
      candles5mContiguous: contiguous.validBars
    });

    const report = {
      dataAvailability: {
        totalInDb,
        historyApiCount,
        loaded: candles.length,
        loadSourcePreference: historyApiCount >= 1000 ? "HISTORY_API" : "ALL",
        moreThanPrevious7000Sample: candles.length > 7000,
        note:
          historyApiCount >= 1000
            ? "Loaded HISTORY_API R_10 1m only (research provenance)"
            : "HISTORY_API sparse; loaded all sources"
      },
      audit: {
        ...audit,
        // Keep gap list compact in console: longest only
        gaps: undefined,
        longestGaps: audit.longestGaps.slice(0, 10),
        suspiciousPriceJumpsNearGaps: audit.suspiciousPriceJumpsNearGaps.slice(0, 10)
      },
      resampling: {
        legacyRaw5mBars: legacy5m.length,
        contiguousValid5mBars: contiguous.validCount,
        excluded5mBars: contiguous.excludedCount,
        excludeReasons,
        legacyBarsThatWouldBridgeGaps,
        expectedSourceBarsPerBucket: contiguous.expectedSourceBarsPerBucket
      },
      research: {
        holdoutStartOpenTime: research.holdoutStartOpenTime,
        holdoutStartIso: new Date(research.holdoutStartOpenTime).toISOString(),
        holdoutUsedForParameterSelection: research.holdoutUsedForParameterSelection,
        runs: research.runs.map((r) => ({
          strategyId: r.strategyId,
          timeframe: r.timeframe,
          candleCount: r.candleCount,
          developmentCount: r.developmentCount,
          holdoutCount: r.holdoutCount,
          classification: r.classification,
          realistic: {
            development: r.realistic.development,
            holdout: r.realistic.holdout,
            walkForward: r.realistic.walkForward,
            costToMoveDevelopment: r.realistic.costToMoveDevelopment,
            costToMoveHoldout: r.realistic.costToMoveHoldout
          },
          zeroCost: r.zeroCost,
          costSweep: r.costSweep,
          breakEven: r.breakEven,
          winLossMedians: {
            wins: r.winLossDiagnostics.winMedians,
            losses: r.winLossDiagnostics.lossMedians,
            winN: r.winLossDiagnostics.wins.length,
            lossN: r.winLossDiagnostics.losses.length
          }
        })),
        notes: research.notes
      }
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));

    expect(research.notes.deployed).toBe(false);
    expect(research.notes.emaPullbackRemainsSuspended).toBe(true);
    expect(research.holdoutUsedForParameterSelection).toBe(false);
  }, 600_000);
});
