#!/usr/bin/env tsx
/**
 * Read-only XAUUSD session-hours comparison for xau-trend-pullback-v1 (15m).
 *
 * Variants (session hours only; all other strategy parameters and the 0.20% DEMO XAU
 * risk cap are held constant):
 *   CURRENT           07:00–17:00 UTC  (production defaults)
 *   BROAD_LIQUID      06:00–18:00 UTC  (existing Gold research window)
 *   ASIA_PLUS_LONDON  00:00–17:00 UTC
 *   FULL_WEEKDAY      all stored MT5 M15 bars (no synthetic fills)
 *
 * Never writes to the database, places orders, or touches DEMO/REAL / risk-override code.
 *
 * Usage:
 *   pnpm --filter @regimex/worker exec tsx scripts/replayXauSessionHoursComparison.ts
 *   pnpm --filter @regimex/worker exec tsx scripts/replayXauSessionHoursComparison.ts \
 *     --equity 10000 --from 2026-08-01T00:00:00.000Z --to 2026-09-29T00:00:00.000Z
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@regimex/config";
import { PrismaClient } from "@regimex/database";
import {
  XAU_SESSION_HOURS_RISK_PERCENT,
  formatXauSessionHoursComparisonMarkdown,
  runXauSessionHoursComparison
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
  const outDir = resolve(process.cwd(), arg("out-dir") ?? "../../research-datasets/xau-session-hours-comparison");
  mkdirSync(outDir, { recursive: true });

  try {
    const loaded = await loadXauRiskCapInputs(prisma, {
      symbol: arg("symbol") ?? "XAUUSD",
      fromIso: arg("from"),
      toIso: arg("to"),
      userId: arg("user-id") ?? null
    });
    const engineMaxVolume = config.MT5_ENGINE_MAX_VOLUME;
    const report = runXauSessionHoursComparison({
      symbol: loaded.symbol,
      m15: loaded.m15,
      h4: loaded.h4,
      analysisStartMs: loaded.analysisStartMs,
      analysisEndMs: loaded.analysisEndMs,
      equity,
      instrument: loaded.instrument,
      engineMaxVolume,
      parameters: loaded.parameters,
      parametersSource: loaded.parametersSource,
      instrumentSource: loaded.instrumentSource,
      integrityInputs: loaded.integrityInputs,
      extraLimitations: [
        ...loaded.limitations,
        `Engine max volume ${engineMaxVolume} read from config (not modified). Research risk is fixed at ${XAU_SESSION_HOURS_RISK_PERCENT}%; MT5_DEMO_XAUUSD_MAX_RISK_PERCENT ${config.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT ?? "unset"} and MT5_ENGINE_MAX_RISK_PERCENT ${config.MT5_ENGINE_MAX_RISK_PERCENT} were not written.`
      ]
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const md = formatXauSessionHoursComparisonMarkdown(report);
    const json = JSON.stringify(report, null, 2);
    const paths = {
      jsonPath: resolve(outDir, `xau_session_hours_comparison_${stamp}.json`),
      mdPath: resolve(outDir, `xau_session_hours_comparison_${stamp}.md`),
      latestJson: resolve(outDir, "xau_session_hours_comparison_latest.json"),
      latestMd: resolve(outDir, "xau_session_hours_comparison_latest.md")
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
