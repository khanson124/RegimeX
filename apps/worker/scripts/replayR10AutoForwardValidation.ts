#!/usr/bin/env tsx
/**
 * Read-only out-of-sample forward validation of the frozen R_10 AUTO Pass C hypothesis.
 *
 * C0 = ungated Pass C baseline; C1 = EMA fallback-from-HOLD allowed only when the
 * direction-signed fast-EMA extension ≤ 0.5 ATR (frozen; not tunable here).
 * Forward window starts at a fixed timestamp; candles before it are indicator warmup only.
 *
 * Reads Candle / StrategyDefinition / RegimeConfiguration. Never writes to the database,
 * places orders, or touches DEMO/REAL services.
 *
 * Usage:
 *   pnpm --filter @regimex/worker exec tsx scripts/replayR10AutoForwardValidation.ts
 *   pnpm --filter @regimex/worker exec tsx scripts/replayR10AutoForwardValidation.ts --to 2026-10-20T00:00:00.000Z
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@regimex/config";
import { PrismaClient } from "@regimex/database";
import {
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  DEFAULT_REGIME_THRESHOLDS,
  R10_FORWARD_DEFAULT_ALLOWLIST,
  R10_FORWARD_START_ISO,
  formatR10ForwardValidationMarkdown,
  runR10AutoForwardValidation,
  type ReplayStrategyDefinition,
  type RegimeThresholds
} from "@regimex/trading-engine";
import { type Candle, type CandleInterval, type StrategyKind } from "@regimex/shared";

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

const KIND_BY_ID: Record<string, StrategyKind> = {
  "breakout-momentum-v1": "breakout-momentum",
  "ema-pullback-v1": "ema-pullback",
  "squeeze-breakout-v1": "squeeze-breakout",
  "bollinger-reversion-v1": "bollinger-reversion",
  "trend-structure-pullback-v1": "trend-structure-pullback"
};

async function loadStrategiesFromDb(
  prisma: PrismaClient,
  userId: string | null
): Promise<{ strategies: ReplayStrategyDefinition[]; limitation: string | null }> {
  const defs = await prisma.strategyDefinition.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      OR: userId ? [{ userId: null }, { userId }] : [{ userId: null }]
    },
    include: {
      versions: {
        where: { isActive: true },
        include: { parameterSets: { where: { isActive: true } } }
      }
    }
  });
  const strategies: ReplayStrategyDefinition[] = [];
  let usedDefaultParams = 0;
  for (const def of defs) {
    const kind = def.kind as StrategyKind;
    try {
      const strategy = createStrategy(kind);
      const rawFromDb = def.versions[0]?.parameterSets[0]?.parameters as
        | Record<string, number | boolean | string>
        | undefined;
      if (!rawFromDb) usedDefaultParams += 1;
      const parameters = strategy.validateParameters(rawFromDb ?? DEFAULT_STRATEGY_PARAMETERS[kind]);
      strategies.push({ strategy, parameters, enabled: def.enabled });
    } catch {
      // Skip unknown / unsupported kinds.
    }
  }
  if (strategies.length === 0) {
    return { strategies: [], limitation: "No instantiable enabled StrategyDefinition rows — using catalogue defaults" };
  }
  return {
    strategies,
    limitation:
      usedDefaultParams > 0
        ? `${usedDefaultParams} strategy definition(s) lacked active parameter sets — used DEFAULT_STRATEGY_PARAMETERS`
        : null
  };
}

function defaultStrategiesFromAllowlist(allowlist: string[]): ReplayStrategyDefinition[] {
  const out: ReplayStrategyDefinition[] = [];
  for (const id of allowlist) {
    const kind = KIND_BY_ID[id];
    if (!kind) continue;
    out.push({ strategy: createStrategy(kind), parameters: { ...DEFAULT_STRATEGY_PARAMETERS[kind] }, enabled: true });
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const prisma = new PrismaClient();

  const symbol = arg("symbol") ?? "R_10";
  const interval = (arg("interval") ?? "1m") as CandleInterval;
  const intervalMs = interval === "5m" ? 300_000 : interval === "15m" ? 900_000 : 60_000;
  const forwardStartMs = Date.parse(R10_FORWARD_START_ISO);
  const allowlist = (arg("allowlist") ?? R10_FORWARD_DEFAULT_ALLOWLIST.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const selectionMode =
    (arg("selection-mode") ?? config.STRATEGY_SELECTION_MODE ?? "bootstrap").toLowerCase() === "validated"
      ? "VALIDATED"
      : "BOOTSTRAP";
  const backendRaw = arg("backend") ?? "broker_demo_mt5";
  const executionBackend =
    backendRaw === "paper_cfd" || backendRaw === "broker_real_mt5" ? backendRaw : "broker_demo_mt5";
  const warmupHours = Number(arg("warmup-hours") ?? "26");
  const warmupStartMs = forwardStartMs - Math.max(1, warmupHours) * 3_600_000;
  const outDir = resolve(process.cwd(), arg("out-dir") ?? "../../research-datasets/auto-selection-forward-validation");
  mkdirSync(outDir, { recursive: true });

  const extraLimitations: string[] = [];
  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: symbol } });
    if (!sym) throw new Error(`Symbol ${symbol} not found in database`);

    let forwardEndMs: number;
    const toIso = arg("to");
    if (toIso) {
      forwardEndMs = Date.parse(toIso);
      if (!Number.isFinite(forwardEndMs)) throw new Error("Invalid --to ISO timestamp");
    } else {
      const latest = await prisma.candle.findFirst({
        where: { symbolId: sym.id, interval, isComplete: true },
        orderBy: { openTime: "desc" },
        select: { openTime: true }
      });
      forwardEndMs = latest ? latest.openTime.getTime() + intervalMs : forwardStartMs;
    }
    if (forwardEndMs <= forwardStartMs) {
      extraLimitations.push(
        `No complete ${symbol} ${interval} candles after forwardStart ${R10_FORWARD_START_ISO} — forward window is empty`
      );
      forwardEndMs = forwardStartMs;
    }

    const rows = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval,
        isComplete: true,
        openTime: { gte: new Date(warmupStartMs), lt: new Date(forwardEndMs) }
      },
      orderBy: { openTime: "asc" }
    });
    const candles: Candle[] = rows.map((r) => ({
      symbol,
      interval,
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tickCount: r.tickCount ?? 0,
      isComplete: r.isComplete,
      source: (r.source as Candle["source"]) ?? "HISTORY_API"
    }));

    const loaded = await loadStrategiesFromDb(prisma, arg("user-id") ?? null);
    let strategies = loaded.strategies;
    if (loaded.limitation) extraLimitations.push(loaded.limitation);
    if (strategies.length === 0) strategies = defaultStrategiesFromAllowlist(allowlist);

    const regimeConfig = await prisma.regimeConfiguration.findFirst({ where: { isActive: true } });
    const regimeThresholds = regimeConfig
      ? (regimeConfig.thresholds as unknown as RegimeThresholds)
      : DEFAULT_REGIME_THRESHOLDS;
    if (!regimeConfig) extraLimitations.push("No active RegimeConfiguration — using DEFAULT_REGIME_THRESHOLDS");
    extraLimitations.push(
      "BOOTSTRAP selection scoring (historical StrategyRegimeMetric not loaded); mechanical replay, not a DecisionLog reconstruction"
    );

    const report = runR10AutoForwardValidation(candles, {
      symbol,
      interval,
      forwardStartMs,
      forwardEndMs,
      selectionMode,
      executionBackend,
      strategyAllowlist: allowlist,
      strategies,
      regimeThresholds
    });
    report.limitations = [...extraLimitations, ...report.limitations];

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = resolve(outDir, `r10_auto_forward_validation_${stamp}.json`);
    const mdPath = resolve(outDir, `r10_auto_forward_validation_${stamp}.md`);
    const latestJson = resolve(outDir, "r10_auto_forward_validation_latest.json");
    const latestMd = resolve(outDir, "r10_auto_forward_validation_latest.md");
    const md = formatR10ForwardValidationMarkdown(report);
    const json = JSON.stringify(report, null, 2);
    writeFileSync(mdPath, md);
    writeFileSync(latestMd, md);
    writeFileSync(jsonPath, json);
    writeFileSync(latestJson, json);

    console.log(md);
    console.log(JSON.stringify({ wrote: { jsonPath, mdPath, latestJson, latestMd } }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
