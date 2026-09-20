#!/usr/bin/env tsx
/**
 * Offline read-only R_10 AUTO strategy-selection counterfactual replay.
 *
 * Pass A: production mirror (rank eligible → evaluate winner only).
 * Pass B: shadow (evaluate every eligible strategy on the same closed candle).
 *
 * Does NOT place orders, mutate production AUTO, or enable REAL trading.
 *
 * Usage:
 *   pnpm --filter @regimex/worker exec tsx scripts/replayR10AutoSelectionCounterfactual.ts
 *   pnpm --filter @regimex/worker exec tsx scripts/replayR10AutoSelectionCounterfactual.ts \
 *     --from 2026-09-20T14:00:00.000Z --to 2026-09-20T17:00:00.000Z \
 *     --allowlist breakout-momentum-v1,ema-pullback-v1,squeeze-breakout-v1,bollinger-reversion-v1
 *
 * If MT5 allowlist is empty locally, pass --allowlist (or --research-allowlist-defaults)
 * and the report will record that as a limitation vs live production config.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@regimex/config";
import { PrismaClient } from "@regimex/database";
import {
  createStrategy,
  DEFAULT_STRATEGY_PARAMETERS,
  DEFAULT_REGIME_THRESHOLDS,
  formatAutoSelectionReplayMarkdown,
  runAutoSelectionCounterfactualReplay,
  type Candle,
  type ReplayStrategyDefinition,
  type RegimeThresholds
} from "@regimex/trading-engine";
import { type StrategyKind } from "@regimex/shared";

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

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const RESEARCH_DEFAULT_ALLOWLIST = [
  "breakout-momentum-v1",
  "ema-pullback-v1",
  "squeeze-breakout-v1",
  "bollinger-reversion-v1"
];

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
  if (defs.length === 0) {
    return {
      strategies: [],
      limitation:
        "No enabled StrategyDefinition rows found — falling back to catalogue defaults with DEFAULT_STRATEGY_PARAMETERS"
    };
  }
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
      const raw = rawFromDb ?? DEFAULT_STRATEGY_PARAMETERS[kind];
      const parameters = strategy.validateParameters(raw);
      strategies.push({ strategy, parameters, enabled: def.enabled });
    } catch {
      // Skip unknown / unsupported kinds.
    }
  }
  if (strategies.length === 0) {
    return {
      strategies: [],
      limitation: "StrategyDefinition rows present but none could be instantiated — using defaults"
    };
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
  const ids = allowlist.length > 0 ? allowlist : RESEARCH_DEFAULT_ALLOWLIST;
  const out: ReplayStrategyDefinition[] = [];
  for (const id of ids) {
    const kind = KIND_BY_ID[id];
    if (!kind) continue;
    const strategy = createStrategy(kind);
    out.push({
      strategy,
      parameters: { ...DEFAULT_STRATEGY_PARAMETERS[kind] },
      enabled: true
    });
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const prisma = new PrismaClient();

  const symbol = arg("symbol") ?? "R_10";
  const interval = arg("interval") ?? "1m";
  const fromIso = arg("from") ?? "2026-09-20T14:00:00.000Z";
  const toIso = arg("to") ?? "2026-09-20T17:00:00.000Z";
  const analysisStartMs = Date.parse(fromIso);
  const analysisEndMs = Date.parse(toIso);
  if (!Number.isFinite(analysisStartMs) || !Number.isFinite(analysisEndMs)) {
    throw new Error("Invalid --from / --to ISO timestamps");
  }

  const selectionMode =
    (arg("selection-mode") ?? config.STRATEGY_SELECTION_MODE ?? "bootstrap").toLowerCase() ===
    "validated"
      ? "VALIDATED"
      : "BOOTSTRAP";

  const backendRaw = arg("backend") ?? "broker_demo_mt5";
  const executionBackend =
    backendRaw === "paper_cfd" || backendRaw === "broker_real_mt5"
      ? backendRaw
      : "broker_demo_mt5";

  let allowlist = parseAllowlist(
    arg("allowlist") ?? process.env.MT5_ENGINE_STRATEGY_ALLOWLIST ?? config.MT5_ENGINE_STRATEGY_ALLOWLIST
  );
  const usedResearchDefaults = hasFlag("research-allowlist-defaults") && allowlist.length === 0;
  if (usedResearchDefaults) {
    allowlist = [...RESEARCH_DEFAULT_ALLOWLIST];
  }

  const warmupHours = Number(arg("warmup-hours") ?? "26");
  const warmupStartMs = analysisStartMs - Math.max(1, warmupHours) * 3_600_000;

  const outDir = resolve(
    process.cwd(),
    arg("out-dir") ?? "../../research-datasets/auto-selection-counterfactual"
  );
  mkdirSync(outDir, { recursive: true });

  const extraLimitations: string[] = [];

  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: symbol } });
    if (!sym) {
      throw new Error(`Symbol ${symbol} not found in database`);
    }

    const rows = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval,
        isComplete: true,
        openTime: { gte: new Date(warmupStartMs), lt: new Date(analysisEndMs) }
      },
      orderBy: { openTime: "asc" }
    });

    const windowRows = rows.filter(
      (r) => r.openTime.getTime() >= analysisStartMs && r.openTime.getTime() < analysisEndMs
    );
    const expectedBars = Math.floor((analysisEndMs - analysisStartMs) / 60_000);
    console.log(
      JSON.stringify(
        {
          coverageProbe: {
            symbol,
            interval,
            source: "Candle table (prefer HISTORY_API for research)",
            warmupFrom: new Date(warmupStartMs).toISOString(),
            analysisFrom: fromIso,
            analysisTo: toIso,
            completeCandlesLoaded: rows.length,
            analysisWindowBars: windowRows.length,
            expectedAnalysisBarsApprox: expectedBars,
            first: rows[0]?.openTime.toISOString() ?? null,
            last: rows[rows.length - 1]?.openTime.toISOString() ?? null
          }
        },
        null,
        2
      )
    );

    if (windowRows.length === 0) {
      extraLimitations.push(
        `No complete ${symbol} ${interval} candles in analysis window — backfill HISTORY_API before trusting results`
      );
    } else if (windowRows.length < expectedBars * 0.9) {
      extraLimitations.push(
        `Analysis window coverage partial: ${windowRows.length}/${expectedBars} expected 1m bars`
      );
    }

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

    const userId = arg("user-id") ?? null;
    const loaded = await loadStrategiesFromDb(prisma, userId);
    let strategies = loaded.strategies;
    if (loaded.limitation) extraLimitations.push(loaded.limitation);
    if (strategies.length === 0) {
      strategies = defaultStrategiesFromAllowlist(allowlist);
      extraLimitations.push(
        "Using createStrategy + DEFAULT_STRATEGY_PARAMETERS (DB strategy parameters unavailable)"
      );
    }

    const regimeConfig = await prisma.regimeConfiguration.findFirst({ where: { isActive: true } });
    const regimeThresholds = regimeConfig
      ? (regimeConfig.thresholds as unknown as RegimeThresholds)
      : DEFAULT_REGIME_THRESHOLDS;
    if (!regimeConfig) {
      extraLimitations.push("No active RegimeConfiguration — using DEFAULT_REGIME_THRESHOLDS");
    }

    if (usedResearchDefaults) {
      extraLimitations.push(
        `MT5_ENGINE_STRATEGY_ALLOWLIST was empty — using --research-allowlist-defaults: ${allowlist.join(",")}`
      );
    } else if (
      (executionBackend === "broker_demo_mt5" || executionBackend === "broker_real_mt5") &&
      allowlist.length === 0
    ) {
      extraLimitations.push(
        "Empty allowlist with MT5 backend — Pass A/B eligibility will be empty (fail-closed). Pass --allowlist or --research-allowlist-defaults."
      );
    }

    extraLimitations.push(
      "Historical StrategyRegimeMetric / VALIDATED selection scores not loaded — BOOTSTRAP scoring (or VALIDATED→BOOTSTRAP fallback) only"
    );
    extraLimitations.push(
      "Live DecisionLog / production winner history not joined — this is a mechanical replay, not a log reconstruction"
    );

    const report = runAutoSelectionCounterfactualReplay(candles, {
      symbol,
      interval,
      analysisStartMs,
      analysisEndMs,
      selectionMode,
      executionBackend,
      strategyAllowlist: allowlist,
      strategies,
      regimeThresholds
    });
    report.limitations = [...extraLimitations, ...report.limitations];

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = resolve(outDir, `r10_auto_counterfactual_${stamp}.json`);
    const mdPath = resolve(outDir, `r10_auto_counterfactual_${stamp}.md`);
    const latestJson = resolve(outDir, "r10_auto_counterfactual_latest.json");
    const latestMd = resolve(outDir, "r10_auto_counterfactual_latest.md");

    const json = JSON.stringify(report, null, 2);
    const md = formatAutoSelectionReplayMarkdown(report);
    writeFileSync(jsonPath, json);
    writeFileSync(mdPath, md);
    writeFileSync(latestJson, json);
    writeFileSync(latestMd, md);

    console.log(md);
    console.log(
      JSON.stringify(
        {
          wrote: { jsonPath, mdPath, latestJson, latestMd },
          counts: report.counts,
          limitationCount: report.limitations.length
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
