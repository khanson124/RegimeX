#!/usr/bin/env tsx
/** Dry-run: how much frxXAUUSD 1m history can Deriv return over a multi-month window? */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@regimex/config";
import {
  DerivClient,
  DERIV_CANDLE_HISTORY_MAX_CANDLES,
  nextBackfillCursorMs
} from "@regimex/trading-engine";
import { intervalMs } from "@regimex/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");

function loadEnvFile(): void {
  for (const path of [resolve(root, ".env"), resolve(process.cwd(), "../../.env")]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const client = new DerivClient({
    wsUrl: config.DERIV_WS_URL,
    appId: config.DERIV_APP_ID,
    restUrl: config.DERIV_REST_URL
  });
  await client.connect();

  const apiSymbol = "frxXAUUSD";
  const fromMs = Date.parse("2025-09-01T00:00:00.000Z");
  const toMs = Date.now();
  const step = intervalMs("1m");
  let cursor = fromMs;
  let fetched = 0;
  let batches = 0;
  let first: number | null = null;
  let last: number | null = null;
  const weekendGaps: number[] = [];
  let prevOpen: number | null = null;

  while (cursor < toMs && batches < 500) {
    const batchEnd = Math.min(cursor + DERIV_CANDLE_HISTORY_MAX_CANDLES * step, toMs);
    const candles = await client.getCandleHistory(
      apiSymbol,
      60,
      Math.floor(cursor / 1000),
      Math.floor(batchEnd / 1000),
      DERIV_CANDLE_HISTORY_MAX_CANDLES
    );
    batches++;
    if (candles.length === 0) {
      cursor = batchEnd;
      continue;
    }
    const opens = candles.map((c) => c.openTimeMs);
    if (first == null) first = Math.min(...opens);
    last = Math.max(...opens);
    fetched += candles.length;
    for (const c of candles) {
      if (prevOpen != null) {
        const gap = c.openTimeMs - prevOpen;
        if (gap > 2 * step) weekendGaps.push(gap);
      }
      prevOpen = c.openTimeMs;
    }
    const { nextCursorMs } = nextBackfillCursorMs({
      cursorMs: cursor,
      batchEndMs: batchEnd,
      stepMs: step,
      fetchedOpenTimesMs: opens
    });
    cursor = nextCursorMs;
    if (batches % 20 === 0) {
      console.error(JSON.stringify({ batches, fetched, cursor: new Date(cursor).toISOString() }));
    }
  }

  const report = {
    apiSymbol,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    batches,
    fetched,
    firstIso: first != null ? new Date(first).toISOString() : null,
    lastIso: last != null ? new Date(last).toISOString() : null,
    gapCountGt2m: weekendGaps.length,
    longestGapHours: weekendGaps.length
      ? Math.max(...weekendGaps) / 3_600_000
      : 0,
    note: "Dry inventory only — not persisted"
  };
  const out = resolve(root, "research-datasets/XAUUSD_frx_history_inventory.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
