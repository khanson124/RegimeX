#!/usr/bin/env tsx
/**
 * Read-only probe: does Deriv ticks_history return gold/XAUUSD candles?
 * Does NOT persist candles or enable trading.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@regimex/config";
import { DerivClient } from "@regimex/trading-engine";

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
  const end = Math.floor(Date.now() / 1000);
  const start = end - 3600;
  const symbols = ["XAUUSD", "frxXAUUSD", "frxXAUUSDc", "GOLD", "cryXAUUSD", "WLDXAU"];
  const results: Record<string, unknown> = {
    probedAt: new Date().toISOString(),
    appId: config.DERIV_APP_ID,
    window: { start, end },
    symbols: {}
  };
  for (const s of symbols) {
    try {
      const candles = await client.getCandleHistory(s, 60, start, end, 50);
      (results.symbols as Record<string, unknown>)[s] = {
        ok: true,
        count: candles.length,
        first: candles[0] ?? null,
        last: candles.at(-1) ?? null
      };
    } catch (e) {
      (results.symbols as Record<string, unknown>)[s] = {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
  // Also probe active_symbols for gold if API supports it
  try {
    const res = await (client as unknown as { send: (p: object) => Promise<Record<string, unknown>> }).send({
      active_symbols: "brief",
      product_type: "basic"
    });
    const active = (res.active_symbols as Array<Record<string, unknown>> | undefined) ?? [];
    const goldish = active
      .filter((a) => {
        const sym = String(a.symbol ?? "");
        const display = String(a.display_name ?? "");
        return /xau|gold/i.test(sym) || /xau|gold/i.test(display);
      })
      .map((a) => ({
        symbol: a.symbol,
        display_name: a.display_name,
        market: a.market,
        underlying_symbol: a.underlying_symbol
      }));
    results.activeGoldLike = goldish;
  } catch (e) {
    results.activeGoldLikeError = e instanceof Error ? e.message : String(e);
  }

  const out = resolve(root, "research-datasets/XAUUSD_deriv_history_probe.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
