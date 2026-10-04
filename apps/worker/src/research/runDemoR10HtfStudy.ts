import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient, type Prisma } from "@regimex/database";
import type { Candle } from "@regimex/shared";
import { assessDemoR10HtfShadow, DEMO_R10_HTF_HISTORY_LIMIT } from "../engine/demoR10HtfShadow.js";
import { isDemoR10StudyTrade, summarizeHtfStudy, type StudyObservation, type StudyTrade } from "./demoR10HtfStudy.js";

// Dedicated research process: imports no engine, broker or Redis control capabilities.
if (process.env.MT5_DEMO_R10_HTF_SHADOW_ENABLED !== "true" || process.env.EXECUTION_MODE !== "broker_demo_mt5") {
  throw new Error("DEMO HTF research must be explicitly enabled with broker_demo_mt5 scope");
}
const from = new Date(process.env.R10_HTF_STUDY_FROM ?? "");
if (!Number.isFinite(from.getTime())) throw new Error("R10_HTF_STUDY_FROM must be a valid fixed timestamp");
const dir = process.env.R10_HTF_STUDY_DIR;
if (!dir) throw new Error("R10_HTF_STUDY_DIR is required");
const manifest = { studyVersion: 1, from: from.toISOString(), maxPositions: 200, model: "UTC_COMPLETED_EMA_8_21_LAST_21",
  sourceCommit: process.env.R10_HTF_STUDY_COMMIT ?? "unknown", scope: "R_10/1m/ENGINE/broker_demo_mt5", observationalOnly: true };
await mkdir(dir, { recursive: true });
const manifestPath = join(dir, "manifest.json");
try {
  const existing = JSON.parse(await readFile(manifestPath, "utf8"));
  if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error("Study manifest mismatch; use a new directory");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}
const observationPath = join(dir, "observations.jsonl");
const observations: StudyObservation[] = [];
try {
  for (const line of (await readFile(observationPath, "utf8")).split("\n").filter(Boolean)) observations.push(JSON.parse(line));
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const assessed = new Set(observations.map(o => o.positionId));
const prisma = new PrismaClient();
const once = process.argv.includes("--once");
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopping = true; wake?.(); });
const select = { id: true, symbol: true, interval: true, origin: true, direction: true, strategyId: true, strategyVersion: true,
  signalId: true, status: true, realizedPnl: true, closeReason: true, metadata: true,
  signal: { select: { signalTime: true, correlationId: true, strategyId: true, action: true } } } satisfies Prisma.PositionSelect;
console.log(JSON.stringify({ event: "R10_HTF_STUDY_STARTED", ...manifest, resumedObservations: assessed.size }));
try {
  while (!stopping) {
    try {
      const batch = await prisma.$transaction(async tx => {
        // Enforced by PostgreSQL: all queries in this process are inside read-only transactions.
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
        const rows = await tx.position.findMany({ where: { symbol: "R_10", interval: "1m", origin: "ENGINE",
          createdAt: { gte: from }, ...(assessed.size >= manifest.maxPositions ? { id: { in: [...assessed] } } : {}), status: { in: ["OPEN", "CLOSED"] },
          metadata: { path: ["executionModel"], equals: "broker_demo_mt5" } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: manifest.maxPositions, select });
        const trades: StudyTrade[] = rows.map(row => ({ ...row, realizedPnl: row.realizedPnl == null ? null : Number(row.realizedPnl) }));
        const fresh: StudyObservation[] = [];
        for (const row of rows.filter(r => !assessed.has(r.id)).slice(0, Math.min(5, manifest.maxPositions - assessed.size))) {
          if (!row.signal || !isDemoR10StudyTrade({ ...row, realizedPnl: null }) || row.signal.action !== row.direction || row.signal.strategyId !== row.strategyId) continue;
          const cutoff = row.signal.signalTime.getTime();
          const history = await tx.candle.findMany({ where: { symbol: { derivSymbol: "R_10" }, interval: "1m", isComplete: true,
            source: { in: ["MT5_HISTORY", "MT5_LIVE_TICKS"] },
            openTime: { gte: new Date(cutoff - DEMO_R10_HTF_HISTORY_LIMIT * 60_000) }, closeTime: { lte: new Date(cutoff) } },
            orderBy: { openTime: "desc" }, take: DEMO_R10_HTF_HISTORY_LIMIT });
          const candles: Candle[] = history.map(c => ({ symbol: "R_10", interval: "1m", openTime: c.openTime.getTime(),
            closeTime: c.closeTime.getTime(), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
            isComplete: c.isComplete, tickCount: c.tickCount, source: c.source as Candle["source"] }));
          const assessment = assessDemoR10HtfShadow({ enabled: true, executionBackend: "broker_demo_mt5", mode: "DEMO_TRADING",
            symbol: row.symbol, interval: row.interval!, action: row.direction, strategyId: row.strategyId,
            signalId: row.signalId!, correlationId: row.signal.correlationId, decisionCloseTimeMs: cutoff }, candles)!;
          const meta = row.metadata as Record<string, unknown>;
          fresh.push({ positionId: row.id, strategyVersion: row.strategyVersion, assessedAt: new Date().toISOString(),
            demoLossBypass: meta.demoLossBypass ?? null, demoTradeExperiment: meta.demoTradeExperiment ?? null, assessment });
        }
        return { trades, fresh };
      }, { timeout: 15_000, maxWait: 3000 });
      for (const observation of batch.fresh) {
        await appendFile(observationPath, JSON.stringify(observation) + "\n");
        observations.push(observation); assessed.add(observation.positionId);
        console.log(JSON.stringify({ event: "R10_HTF_STUDY_OBSERVATION", ...observation }));
      }
      const summary = { ...manifest, updatedAt: new Date().toISOString(), ...summarizeHtfStudy(batch.trades, observations) };
      await writeFile(join(dir, "summary.json.tmp"), JSON.stringify(summary, null, 2) + "\n");
      await rename(join(dir, "summary.json.tmp"), join(dir, "summary.json"));
      console.log(JSON.stringify({ event: "R10_HTF_STUDY_HEARTBEAT", observed: assessed.size, closed: summary.closedPositions,
        open: summary.openPositions, comparisonCoverage: summary.comparisons.map(c => ({ interval: c.interval, covered: c.coveredClosedTrades })) }));
    } catch {
      if (once) process.exitCode = 1;
      // Never print credentials/connection strings contained in Prisma error messages.
      console.error(JSON.stringify({ event: "R10_HTF_STUDY_RETRY", reason: "READ_OR_ARTIFACT_WRITE_FAILED" }));
    }
    if (once) break;
    if (!stopping) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, 30_000);
      wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    });
  }
} finally { await prisma.$disconnect(); }
console.log(JSON.stringify({ event: "R10_HTF_STUDY_STOPPED" }));
