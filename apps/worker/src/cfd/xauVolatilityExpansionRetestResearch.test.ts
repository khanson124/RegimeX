/**
 * XAU Volatility Expansion Retest v1 research (no enablement).
 *
 *   pnpm --filter @regimex/worker exec vitest run src/cfd/xauVolatilityExpansionRetestResearch.test.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS, type Candle } from "@regimex/shared";
import { PrismaClient } from "@regimex/database";
import {
  assertProductionIntervalsUnchanged,
  assertSegmentBoundaryIntegrity,
  BREAKOUT_MOMENTUM_DEFAULTS,
  buildXauUsdCostProfiles,
  chronologicalWeekSplit,
  classifyVolExpansionResearch,
  detectSensitivityCollapse,
  EMA_PULLBACK_DEFAULTS,
  funnelAcrossWeeks,
  hourOfDayBreakdown,
  htf15ContextBreakdown,
  inventoryXauUsdWeeklySegments,
  runVolExpansionBaseline,
  runVolExpansionSensitivity,
  runWeeklyVolExpansionMatrix,
  runWeeksPooledVolExpansion,
  sessionBucketBreakdown,
  summarizeObservedXauUsdSpread,
  summarizeTrades,
  SQUEEZE_BREAKOUT_DEFAULTS,
  weekDominanceShare,
  aggregateWeeklyResults,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS,
  XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS
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

describe("xau-volatility-expansion-retest-v1 research", () => {
  it(
    "runs funnel / sensitivity / weekly / holdout vs baselines without enabling XAUUSD",
    async () => {
      assertProductionIntervalsUnchanged();
      expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m"]);
      expect(SQUEEZE_BREAKOUT_DEFAULTS).toBeTruthy();
      expect(BREAKOUT_MOMENTUM_DEFAULTS).toBeTruthy();
      expect(EMA_PULLBACK_DEFAULTS).toBeTruthy();
      expect(XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS).toBeTruthy();

      const history = await loadCandles();
      expect(history.length).toBeGreaterThan(5000);

      const inventory = inventoryXauUsdWeeklySegments(history);
      assertSegmentBoundaryIntegrity(inventory);
      const usable = inventory.filter((w) => w.usable);
      expect(usable.length).toBeGreaterThanOrEqual(10);

      const chrono = chronologicalWeekSplit(usable, 0.3);
      expect(chrono.developmentWeeks.length).toBeGreaterThan(0);
      expect(chrono.holdoutWeeks.length).toBeGreaterThan(0);
      if (chrono.holdoutStartOpenTime != null) {
        for (const w of chrono.developmentWeeks) {
          expect(w.endOpenTime).toBeLessThan(chrono.holdoutStartOpenTime);
        }
      }

      const spreadPath = resolve(
        process.cwd(),
        "../../research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl"
      );
      const spread = summarizeObservedXauUsdSpread(spreadPath, {
        preliminaryFromOperator: { sampleCount: 17, medianBps: 0.61, medianSpreadPrice: 0.27 }
      });
      const observedSpreadBps = spread.medianBps ?? 0.61;
      const profiles = buildXauUsdCostProfiles(observedSpreadBps);

      const params5m = {
        ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS,
        executionTimeframe: "5m" as const
      };
      const params1m = {
        ...XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS,
        executionTimeframe: "1m" as const
      };

      const funnel = funnelAcrossWeeks(usable, params5m);
      const sensitivity = await runVolExpansionSensitivity(
        chrono.developmentWeeks,
        observedSpreadBps
      );
      const sensitivityCollapse = detectSensitivityCollapse(sensitivity);

      const weekly5m = await runWeeklyVolExpansionMatrix(
        usable,
        params5m,
        profiles,
        "xau-vol-exp-retest-5m"
      );
      const weekly1m = await runWeeklyVolExpansionMatrix(
        usable,
        params1m,
        profiles,
        "xau-vol-exp-retest-1m"
      );

      const pooled5mObs = aggregateWeeklyResults(
        weekly5m,
        "xau-vol-exp-retest-5m",
        "OBSERVED_SPREAD_ONLY"
      );
      const pooled5mZero = aggregateWeeklyResults(weekly5m, "xau-vol-exp-retest-5m", "ZERO");
      const pooled1mObs = aggregateWeeklyResults(
        weekly1m,
        "xau-vol-exp-retest-1m",
        "OBSERVED_SPREAD_ONLY"
      );

      const [dev5m, hold5m, hold5mSlip, hold1m] = await Promise.all([
        runWeeksPooledVolExpansion(chrono.developmentWeeks, params5m, observedSpreadBps, 0),
        runWeeksPooledVolExpansion(chrono.holdoutWeeks, params5m, observedSpreadBps, 0),
        runWeeksPooledVolExpansion(chrono.holdoutWeeks, params5m, observedSpreadBps, 0.25),
        runWeeksPooledVolExpansion(chrono.holdoutWeeks, params1m, observedSpreadBps, 0)
      ]);

      const wfWeeks = weekly5m.filter(
        (r) =>
          r.costProfileId === "OBSERVED_SPREAD_ONLY" &&
          chrono.developmentWeeks.some((w) => w.segmentId === r.segmentId)
      );
      const wfPositivePct =
        wfWeeks.length > 0
          ? wfWeeks.filter((w) => w.metrics.expectancyR > 0 && w.metrics.trades > 0).length /
            wfWeeks.length
          : 0;

      const dominance = weekDominanceShare(
        weekly5m,
        "xau-vol-exp-retest-5m",
        "OBSERVED_SPREAD_ONLY"
      );
      const slip025 = aggregateWeeklyResults(
        weekly5m,
        "xau-vol-exp-retest-5m",
        "ASSUMED_SLIP_0_25"
      );

      const classification = classifyVolExpansionResearch({
        pooledObserved: pooled5mObs,
        zeroExpectancyR: pooled5mZero.expectancyR,
        holdoutTrades: hold5m.metrics.trades,
        holdoutExpectancyR: hold5m.metrics.expectancyR,
        holdoutProfitFactor: hold5m.metrics.profitFactor,
        positiveWeekPct: pooled5mObs.positiveWeekPct,
        wfPositivePct,
        survivesAssumedSlip025: slip025.expectancyR > 0,
        singleWeekDominates: dominance > 0.6,
        sensitivityCollapse
      });

      // Also classify 1m if adequate
      const classification1m = classifyVolExpansionResearch({
        pooledObserved: pooled1mObs,
        zeroExpectancyR: aggregateWeeklyResults(weekly1m, "xau-vol-exp-retest-1m", "ZERO")
          .expectancyR,
        holdoutTrades: hold1m.metrics.trades,
        holdoutExpectancyR: hold1m.metrics.expectancyR,
        holdoutProfitFactor: hold1m.metrics.profitFactor,
        positiveWeekPct: pooled1mObs.positiveWeekPct,
        wfPositivePct: weekly1m.filter(
          (r) =>
            r.costProfileId === "OBSERVED_SPREAD_ONLY" &&
            chrono.developmentWeeks.some((w) => w.segmentId === r.segmentId) &&
            r.metrics.expectancyR > 0 &&
            r.metrics.trades > 0
        ).length /
          Math.max(
            1,
            weekly1m.filter(
              (r) =>
                r.costProfileId === "OBSERVED_SPREAD_ONLY" &&
                chrono.developmentWeeks.some((w) => w.segmentId === r.segmentId)
            ).length
          ),
        survivesAssumedSlip025:
          aggregateWeeklyResults(weekly1m, "xau-vol-exp-retest-1m", "ASSUMED_SLIP_0_25")
            .expectancyR > 0,
        singleWeekDominates:
          weekDominanceShare(weekly1m, "xau-vol-exp-retest-1m", "OBSERVED_SPREAD_ONLY") > 0.6,
        sensitivityCollapse: false
      });

      const baselineHoldout: Record<string, unknown> = {};
      for (const id of [
        "squeeze-breakout-v1",
        "breakout-momentum-v1",
        "ema-pullback-v1",
        "xau-mtf-structure-momentum-v1"
      ] as const) {
        const allTrades = [];
        for (const w of chrono.holdoutWeeks) {
          const r = await runVolExpansionBaseline(w.candles, id, observedSpreadBps, 0);
          allTrades.push(...r.trades);
        }
        baselineHoldout[id] = summarizeTrades(allTrades);
      }

      const costSensitivity = profiles.map((p) => {
        const a = aggregateWeeklyResults(weekly5m, "xau-vol-exp-retest-5m", p.id);
        return {
          profileId: p.id,
          label: p.label,
          expectancyR: a.expectancyR,
          profitFactor: a.profitFactor,
          totalTrades: a.totalTrades,
          positiveWeekPct: a.positiveWeekPct
        };
      });

      const artifact = {
        generatedAt: new Date().toISOString(),
        strategyId: "xau-volatility-expansion-retest-v1",
        defaults: XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS,
        productionIntervals: [...CANDLE_INTERVALS],
        usableWeeks: usable.length,
        spread,
        funnel,
        sensitivity,
        sensitivityCollapse,
        development: { execution5m: dev5m.metrics, wfPositivePct },
        weekly5mEntry: {
          pooledObserved: pooled5mObs,
          pooledZero: pooled5mZero,
          weeks: weekly5m
            .filter((r) => r.costProfileId === "OBSERVED_SPREAD_ONLY")
            .map((w) => ({
              segmentId: w.segmentId,
              trades: w.metrics.trades,
              expectancyR: w.metrics.expectancyR,
              profitFactor: w.metrics.profitFactor,
              netR: w.metrics.netR
            }))
        },
        weekly1mEntry: {
          pooledObserved: pooled1mObs,
          weeks: weekly1m
            .filter((r) => r.costProfileId === "OBSERVED_SPREAD_ONLY")
            .map((w) => ({
              segmentId: w.segmentId,
              trades: w.metrics.trades,
              expectancyR: w.metrics.expectancyR,
              profitFactor: w.metrics.profitFactor,
              netR: w.metrics.netR
            }))
        },
        entryModeComparison: {
          "5m": {
            pooledTrades: pooled5mObs.totalTrades,
            pooledExpectancyR: pooled5mObs.expectancyR,
            holdout: hold5m.metrics,
            classification: classification.classification
          },
          "1m": {
            pooledTrades: pooled1mObs.totalTrades,
            pooledExpectancyR: pooled1mObs.expectancyR,
            holdout: hold1m.metrics,
            classification: classification1m.classification
          }
        },
        finalHoldout5m: hold5m.metrics,
        finalHoldout5mAssumedSlip025: hold5mSlip.metrics,
        buySell: {
          buyTrades: pooled5mObs.buyTrades,
          sellTrades: pooled5mObs.sellTrades,
          buyExpectancyR: pooled5mObs.buyExpectancyR,
          sellExpectancyR: pooled5mObs.sellExpectancyR
        },
        sessions: sessionBucketBreakdown(hold5m.trades.length ? hold5m.trades : dev5m.trades),
        hours: hourOfDayBreakdown(hold5m.trades.length ? hold5m.trades : dev5m.trades),
        htf15Context: htf15ContextBreakdown(hold5m.trades.length ? hold5m.trades : dev5m.trades),
        costSensitivity,
        baselineHoldoutComparison: baselineHoldout,
        classification: classification.classification,
        classificationReasons: classification.reasons,
        classification1mEntry: classification1m,
        forwardDemoJustified: classification.classification === "PROMISING_FOR_FORWARD_DEMO_RESEARCH",
        safety: {
          nothingDeployed: true,
          xauusdNotEnabled: true,
          noXauusdTrades: true,
          existingStrategiesUnchanged: true,
          r10Unchanged: true,
          r10EmaRemainsSuspended: true,
          riskLifecycleUnchanged: true,
          realMoneyDisabled: true
        }
      };

      const outDir = resolve(process.cwd(), "../../research-datasets");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "XAUUSD_volatility_expansion_retest_research.json");
      writeFileSync(outPath, JSON.stringify(artifact, null, 2));

      console.log(
        JSON.stringify(
          {
            classification: artifact.classification,
            classification1m: classification1m.classification,
            funnel,
            pooled5m: {
              trades: pooled5mObs.totalTrades,
              expR: pooled5mObs.expectancyR,
              pf: pooled5mObs.profitFactor
            },
            holdout5m: {
              trades: hold5m.metrics.trades,
              expR: hold5m.metrics.expectancyR,
              pf: hold5m.metrics.profitFactor
            },
            entryCompare: artifact.entryModeComparison,
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
