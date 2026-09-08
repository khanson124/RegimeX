import { type AppConfig } from "@regimex/config";
import {
  DerivMT5BrokerAdapter,
  type DerivMt5BrokerConfig,
  assertMt5DemoAdapterAllowed,
  resolveMt5BridgeUrl
} from "@regimex/trading-engine";

let sharedAdapter: DerivMT5BrokerAdapter | null = null;

/**
 * Build the exact DerivMT5BrokerConfig the live DEMO engine uses.
 * Bridge URL is resolved via resolveMt5BridgeUrl (MT5_BRIDGE_URL or
 * MT5_BRIDGE_HOST:MT5_BRIDGE_PORT defaulting to http://mt5-bridge:8765).
 * MT5_BRIDGE_URL itself is not required in .env when Compose injects host/URL.
 */
export function buildDerivMt5BrokerConfig(config: AppConfig): DerivMt5BrokerConfig {
  assertMt5DemoAdapterAllowed(config);
  return {
    requireDemoAccount: true,
    bridgeUrl: resolveMt5BridgeUrl(config),
    bridgeSecret: config.MT5_BRIDGE_SECRET ?? "",
    timeoutMs: config.MT5_COMMAND_TIMEOUT_MS,
    maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxTestVolume: config.MT5_MAX_TEST_VOLUME,
    maxTestRiskPercent: config.MT5_MAX_TEST_RISK_PERCENT,
    magic: config.MT5_MAGIC_NUMBER,
    expectedBroker: config.MT5_EXPECTED_BROKER,
    expectedServer: config.MT5_EXPECTED_SERVER,
    expectedLogin: config.MT5_EXPECTED_LOGIN,
    expectedEnvironment: config.MT5_EXPECTED_ENVIRONMENT
  };
}

/**
 * Shared singleton used by LiveEngineSession / Mt5CfdRuntime.
 * Same transport: HttpMt5BridgeClient → mt5-bridge → mailbox → EA.
 */
export async function getOrConnectMt5Adapter(config: AppConfig): Promise<DerivMT5BrokerAdapter> {
  if (sharedAdapter) {
    const status = sharedAdapter.getStatus();
    if (status.connected && status.eaConnected && status.isDemo) return sharedAdapter;
  }
  const adapter = new DerivMT5BrokerAdapter(buildDerivMt5BrokerConfig(config));
  await adapter.connect();
  sharedAdapter = adapter;
  return adapter;
}

/**
 * Fresh adapter with the SAME config/transport as the live engine.
 * Prefer this for CLI/research so disconnect() does not tear down the engine singleton.
 */
export async function createConfiguredMt5Adapter(config: AppConfig): Promise<DerivMT5BrokerAdapter> {
  const adapter = new DerivMT5BrokerAdapter(buildDerivMt5BrokerConfig(config));
  await adapter.connect();
  return adapter;
}

/** Alias documenting the shared “one MT5 client path” for engine + discovery + observation. */
export const createConfiguredMt5Client = createConfiguredMt5Adapter;

export async function disconnectMt5Adapter(): Promise<void> {
  if (sharedAdapter) {
    await sharedAdapter.disconnect();
    sharedAdapter = null;
  }
}

/** Exported for tests — do not use in production paths. */
export function __resetSharedMt5AdapterForTests(): void {
  sharedAdapter = null;
}
