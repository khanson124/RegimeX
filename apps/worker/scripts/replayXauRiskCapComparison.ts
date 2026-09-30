#!/usr/bin/env tsx
/**
 * Read-only XAUUSD broker-min-volume risk-cap comparison for xau-trend-pullback-v1 (15m).
 *
 * Always reports both modes (no production settings are changed):
 *   A. CONTROLLED_SHARED_SIGNAL — one shared signal stream; a cap only decides whether
 *      a signal can be sized at the 0.01-lot broker minimum.
 *   B. PRODUCTION_FAITHFUL_CHRONOLOGICAL — each cap walks M15 closes independently and
 *      advances last-signal cooldown only when shouldConsumeStrategySignalCooldown says
 *      so (OPENED consumes; MIN_VOLUME_EXCEEDS_RISK does not).
 * Stops, targets and R never depend on the cap. No spread/commission/slippage.
 *
 * Reads Symbol / Candle / StrategyDefinition / BrokerSymbolMapping / InstrumentMetadata.
 * Never writes to the database, places orders, or touches DEMO/REAL services or config.
 *
 * Usage:
 *   pnpm --filter @regimex/worker exec tsx scripts/replayXauRiskCapComparison.ts
 *   pnpm --filter @regimex/worker exec tsx scripts/replayXauRiskCapComparison.ts \
 *     --equity 10000 --from 2026-08-01T00:00:00.000Z --to 2026-09-29T00:00:00.000Z
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@regimex/config";
import { PrismaClient } from "@regimex/database";
import {
  XAU_RISK_CAP_PERCENTS,
  formatXauRiskCapComparisonMarkdown,
  runXauRiskCapComparison
} from "@regimex/trading-engine";
import { loadXauRiskCapInputs } from "../src/cfd/xauRiskCapComparisonLoader.js";

function loadEnvFile(): void {
  const candidates = [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!.trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const prisma = new PrismaClient();

  const equity = Number(arg("equity") ?? "10000");
  if (!(equity > 0)) throw new Error("--equity must be positive");
  const caps = arg("caps")
    ? arg("caps")!.split(",").map((s) => Number(s.trim())).filter((x) => x > 0)
    : [...XAU_RISK_CAP_PERCENTS];
  const outDir = resolve(process.cwd(), arg("out-dir") ?? "../../research-datasets/xau-risk-cap-comparison");
  mkdirSync(outDir, { recursive: true });

  try {
    const loaded = await loadXauRiskCapInputs(prisma, {
      symbol: arg("symbol") ?? "XAUUSD",
      fromIso: arg("from"),
      toIso: arg("to"),
      userId: arg("user-id") ?? null
    });
    const engineMaxVolume = config.MT5_ENGINE_MAX_VOLUME;
    const report = runXauRiskCapComparison({
      symbol: loaded.symbol,
      m15: loaded.m15,
      h4: loaded.h4,
      analysisStartMs: loaded.analysisStartMs,
      analysisEndMs: loaded.analysisEndMs,
      equity,
      instrument: loaded.instrument,
      engineMaxVolume,
      riskCapsPercent: caps,
      parameters: loaded.parameters,
      parametersSource: loaded.parametersSource,
      instrumentSource: loaded.instrumentSource,
      integrityInputs: loaded.integrityInputs,
      extraLimitations: [
        ...loaded.limitations,
        `Engine max volume ${engineMaxVolume} and MT5_ENGINE_MAX_RISK_PERCENT ${config.MT5_ENGINE_MAX_RISK_PERCENT} read from config (not modified)`
      ]
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const md = formatXauRiskCapComparisonMarkdown(report);
    const json = JSON.stringify(report, null, 2);
    const paths = {
      jsonPath: resolve(outDir, `xau_risk_cap_comparison_${stamp}.json`),
      mdPath: resolve(outDir, `xau_risk_cap_comparison_${stamp}.md`),
      latestJson: resolve(outDir, "xau_risk_cap_comparison_latest.json"),
      latestMd: resolve(outDir, "xau_risk_cap_comparison_latest.md")
    };
    writeFileSync(paths.mdPath, md);
    writeFileSync(paths.latestMd, md);
    writeFileSync(paths.jsonPath, json);
    writeFileSync(paths.latestJson, json);

    console.log(md);
    console.log(JSON.stringify({ wrote: paths }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
