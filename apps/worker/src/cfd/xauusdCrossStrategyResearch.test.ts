/**
 * XAUUSD cross-strategy research (Deriv frxXAUUSD history, MATCH_APPROXIMATE vs MT5 live).
 * Does NOT enable trading / allowlists / R_10 changes.
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauusdCrossStrategyResearch.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  CFD_CAPABLE_STRATEGY_IDS,
  XAUUSD_CROSS_STRATEGY_BENCHMARK_CONFIG,
  aggregateContiguousCompletedCandles,
  auditXauUsdSessionAwareGaps,
  detectContinuousSegments,
  evaluateXauUsdHistoryLiveParity,
  runCrossStrategyBenchmark,
  summarizeObservedXauUsdSpread,
  type CrossStrategyBenchmarkReport
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

const ASSUMED_SLIP_BPS = [0, 0.1, 0.25, 0.5, 1.0] as const;

async function loadXauUsdHistory(): Promise<Candle[]> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "XAUUSD" } });
    if (!symbol) return [];
    const rows = await prisma.candle.findMany({
      where: { symbolId: symbol.id, interval: "1m", source: "HISTORY_API", isComplete: true },
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

function sampleFlag(trades: number): "VERY_LOW_SAMPLE" | "LOW_SAMPLE" | "INFORMATIVE" {
  if (trades < 20) return "VERY_LOW_SAMPLE";
  if (trades < 50) return "LOW_SAMPLE";
  return "INFORMATIVE";
}

function classifyRow(s: CrossStrategyBenchmarkReport["strategies"][number]): string {
  if (s.verdict === "TOO_SPARSE" || s.realistic.holdout.trades < 20) return "TOO_SPARSE";
  if (s.verdict === "PROMISING_FOR_MORE_RESEARCH") return "PROMISING";
  if (s.costEdgeCase === "RAW_EDGE_KILLED_BY_COSTS" || s.verdict === "RAW_EDGE_BUT_COST_SENSITIVE") {
    return "RAW_EDGE_COST_SENSITIVE";
  }
  if (s.zeroCost.holdout.expectancyR <= 0) return "NO_RAW_EDGE";
  return s.verdict;
}

function compact(report: CrossStrategyBenchmarkReport) {
  return {
    config: {
      symbol: report.config.symbol,
      interval: report.config.interval,
      spreadBps: report.config.spreadBps,
      slippageBps: report.config.slippageBps,
      contractSize: report.config.contractSize,
      tickSize: report.config.tickSize,
      tickValue: report.config.tickValue
    },
    developmentCount: report.developmentCount,
    holdoutCount: report.holdoutCount,
    walkForwardWindowCount: report.walkForwardWindowCount,
    strategies: report.strategies.map((s) => ({
      strategyId: s.strategyId,
      family: s.family,
      classification: classifyRow(s),
      verdict: s.verdict,
      costEdgeCase: s.costEdgeCase,
      zeroHoldout: {
        trades: s.zeroCost.holdout.trades,
        expectancyR: s.zeroCost.holdout.expectancyR,
        profitFactor: s.zeroCost.holdout.profitFactor,
        netR: s.zeroCost.holdout.netR,
        sample: sampleFlag(s.zeroCost.holdout.trades)
      },
      observedSpreadHoldout: {
        trades: s.realistic.holdout.trades,
        expectancyR: s.realistic.holdout.expectancyR,
        profitFactor: s.realistic.holdout.profitFactor,
        netR: s.realistic.holdout.netR,
        sample: sampleFlag(s.realistic.holdout.trades)
      },
      zeroDev: {
        trades: s.zeroCost.development.trades,
        expectancyR: s.zeroCost.development.expectancyR
      },
      wf: s.realistic.walkForwardStability,
      costDragHoldoutExpectancyR: s.costDrag.holdoutExpectancyR
    })),
    rankings: report.rankings,
    notes: report.notes
  };
}

describe("XAUUSD cross-strategy research (no enablement)", () => {
  it("benchmarks all CFD strategies on gap-safe 1m and contiguous 5m", async () => {
    const all = await loadXauUsdHistory();
    if (all.length < 5000) {
      expect(all.length).toBeGreaterThanOrEqual(5000);
      return;
    }

    const sessionAware = auditXauUsdSessionAwareGaps(all);
    const parity = evaluateXauUsdHistoryLiveParity({
      historicalLastClose: all.at(-1)?.close ?? null,
      liveMid: 4426
    });
    expect(parity.verdict).not.toBe("MATERIAL_MISMATCH");

    // Cover expected daily ~60m maintenance inside a week; still split weekends (~55h).
    const segments = detectContinuousSegments(all, 3 * 60 * 60_000);
    const largest = [...segments.segments].sort((a, b) => b.candleCount - a.candleCount)[0]!;
    const segment1m = all.slice(largest.startIndex, largest.endIndexExclusive);
    expect(segment1m.length).toBeGreaterThan(2000);

    const spreadPath = resolve(process.cwd(), "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl");
    const spread = summarizeObservedXauUsdSpread(spreadPath, {
      preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
    });
    const observedSpreadBps = spread.medianBps ?? 0.61;

    const baseCfg = {
      ...XAUUSD_CROSS_STRATEGY_BENCHMARK_CONFIG,
      spreadBps: observedSpreadBps,
      slippageBps: 0,
      strategyIds: [...CFD_CAPABLE_STRATEGY_IDS]
    };

    const oneMinZero = await runCrossStrategyBenchmark(segment1m, {
      ...baseCfg,
      interval: "1m",
      spreadBps: 0,
      slippageBps: 0
    });
    const oneMinObserved = await runCrossStrategyBenchmark(segment1m, {
      ...baseCfg,
      interval: "1m",
      spreadBps: observedSpreadBps,
      slippageBps: 0
    });

    const slipSweep = [];
    for (const slip of ASSUMED_SLIP_BPS) {
      const report = await runCrossStrategyBenchmark(segment1m, {
        ...baseCfg,
        interval: "1m",
        spreadBps: observedSpreadBps,
        slippageBps: slip
      });
      slipSweep.push({
        label: "ASSUMED",
        spreadBps: observedSpreadBps,
        slippageBps: slip,
        costLabel:
          slip === 0
            ? "OBSERVED_SPREAD_ONLY_NOT_FULL_EMPIRICAL_COST"
            : "ASSUMED_SLIPPAGE_SENSITIVITY",
        strategies: report.strategies.map((s) => ({
          strategyId: s.strategyId,
          holdoutExpectancyR: s.realistic.holdout.expectancyR,
          holdoutTrades: s.realistic.holdout.trades,
          holdoutPf: s.realistic.holdout.profitFactor
        }))
      });
    }

    const contiguous5m = aggregateContiguousCompletedCandles(segment1m, "5m");
    const fiveMinCandles = contiguous5m.validBars;
    expect(fiveMinCandles.length).toBeGreaterThan(100);

    const fiveMinZero = await runCrossStrategyBenchmark(fiveMinCandles, {
      ...baseCfg,
      interval: "5m",
      spreadBps: 0,
      slippageBps: 0,
      maxHoldBars: 24,
      walkForward: { trainWindow: 400, testWindow: 80, stepSize: 80, windowMode: "rolling" }
    });
    const fiveMinObserved = await runCrossStrategyBenchmark(fiveMinCandles, {
      ...baseCfg,
      interval: "5m",
      spreadBps: observedSpreadBps,
      slippageBps: 0,
      maxHoldBars: 24,
      walkForward: { trainWindow: 400, testWindow: 80, stepSize: 80, windowMode: "rolling" }
    });

    const outDir = resolve(process.cwd(), "../../research-datasets");
    mkdirSync(outDir, { recursive: true });
    const artifact = {
      datasetManifestRef: "research-datasets/XAUUSD_1m_manifest.json",
      historicalSource: "DERIV_HISTORY_API:frxXAUUSD",
      liveSource: "MT5_DEMO:XAUUSD",
      parity,
      sessionAware,
      spread,
      researchSegment: {
        startIso: new Date(segment1m[0]!.openTime).toISOString(),
        endIso: new Date(segment1m.at(-1)!.openTime).toISOString(),
        candleCount: segment1m.length,
        contiguous5mValid: contiguous5m.validCount,
        contiguous5mExcluded: contiguous5m.excludedCount
      },
      enablement: {
        allowlist: false,
        trades: false,
        deployed: false,
        r10Unchanged: true
      },
      oneMinute: {
        zeroCost: compact(oneMinZero),
        observedSpreadOnly: compact(oneMinObserved),
        assumedSlippageSensitivity: slipSweep
      },
      fiveMinute: {
        zeroCost: compact(fiveMinZero),
        observedSpreadOnly: compact(fiveMinObserved)
      }
    };
    writeFileSync(
      resolve(outDir, "XAUUSD_cross_strategy_research.json"),
      `${JSON.stringify(artifact, null, 2)}\n`
    );

    expect(oneMinObserved.strategies).toHaveLength(CFD_CAPABLE_STRATEGY_IDS.length);
    expect(oneMinObserved.notes.deployed).toBe(false);
    expect(oneMinObserved.notes.strategiesEnabled).toBe(false);
    // No automatic PROMISING promotion gate — research only.
    console.log(
      JSON.stringify(
        {
          segmentBars: segment1m.length,
          spreadStatus: spread.status,
          observedSpreadBps,
          rankings1m: oneMinObserved.rankings.overallResearch,
          classifications1m: oneMinObserved.strategies.map((s) => ({
            id: s.strategyId,
            c: classifyRow(s),
            holdExp: s.realistic.holdout.expectancyR,
            trades: s.realistic.holdout.trades
          }))
        },
        null,
        2
      )
    );
  }, 600_000);
});
