#!/usr/bin/env tsx
/**
 * Research-only: measure R_10 MT5 DEMO empirical transaction costs from persisted telemetry.
 *
 * Does NOT deploy, enable strategies, or alter MT5 execution.
 *
 *   pnpm --filter @regimex/worker exec tsx scripts/measureR10Mt5Costs.ts
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@regimex/database";
import {
  extractMt5CostSamplesFromPositions,
  buildEmpiricalCostCalibrationReport,
  documentBacktesterCostExample,
  type Mt5PersistedCostRaw
} from "@regimex/trading-engine";
import { type PositionDirection } from "@regimex/shared";

function loadEnvFile(): void {
  for (const path of [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.position.findMany({
      where: {
        OR: [
          { symbol: "R_10" },
          { symbol: { contains: "Volatility 10" } },
          { metadata: { path: ["venue"], equals: "MT5_DEMO" } },
          { metadata: { path: ["executionModel"], equals: "broker_demo_mt5" } },
          { metadata: { path: ["engineSymbol"], equals: "R_10" } }
        ]
      },
      orderBy: { createdAt: "asc" }
    });

    const raw: Mt5PersistedCostRaw[] = rows.map((r) => ({
      positionId: r.id,
      symbol: r.symbol,
      direction: r.direction as PositionDirection,
      status: r.status,
      entryPrice: r.entryPrice != null ? Number(r.entryPrice) : null,
      closePrice: r.closePrice != null ? Number(r.closePrice) : null,
      openedAtMs: r.openedAt?.getTime() ?? null,
      closedAtMs: r.closedAt?.getTime() ?? null,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null
    }));

    const passivePath = resolve(
      process.cwd(),
      "../../research-datasets/R_10_mt5_passive_spread_samples.jsonl"
    );
    const bundle = extractMt5CostSamplesFromPositions(raw, {
      tickSize: 0.001,
      passiveSpreadJsonlPath: existsSync(passivePath) ? passivePath : undefined
    });
    const calibration = buildEmpiricalCostCalibrationReport({
      symbol: "R_10",
      bundle
    });

    const okEntry = bundle.entrySlippageSamples.filter((s) => s.quality === "OK");
    const staleEntry = bundle.entrySlippageSamples.filter((s) => s.quality === "STALE_QUOTE");
    const missingTs = bundle.entrySlippageSamples.filter((s) => s.quality === "MISSING_TIMESTAMPS");
    const timing = {
      quoteAgeMs: bundle.entrySlippageSamples
        .map((s) => s.quoteAgeMs)
        .filter((x): x is number => x != null),
      quoteAgeBuckets: bundle.entrySlippageSamples.reduce(
        (acc, s) => {
          acc[s.quoteAgeBucket] = (acc[s.quoteAgeBucket] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      )
    };

    const quality = {
      reliableEntrySamples: okEntry.length,
      staleQuoteSamples: staleEntry.length,
      missingTimestampSamples: missingTs.length,
      ambiguousOrInvalid: bundle.entrySlippageSamples.filter((s) => s.quality === "INVALID").length,
      spreadOk: bundle.spreadSamples.filter((s) => s.quality === "OK").length
    };

    const backtesterSemantics = {
      convention:
        "spreadBps = FULL bid-ask width; half-spread + slippageBps applied per side via fill prices only",
      example6300_8_3: documentBacktesterCostExample({
        mid: 6300,
        spreadBps: 8,
        slippageBps: 3,
        direction: "BUY",
        stopDistancePrice: 10,
        targetRMultiple: 2
      }),
      doubleCountAudit: {
        spreadDoubleCounted: false,
        slippageDoubleCounted: false,
        separatePnlFee: false,
        roundTripBpsApprox: "spreadBps + 2*slippageBps when mid unchanged"
      }
    };

    const report = {
      action: "measure-r10-mt5-costs",
      positionsLoaded: raw.length,
      passiveSpreadPath: existsSync(passivePath) ? passivePath : null,
      quality,
      timing,
      unlockGates: {
        spreadReliableMin: 30,
        entryFillReliableMin: 20,
        spreadOk: quality.spreadOk,
        entryReliable: quality.reliableEntrySamples,
        profilesUnlocked: calibration.profiles.some((p) => p.label === "MEDIAN" && p.dataSufficient)
      },
      calibration,
      backtesterSemantics,
      classification:
        calibration.sufficiency.spread === "NONE" &&
        (calibration.sufficiency.entrySlippage === "NONE" ||
          calibration.sufficiency.entrySlippage === "INCONCLUSIVE")
          ? "COST_CALIBRATION_BLOCKED_INSUFFICIENT_MT5_TELEMETRY"
          : calibration.profiles.some((p) => p.label === "MEDIAN" && p.dataSufficient)
            ? "EMPIRICAL_PROFILES_READY"
            : "PARTIAL_TELEMETRY_EMPIRICAL_PROFILES_WITHHELD",
      notes: {
        deployed: false,
        strategyEnabled: false,
        emaPullbackRemainsSuspended: true,
        mt5ExecutionUnchanged: true,
        arbitraryTradesGenerated: false
      }
    };

    const outDir = resolve(process.cwd(), "../../research-datasets");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, "R_10_mt5_empirical_cost_calibration.json");
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Wrote ${outPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
