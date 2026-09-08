#!/usr/bin/env tsx
/**
 * Discover the DEMO MT5 gold instrument via the SAME transport as R_10:
 * createConfiguredMt5Client → DerivMT5BrokerAdapter → HttpMt5BridgeClient → mt5-bridge → mailbox → EA.
 *
 * Places NO trades. Does NOT enable allowlists / sessions / strategies.
 *
 * Production (inside worker container — inherits Compose MT5 config):
 *
 *   docker compose --env-file .env \
 *     -f docker-compose.yml \
 *     -f docker-compose.prod.yml \
 *     exec -T worker \
 *     pnpm --filter @regimex/worker exec tsx scripts/discoverXauUsdMt5.ts
 *
 * If docker-compose.prod.yml is absent on the host, omit that -f flag.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "@regimex/config";
import {
  XAUUSD_INTERNAL_SYMBOL,
  isTradableGoldDiscovery,
  resolveMt5BridgeUrl,
  selectBestGoldSymbol,
  toDiscoveredGold
} from "@regimex/trading-engine";
import { createConfiguredMt5Client } from "../src/cfd/mt5AdapterFactory.js";
import { researchDatasetPath } from "../src/lib/researchDatasetsPath.js";

const outPath = researchDatasetPath("XAUUSD_mt5_discovery.json");

function loadEnvFile(): void {
  // Optional local fallback only. Inside Docker worker, Compose already injects env —
  // do not require MT5_BRIDGE_URL in host .env (resolveMt5BridgeUrl synthesizes it).
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

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const report: Record<string, unknown> = {
    internalSymbol: XAUUSD_INTERNAL_SYMBOL,
    discoveredAt: new Date().toISOString(),
    status: "PENDING",
    note: "Research/discovery only — not enabled for DEMO trading",
    transport: {
      factory: "createConfiguredMt5Client",
      adapter: "DerivMT5BrokerAdapter",
      client: "HttpMt5BridgeClient",
      resolvedBridgeUrl: resolveMt5BridgeUrl(config),
      mt5BridgeUrlEnvSet: Boolean(config.MT5_BRIDGE_URL),
      mt5BridgeSecretEnvSet: Boolean(config.MT5_BRIDGE_SECRET)
    }
  };

  if (config.MT5_EXPECTED_ENVIRONMENT !== "demo") {
    report.status = "NON_DEMO_ENVIRONMENT_BLOCKED";
    report.blocker = "Discovery refused unless MT5_EXPECTED_ENVIRONMENT=demo";
    persist(report);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  // Same path as live engine — no early MT5_BRIDGE_URL gate.
  // Secret comes from worker env (Compose env_file); URL from resolveMt5BridgeUrl.
  const adapter = await createConfiguredMt5Client(config);

  try {
    const symbols = await adapter.discoverSymbols();
    const gold = selectBestGoldSymbol(symbols);
    if (!gold) {
      report.status = "NO_TRADABLE_GOLD_SYMBOL";
      report.blocker = "No gold/XAUUSD-like symbol found on this DEMO account.";
      report.symbolCount = symbols.length;
      persist(report);
      console.error(JSON.stringify(report, null, 2));
      process.exitCode = 3;
      return;
    }

    const live = await adapter.getLiveSymbol(gold.brokerSymbol);
    const detailed = live ? toDiscoveredGold(live, gold.matchReason) : gold;
    const quote = await adapter.getQuote(gold.brokerSymbol);
    const point = detailed.point > 0 ? detailed.point : null;
    const spreadPoints =
      detailed.spreadPrice != null && point != null ? detailed.spreadPrice / point : null;

    report.status = isTradableGoldDiscovery(detailed) ? "DISCOVERED_TRADABLE" : "DISCOVERED_NOT_TRADABLE";
    report.discovery = {
      ...detailed,
      spreadPoints
    };
    report.liveQuote = quote
      ? {
          brokerSymbol: quote.symbol,
          bid: quote.bid,
          ask: quote.ask,
          mid: (quote.bid + quote.ask) / 2,
          spreadPrice: quote.ask - quote.bid,
          spreadPoints:
            point != null && point > 0 ? (quote.ask - quote.bid) / point : null,
          spreadBps: ((quote.ask - quote.bid) / ((quote.bid + quote.ask) / 2)) * 10_000,
          brokerQuoteTimestampMs: quote.timestamp
        }
      : null;
    report.commandsUsed = ["ping", "getAccount", "getSymbols", "getInstrument", "getQuote"];
    report.readOnly = true;
    report.enablementReminder = {
      mappingVerified: false,
      onAllowlist: false,
      engineEnabled: false,
      tradesPlaced: false,
      sessionStarted: false
    };
    persist(report);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    report.status = "DISCOVERY_FAILED";
    report.error = err instanceof Error ? err.message : String(err);
    persist(report);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    try {
      await adapter.disconnect();
    } catch {
      /* ignore — CLI instance only; does not touch engine singleton */
    }
  }
}

function persist(report: Record<string, unknown>): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

void main();
