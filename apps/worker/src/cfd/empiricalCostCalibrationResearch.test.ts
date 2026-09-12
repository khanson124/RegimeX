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

type CostProfileRow = { label: string; spreadBps: number; slippageBps: number };

/** Research-only assumed-slippage sensitivities on observed median spread — not empirical profiles. */
export const SPREAD_SENSITIVITY_SCENARIOS = [
  { label: "SPREAD_OBS_SLIP_0", slippageBps: 0 },
  { label: "SPREAD_OBS_SLIP_0_10", slippageBps: 0.1 },
  { label: "SPREAD_OBS_SLIP_0_25", slippageBps: 0.25 },
  { label: "SPREAD_OBS_SLIP_0_50", slippageBps: 0.5 }
] as const;

/**
 * Append hypothetical spread×assumed-slip rows for breakout comparison only.
 * Does not mutate calibration.profiles.
 */
export function appendObservedSpreadSensitivityProfiles(
  profiles: CostProfileRow[],
  observedSpreadBps: number | null | undefined
): {
  observedSpreadBpsUsed: number | null;
  sensitivityLabels: string[];
} {
  if (observedSpreadBps == null || !Number.isFinite(observedSpreadBps)) {
    return { observedSpreadBpsUsed: null, sensitivityLabels: [] };
  }
  const labels: string[] = [];
  for (const s of SPREAD_SENSITIVITY_SCENARIOS) {
    profiles.push({
      label: s.label,
      spreadBps: observedSpreadBps,
      slippageBps: s.slippageBps
    });
    labels.push(s.label);
  }
  return { observedSpreadBpsUsed: observedSpreadBps, sensitivityLabels: labels };
}

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

/** Same R_10 1m loading rule as breakoutFamilyResearch.test.ts `loadAllR10OneMinute`. */
async function loadAllR10OneMinute(): Promise<{
  candles: Candle[];
  totalInDb: number;
  historyApiCount: number;
  loadSourcePreference: "HISTORY_API" | "ALL";
}> {
  const prisma = new PrismaClient();
  try {
    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!symbol) {
      return { candles: [], totalInDb: 0, historyApiCount: 0, loadSourcePreference: "ALL" };
    }
    const totalInDb = await prisma.candle.count({
      where: { symbolId: symbol.id, interval: "1m" }
    });
    // Prefer Deriv HISTORY_API for research continuity (exclude SEED mocks / mixed live).
    const historyApiCount = await prisma.candle.count({
      where: { symbolId: symbol.id, interval: "1m", source: "HISTORY_API" }
    });
    const loadSourcePreference: "HISTORY_API" | "ALL" =
      historyApiCount >= 1000 ? "HISTORY_API" : "ALL";
    const sourceFilter =
      loadSourcePreference === "HISTORY_API"
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
    return { candles, totalInDb, historyApiCount, loadSourcePreference };
  } finally {
    await prisma.$disconnect();
  }
}

describe("empirical MT5 cost calibration research", () => {
  it("appends research-only spread sensitivity profiles from observed median without touching calibration.profiles", () => {
    const calibrationProfiles = [
      { label: "ZERO", spreadBps: 0, slippageBps: 0 },
      { label: "LEGACY_8_3", spreadBps: 8, slippageBps: 3 }
    ];
    const profiles: CostProfileRow[] = [...calibrationProfiles];
    const observed = 0.8729;
    const meta = appendObservedSpreadSensitivityProfiles(profiles, observed);

    expect(meta.observedSpreadBpsUsed).toBe(observed);
    expect(meta.sensitivityLabels).toEqual([
      "SPREAD_OBS_SLIP_0",
      "SPREAD_OBS_SLIP_0_10",
      "SPREAD_OBS_SLIP_0_25",
      "SPREAD_OBS_SLIP_0_50"
    ]);
    expect(profiles).toHaveLength(6);
    for (const label of meta.sensitivityLabels) {
      const row = profiles.find((p) => p.label === label)!;
      expect(row.spreadBps).toBe(observed);
    }
    expect(profiles.find((p) => p.label === "SPREAD_OBS_SLIP_0")!.slippageBps).toBe(0);
    expect(profiles.find((p) => p.label === "SPREAD_OBS_SLIP_0_10")!.slippageBps).toBe(0.1);
    expect(profiles.find((p) => p.label === "SPREAD_OBS_SLIP_0_25")!.slippageBps).toBe(0.25);
    expect(profiles.find((p) => p.label === "SPREAD_OBS_SLIP_0_50")!.slippageBps).toBe(0.5);
    // calibration.profiles must remain untouched (we only copied labels into comparison list)
    expect(calibrationProfiles).toHaveLength(2);
    expect(calibrationProfiles.map((p) => p.label)).toEqual(["ZERO", "LEGACY_8_3"]);

    expect(appendObservedSpreadSensitivityProfiles([], null).sensitivityLabels).toEqual([]);
    expect(appendObservedSpreadSensitivityProfiles([], Number.NaN).sensitivityLabels).toEqual([]);
  });

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

    const {
      candles: candles1m,
      totalInDb,
      historyApiCount,
      loadSourcePreference
    } = await loadAllR10OneMinute();
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

    const sensitivity = appendObservedSpreadSensitivityProfiles(
      profiles,
      calibration.spread.bps.median
    );

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
      dataAvailability: {
        totalInDb,
        historyApiCount,
        loaded: candles1m.length,
        loadSourcePreference,
        note:
          loadSourcePreference === "HISTORY_API"
            ? "Loaded HISTORY_API R_10 1m only (research provenance)"
            : "HISTORY_API sparse; loaded all sources"
      },
      holdoutStartIso: new Date(holdoutStartOpenTime).toISOString(),
      profilesUsed: profiles,
      comparison,
      decision,
      spreadSensitivityMetadata: {
        observedSpreadBpsUsed: sensitivity.observedSpreadBpsUsed,
        sensitivityLabels: sensitivity.sensitivityLabels,
        note:
          "SPREAD_OBS_SLIP_* rows are research-only sensitivity scenarios using observed median spread with assumed slippage. They are NOT empirical slippage estimates. Entry slippage telemetry remains inconclusive until reliable timed samples exist. These labels are not inserted into calibration.profiles.",
        slippageTelemetryInconclusive: true,
        notEmpiricalSlippageEstimates: true,
        notInsertedIntoCalibrationProfiles: true
      },
      confirmations: {
        deployed: false,
        strategyEnabled: false,
        emaPullbackRemainsSuspended: true,
        mt5ExecutionUnchanged: true,
        riskLifecycleAllowlistsUnchanged: true,
        historicalResearchResultsNotAltered: true
      }
    };

    if (sensitivity.observedSpreadBpsUsed != null) {
      for (const label of sensitivity.sensitivityLabels) {
        expect(profiles.some((p) => p.label === label)).toBe(true);
        expect(profiles.find((p) => p.label === label)!.spreadBps).toBe(
          sensitivity.observedSpreadBpsUsed
        );
        expect(calibration.profiles.some((p) => (p.label as string) === label)).toBe(false);
      }
      expect(comparison.rows.some((r) => r.profileLabel === "SPREAD_OBS_SLIP_0")).toBe(true);
    }

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
