/**
 * Cross-strategy cost-aware R_10 benchmark (research only).
 * Run: pnpm --filter @regimex/worker exec vitest run src/cfd/crossStrategyBenchmarkResearch.test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  aggregateCompletedCandles,
  runCrossStrategyBenchmark,
  CFD_CAPABLE_STRATEGY_IDS,
  type CrossStrategyBenchmarkReport
} from "@regimex/trading-engine";

function loadDatabaseUrlFromEnvFile(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const candidates = [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ];
  for (const path of candidates) {
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

async function loadR10Candles(limit = 7000): Promise<Candle[]> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!symbol) return [];
    const rows = await prisma.candle.findMany({
      where: { symbolId: symbol.id, interval: "1m" },
      orderBy: { openTime: "asc" },
      take: limit
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
      isComplete: true,
      source: "LIVE_TICKS" as const
    }));
  } finally {
    await prisma.$disconnect();
  }
}

function compact(report: CrossStrategyBenchmarkReport) {
  return {
    dataset: {
      candleCount: report.dataQuality.candleCount,
      firstIso: report.dataQuality.firstIso,
      lastIso: report.dataQuality.lastIso,
      source: report.dataQuality.source,
      interval: report.dataQuality.interval,
      treatedAs247: report.dataQuality.treatedAs247,
      missingBarRate: report.dataQuality.missingBarRate,
      gapCount: report.dataQuality.gapCount,
      duplicateCount: report.dataQuality.duplicateCount,
      nonMonotonicCount: report.dataQuality.nonMonotonicCount,
      invalidOhlcCount: report.dataQuality.invalidOhlcCount,
      zeroRangeCount: report.dataQuality.zeroRangeCount,
      largeGapCount: report.dataQuality.largeGapCount,
      developmentCount: report.developmentCount,
      holdoutCount: report.holdoutCount
    },
    costs: {
      realistic: {
        spreadBps: report.config.spreadBps,
        slippageBps: report.config.slippageBps
      },
      zero: { spreadBps: 0, slippageBps: 0 },
      fillSemantics: report.notes.fillSemantics
    },
    strategyIds: report.strategies.map((s) => s.strategyId),
    families: report.familySummary,
    developmentRealistic: Object.fromEntries(
      report.strategies.map((s) => [
        s.strategyId,
        {
          family: s.family,
          trades: s.realistic.development.trades,
          wr: s.realistic.development.winRate,
          pf: s.realistic.development.profitFactor,
          expR: s.realistic.development.expectancyR,
          netR: s.realistic.development.netR,
          maxDD: s.realistic.development.maxDrawdown,
          buyExp: s.realistic.development.buyExpectancyR,
          sellExp: s.realistic.development.sellExpectancyR,
          byRegime: s.realistic.development.byRegime
        }
      ])
    ),
    holdoutRealistic: Object.fromEntries(
      report.strategies.map((s) => [
        s.strategyId,
        {
          family: s.family,
          trades: s.realistic.holdout.trades,
          sample: s.realistic.holdout.sampleSize,
          wr: s.realistic.holdout.winRate,
          pf: s.realistic.holdout.profitFactor,
          expR: s.realistic.holdout.expectancyR,
          avgWinR: s.realistic.holdout.averageWinR,
          avgLossR: s.realistic.holdout.averageLossR,
          netR: s.realistic.holdout.netR,
          maxDD: s.realistic.holdout.maxDrawdown,
          lossStreak: s.realistic.holdout.longestLossStreak,
          buyExp: s.realistic.holdout.buyExpectancyR,
          sellExp: s.realistic.holdout.sellExpectancyR,
          byRegime: s.realistic.holdout.byRegime
        }
      ])
    ),
    holdoutZeroCost: Object.fromEntries(
      report.strategies.map((s) => [
        s.strategyId,
        {
          trades: s.zeroCost.holdout.trades,
          wr: s.zeroCost.holdout.winRate,
          pf: s.zeroCost.holdout.profitFactor,
          expR: s.zeroCost.holdout.expectancyR,
          netR: s.zeroCost.holdout.netR
        }
      ])
    ),
    costDrag: Object.fromEntries(
      report.strategies.map((s) => [
        s.strategyId,
        {
          holdoutExpR: s.costDrag.holdoutExpectancyR,
          holdoutNetR: s.costDrag.holdoutNetR,
          developmentExpR: s.costDrag.developmentExpectancyR,
          case: s.costEdgeCase,
          verdict: s.verdict
        }
      ])
    ),
    walkForwardRealistic: Object.fromEntries(
      report.strategies.map((s) => [
        s.strategyId,
        {
          stability: s.realistic.walkForwardStability,
          windows: s.realistic.walkForwardWindows
        }
      ])
    ),
    rankings: report.rankings,
    notes: report.notes
  };
}

describe("cross-strategy R_10 benchmark (research only)", () => {
  it("runs all CFD-capable strategies with cost-aware + zero-cost + optional 5m diagnostic", async () => {
    const candles = await loadR10Candles(7000);
    if (candles.length < 2500) {
      console.warn(`Skipping: only ${candles.length} candles`);
      expect(candles.length).toBeGreaterThanOrEqual(0);
      return;
    }

    const report = await runCrossStrategyBenchmark(candles, {
      symbol: "R_10",
      interval: "1m",
      holdoutPercent: 0.3,
      spreadBps: 8,
      slippageBps: 3
    });

    expect(report.strategies.map((s) => s.strategyId).sort()).toEqual(
      [...CFD_CAPABLE_STRATEGY_IDS].sort()
    );
    expect(report.holdoutUsedForParameterSelection).toBe(false);
    expect(report.notes.deployed).toBe(false);

    const m5 = aggregateCompletedCandles(candles, "5m");
    let htf: unknown = { deferred: false, m5CandleCount: m5.length, note: null as string | null };
    if (m5.length >= 800) {
      const htfReport = await runCrossStrategyBenchmark(m5, {
        symbol: "R_10",
        interval: "5m",
        holdoutPercent: 0.3,
        spreadBps: 8,
        slippageBps: 3,
        // Focus on families most relevant to cost-vs-move hypothesis.
        strategyIds: [
          "ema-pullback-v1",
          "bollinger-reversion-v1",
          "breakout-momentum-v1",
          "squeeze-breakout-v1"
        ],
        walkForward: {
          trainWindow: 400,
          testWindow: 100,
          stepSize: 100,
          windowMode: "rolling"
        },
        maxHoldBars: 24
      });
      htf = {
        deferred: false,
        m5CandleCount: m5.length,
        note: "Research aggregation from completed 1m bars; live tick aggregation may differ with gaps.",
        holdoutRealistic: Object.fromEntries(
          htfReport.strategies.map((s) => [
            s.strategyId,
            {
              trades: s.realistic.holdout.trades,
              expR: s.realistic.holdout.expectancyR,
              pf: s.realistic.holdout.profitFactor,
              zeroExpR: s.zeroCost.holdout.expectancyR,
              case: s.costEdgeCase,
              verdict: s.verdict
            }
          ])
        )
      };
    } else {
      htf = {
        deferred: true,
        m5CandleCount: m5.length,
        note: "Insufficient aggregated 5m bars for diagnostic"
      };
    }

    const out = { ...compact(report), higherTimeframeDiagnostic: htf };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
  }, 600_000);
});
