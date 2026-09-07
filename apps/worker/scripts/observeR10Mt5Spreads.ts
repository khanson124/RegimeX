#!/usr/bin/env tsx
/**
 * Research-only observation mode: poll R_10 MT5 DEMO quotes and record spread samples.
 * Places NO trades. Changes NO strategy/lifecycle/risk state.
 *
 *   pnpm --filter @regimex/worker exec tsx scripts/observeR10Mt5Spreads.ts --duration-sec 120
 *
 * Requires MT5 bridge env (MT5_BRIDGE_URL / secret) and DEMO expected environment.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@regimex/config";
import { DerivMT5BrokerAdapter, Mt5PassiveSpreadSampler } from "@regimex/trading-engine";
import { buildDerivMt5BrokerConfig } from "../src/cfd/mt5AdapterFactory.js";

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
    throw new Error("Observation mode refuses non-demo MT5_EXPECTED_ENVIRONMENT");
  }

  const symbol = arg("symbol") ?? "R_10";
  const brokerSymbol = arg("broker-symbol") ?? "Volatility 10 Index";
  const durationSec = Number(arg("duration-sec") ?? 120);
  const pollMs = Number(arg("poll-ms") ?? 2000);
  const sampleMs = Number(arg("sample-ms") ?? config.MT5_PASSIVE_SPREAD_SAMPLE_MS ?? 60_000);
  const outPath =
    arg("out") ??
    resolve(process.cwd(), `../../research-datasets/${symbol}_mt5_passive_spread_samples.jsonl`);

  const sampler = new Mt5PassiveSpreadSampler({
    symbol,
    intervalMs: sampleMs,
    outPath,
    source: "MT5_OBSERVATION_CLI"
  });

  const bridgeCfg = buildDerivMt5BrokerConfig(config);
  const adapter = new DerivMT5BrokerAdapter(bridgeCfg);

  console.log(
    JSON.stringify(
      {
        action: "observe-r10-mt5-spreads",
        symbol,
        brokerSymbol,
        durationSec,
        pollMs,
        sampleMs,
        outPath,
        placesTrades: false,
        demoOnly: true
      },
      null,
      2
    )
  );

  await adapter.connect();
  const started = Date.now();
  let polls = 0;
  try {
    while (Date.now() - started < durationSec * 1000) {
      polls++;
      const quote = await adapter.getQuote(brokerSymbol);
      if (quote) {
        const sample = sampler.maybeSample({
          bid: quote.bid,
          ask: quote.ask,
          brokerQuoteTimestampMs: quote.timestamp,
          localReceivedAtMs: Date.now()
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
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }

  console.log(
    JSON.stringify({
      done: true,
      polls,
      persistedSamples: sampler.persistedCount,
      outPath
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
