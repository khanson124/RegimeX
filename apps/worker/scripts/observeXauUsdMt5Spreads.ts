#!/usr/bin/env tsx
/**
 * Forward-only XAUUSD spread observation via the SAME MT5 client as R_10.
 * Places NO trades. Does NOT enable strategies / allowlists / sessions.
 *
 *   docker compose --env-file .env \
 *     -f docker-compose.yml \
 *     -f docker-compose.prod.yml \
 *     exec -T worker \
 *     pnpm --filter @regimex/worker exec tsx scripts/observeXauUsdMt5Spreads.ts --duration-sec 120
 *
 * Writes: /app/research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl
 * (host bind mount → research-datasets/XAUUSD_mt5_passive_spread_samples.jsonl)
 */
import { readFileSync, existsSync } from "node:fs";
import { loadConfig } from "@regimex/config";
import {
  Mt5PassiveSpreadSampler,
  XAUUSD_INTERNAL_SYMBOL,
  resolveMt5BridgeUrl,
  selectBestGoldSymbol
} from "@regimex/trading-engine";
import { createConfiguredMt5Client } from "../src/cfd/mt5AdapterFactory.js";
import { researchDatasetPath } from "../src/lib/researchDatasetsPath.js";

function loadEnvFile(): void {
  for (const path of [
    "/app/.env",
    process.cwd() + "/.env",
    process.cwd() + "/../../.env",
    process.cwd() + "/../../../.env"
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

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  if (config.MT5_EXPECTED_ENVIRONMENT !== "demo") {
    throw new Error("Observation refused unless MT5_EXPECTED_ENVIRONMENT=demo");
  }

  const durationSec = Number(arg("duration-sec") ?? 120);
  const pollMs = Number(arg("poll-ms") ?? 2000);
  const sampleMs = Number(arg("sample-ms") ?? config.MT5_PASSIVE_SPREAD_SAMPLE_MS ?? 60_000);
  const outPath = arg("out") ?? researchDatasetPath(`${XAUUSD_INTERNAL_SYMBOL}_mt5_passive_spread_samples.jsonl`);

  const adapter = await createConfiguredMt5Client(config);
  try {
    let brokerSymbol = arg("broker-symbol");
    if (!brokerSymbol) {
      const symbols = await adapter.discoverSymbols();
      const gold = selectBestGoldSymbol(symbols);
      if (!gold) throw new Error("No gold symbol discovered — pass --broker-symbol after discovery");
      brokerSymbol = gold.brokerSymbol;
    }

    const live = await adapter.getLiveSymbol(brokerSymbol);
    const sampler = new Mt5PassiveSpreadSampler({
      symbol: XAUUSD_INTERNAL_SYMBOL,
      intervalMs: sampleMs,
      outPath,
      tickSize: live?.tickSize ?? 0.01,
      source: "MT5_OBSERVATION_CLI"
    });

    console.log(
      JSON.stringify(
        {
          action: "observe-xauusd-mt5-spreads",
          internalSymbol: XAUUSD_INTERNAL_SYMBOL,
          brokerSymbol,
          durationSec,
          pollMs,
          sampleMs,
          outPath,
          placesTrades: false,
          readOnly: true,
          factory: "createConfiguredMt5Client",
          resolvedBridgeUrl: resolveMt5BridgeUrl(config),
          note: "Does not write to R_10_mt5_passive_spread_samples.jsonl"
        },
        null,
        2
      )
    );

    const started = Date.now();
    let polls = 0;
    while (Date.now() - started < durationSec * 1000) {
      polls++;
      const quote = await adapter.getQuote(brokerSymbol);
      if (quote) {
        const sample = sampler.maybeSample({
          bid: quote.bid,
          ask: quote.ask,
          brokerQuoteTimestampMs: quote.timestamp,
          localReceivedAtMs: Date.now(),
          nowMs: Date.now()
        });
        if (sample) {
          console.log(
            JSON.stringify({
              sampled: true,
              spreadBps: sample.spreadBps,
              bid: sample.bid,
              ask: sample.ask,
              persistedCount: sampler.persistedCount
            })
          );
        }
      } else {
        console.log(JSON.stringify({ sampled: false, reason: "NO_QUOTE" }));
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    console.log(
      JSON.stringify({
        done: true,
        polls,
        persistedSamples: sampler.persistedCount,
        outPath,
        placesTrades: false
      })
    );
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
