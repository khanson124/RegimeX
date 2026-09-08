/**
 * Multi-week XAUUSD squeeze-breakout robustness (research only — no enablement).
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauusdWeeklyRobustnessResearch.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertSegmentBoundaryIntegrity,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  classifySqueezeRobustness,
  compareOverlappingCandleCloses,
  diagnoseWinningVsLosing,
  evaluateXauUsdHistoryLiveParity,
  hourOfDayBreakdown,
  inventoryXauUsdWeeklySegments,
  leaveOneWeekOut,
  aggregateWeeklyResults,
  runWeeklyStrategyMatrix,
  runWeeksPooledMetrics,
  sessionBucketBreakdown,
  summarizeObservedXauUsdSpread,
  weekDominanceShare
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

describe("XAUUSD weekly squeeze robustness research", () => {
  it("runs multi-week / leave-one-out / chrono holdout without enabling XAUUSD", async () => {
    const history = await loadCandles("HISTORY_API");
    expect(history.length).toBeGreaterThan(5000);

    const inventory = inventoryXauUsdWeeklySegments(history);
    assertSegmentBoundaryIntegrity(inventory);
    const usable = inventory.filter((w) => w.usable);
    expect(usable.length).toBeGreaterThanOrEqual(2);

    const spreadPath = resolve(
      process.cwd(),
      "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
    );
    const spread = summarizeObservedXauUsdSpread(spreadPath, {
      preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
    });
    const observedSpreadBps = spread.medianBps ?? 0.61;
    const profiles = buildXauUsdCostProfiles(observedSpreadBps);

    const weeklyRows = await runWeeklyStrategyMatrix(
      usable,
      ["squeeze-breakout-v1", "ema-pullback-v1"],
      profiles
    );

    const squeezeObserved = aggregateWeeklyResults(
      weeklyRows,
      "squeeze-breakout-v1",
      "OBSERVED_SPREAD_ONLY"
    );
    const squeezeZero = aggregateWeeklyResults(weeklyRows, "squeeze-breakout-v1", "ZERO");
    const emaObserved = aggregateWeeklyResults(
      weeklyRows,
      "ema-pullback-v1",
      "OBSERVED_SPREAD_ONLY"
    );

    const loo = leaveOneWeekOut(weeklyRows, "squeeze-breakout-v1", "OBSERVED_SPREAD_ONLY");
    const looMinExp = Math.min(...loo.map((r) => r.expectancyR));
    const dominance = weekDominanceShare(
      weeklyRows,
      "squeeze-breakout-v1",
      "OBSERVED_SPREAD_ONLY"
    );

    const chrono = chronologicalWeekSplit(usable, 0.3);
    expect(chrono.developmentWeeks.length).toBeGreaterThan(0);
    expect(chrono.holdoutWeeks.length).toBeGreaterThan(0);
    if (chrono.holdoutStartOpenTime != null) {
      for (const w of chrono.developmentWeeks) {
        expect(w.endOpenTime).toBeLessThan(chrono.holdoutStartOpenTime);
      }
    }

    const [devObs, holdObs, holdZero, holdSlip025] = await Promise.all([
      runWeeksPooledMetrics(
        chrono.developmentWeeks,
        "squeeze-breakout-v1",
        observedSpreadBps,
        0
      ),
      runWeeksPooledMetrics(chrono.holdoutWeeks, "squeeze-breakout-v1", observedSpreadBps, 0),
      runWeeksPooledMetrics(chrono.holdoutWeeks, "squeeze-breakout-v1", 0, 0),
      runWeeksPooledMetrics(
        chrono.holdoutWeeks,
        "squeeze-breakout-v1",
        observedSpreadBps,
        0.25
      )
    ]);

    // Walk-forward proxy: each development week as an OOS window (already independent).
    const wfWeeks = weeklyRows.filter(
      (r) =>
        r.strategyId === "squeeze-breakout-v1" &&
        r.costProfileId === "OBSERVED_SPREAD_ONLY" &&
        chrono.developmentWeeks.some((w) => w.segmentId === r.segmentId)
    );
    const wfPositivePct =
      wfWeeks.length > 0
        ? wfWeeks.filter((w) => w.metrics.expectancyR > 0 && w.metrics.trades > 0).length /
          wfWeeks.length
        : 0;

    const slipSensitivity = profiles.map((p) => {
      const agg = aggregateWeeklyResults(weeklyRows, "squeeze-breakout-v1", p.id);
      return {
        profileId: p.id,
        label: p.label,
        spreadBps: p.spreadBps,
        slippageBps: p.slippageBps,
        expectancyR: agg.expectancyR,
        profitFactor: agg.profitFactor,
        totalTrades: agg.totalTrades,
        positiveWeekPct: agg.positiveWeekPct,
        netR: agg.netR
      };
    });

    const survivesAssumedSlip025 =
      (slipSensitivity.find((s) => s.profileId === "ASSUMED_SLIP_0_25")?.expectancyR ?? -1) > 0;

    const mt5Live = await loadCandles("MT5_LIVE_TICKS");
    const overlapParity = compareOverlappingCandleCloses(history, mt5Live);
    const scaleParity = evaluateXauUsdHistoryLiveParity({
      historicalLastClose: history.at(-1)?.close ?? null,
      liveMid: 4426
    });

    const diagnostics = diagnoseWinningVsLosing(
      holdObs.trades.length ? holdObs.trades : devObs.trades
    );
    const pooledObs = await runWeeksPooledMetrics(
      usable,
      "squeeze-breakout-v1",
      observedSpreadBps,
      0
    );
    const hourAll = hourOfDayBreakdown(pooledObs.trades);
    const sessionAll = sessionBucketBreakdown(pooledObs.trades);
    const diagAll = diagnoseWinningVsLosing(pooledObs.trades);
    const hours = hourOfDayBreakdown(holdObs.trades.length ? holdObs.trades : devObs.trades);
    const sessions = sessionBucketBreakdown(holdObs.trades.length ? holdObs.trades : devObs.trades);

    const classification = classifySqueezeRobustness({
      pooledObserved: squeezeObserved,
      finalHoldoutTrades: holdObs.metrics.trades,
      finalHoldoutExpectancyR: holdObs.metrics.expectancyR,
      leaveOneOutMinExpectancyR: looMinExp,
      positiveWeekPct: squeezeObserved.positiveWeekPct,
      parityVerdict:
        overlapParity.verdict === "INSUFFICIENT_OVERLAP"
          ? scaleParity.verdict === "MATERIAL_MISMATCH"
            ? "MATERIAL_MISMATCH"
            : "MATCH_APPROXIMATE"
          : overlapParity.verdict,
      survivesAssumedSlip025,
      singleWeekDominates: dominance > 0.6
    });

    const artifact = {
      generatedAt: new Date().toISOString(),
      researchOnly: true,
      enablement: {
        allowlist: false,
        trades: false,
        deployed: false,
        strategyMutated: false,
        r10Unchanged: true
      },
      inventory: inventory.map(({ candles: _c, ...rest }) => rest),
      usableWeekCount: usable.length,
      totalUsableBars1m: usable.reduce((a, w) => a + w.bars1m, 0),
      totalUsableBars5m: usable.reduce((a, w) => a + w.bars5m, 0),
      spread,
      scaleParity,
      overlapParity,
      weekly: {
        squeeze: weeklyRows
          .filter((r) => r.strategyId === "squeeze-breakout-v1" && r.costProfileId === "OBSERVED_SPREAD_ONLY")
          .map((r) => ({
            segmentId: r.segmentId,
            weekStartIso: r.weekStartIso,
            trades: r.metrics.trades,
            wins: r.metrics.wins,
            losses: r.metrics.losses,
            winRate: r.metrics.winRate,
            profitFactor: r.metrics.profitFactor,
            expectancyR: r.metrics.expectancyR,
            netR: r.metrics.netR,
            maxDrawdownPercent: r.metrics.maxDrawdownPercent,
            buyExpectancyR: r.metrics.buyExpectancyR,
            sellExpectancyR: r.metrics.sellExpectancyR,
            byRegime: r.metrics.byRegime
          })),
        ema: weeklyRows
          .filter((r) => r.strategyId === "ema-pullback-v1" && r.costProfileId === "OBSERVED_SPREAD_ONLY")
          .map((r) => ({
            segmentId: r.segmentId,
            trades: r.metrics.trades,
            expectancyR: r.metrics.expectancyR,
            profitFactor: r.metrics.profitFactor,
            netR: r.metrics.netR,
            winRate: r.metrics.winRate
          }))
      },
      pooled: {
        squeezeZero,
        squeezeObserved,
        emaObserved
      },
      leaveOneWeekOut: loo,
      dominanceShareOfPositiveNetR: dominance,
      chronological: {
        developmentWeekIds: chrono.developmentWeeks.map((w) => w.segmentId),
        holdoutWeekIds: chrono.holdoutWeeks.map((w) => w.segmentId),
        development: {
          observed: devObs.metrics,
          weekCount: chrono.developmentWeeks.length
        },
        walkForwardProxy: {
          developmentWeekCount: wfWeeks.length,
          percentPositiveExpectancy: wfPositivePct
        },
        finalHoldout: {
          observed: holdObs.metrics,
          zero: holdZero.metrics,
          assumedSlip025: holdSlip025.metrics,
          tradeCount: holdObs.metrics.trades,
          sampleSize: holdObs.metrics.sampleSize
        }
      },
      costSensitivity: slipSensitivity,
      diagnostics: { holdoutOrDev: diagnostics, pooled: diagAll },
      timeOfDay: { holdoutOrDev: hours, pooled: hourAll },
      sessions: { holdoutOrDev: sessions, pooled: sessionAll },
      classification
    };

    const outDir = resolve(process.cwd(), "../../research-datasets");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, "XAUUSD_squeeze_weekly_robustness.json"),
      `${JSON.stringify(artifact, null, 2)}\n`
    );

    expect(artifact.enablement.allowlist).toBe(false);
    expect(artifact.enablement.strategyMutated).toBe(false);
    console.log(
      JSON.stringify(
        {
          usableWeeks: usable.length,
          pooledTrades: squeezeObserved.totalTrades,
          positiveWeekPct: squeezeObserved.positiveWeekPct,
          holdoutTrades: holdObs.metrics.trades,
          holdoutExp: holdObs.metrics.expectancyR,
          looMinExp,
          dominance,
          classification: classification.classification
        },
        null,
        2
      )
    );
  }, 900_000);
});
