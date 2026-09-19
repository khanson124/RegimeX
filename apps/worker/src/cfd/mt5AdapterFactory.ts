import { type AppConfig } from "@regimex/config";
import {
  DerivMT5BrokerAdapter,
  type DerivMt5BrokerConfig,
  assertLiveMt5Capable,
  assertMt5DemoAdapterAllowed,
  resolveLiveExecutionPolicy,
  resolveMt5BridgeUrlForEnvironment
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
    executionEnvironment: "demo",
    bridgeUrl: resolveMt5BridgeUrlForEnvironment(config, "DEMO"),
    bridgeSecret: config.MT5_BRIDGE_SECRET ?? "",
    timeoutMs: config.MT5_COMMAND_TIMEOUT_MS,
    maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxTestVolume: config.MT5_MAX_TEST_VOLUME,
    maxTestRiskPercent: config.MT5_MAX_TEST_RISK_PERCENT,
    magic: config.MT5_MAGIC_NUMBER,
    expectedBroker: config.MT5_EXPECTED_BROKER,
    expectedServer: config.MT5_EXPECTED_SERVER,
    expectedLogin: config.MT5_EXPECTED_LOGIN,
    expectedEnvironment: "demo"
  };
}

/**
 * Live MT5 broker config. Only callable after server capability gates pass.
 * Uses live volume/risk caps from resolveLiveExecutionPolicy — never demo test caps alone.
 */
export function buildLiveMt5BrokerConfig(config: AppConfig): DerivMt5BrokerConfig {
  assertLiveMt5Capable(config);
  const policy = resolveLiveExecutionPolicy(config);
  return {
    requireDemoAccount: false,
    executionEnvironment: "live",
    bridgeUrl: resolveMt5BridgeUrlForEnvironment(config, "LIVE"),
    bridgeSecret: config.MT5_BRIDGE_SECRET ?? "",
    timeoutMs: config.MT5_COMMAND_TIMEOUT_MS,
    maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxTestVolume: policy.maxLotSize,
    maxTestRiskPercent: policy.maxRiskPerTradePercent,
    magic: config.MT5_MAGIC_NUMBER,
    expectedBroker: policy.expectedBroker ?? config.MT5_LIVE_EXPECTED_BROKER ?? config.MT5_EXPECTED_BROKER,
    expectedServer: policy.expectedServer ?? config.MT5_LIVE_EXPECTED_SERVER ?? config.MT5_EXPECTED_SERVER,
    expectedLogin: policy.expectedLogin ?? config.MT5_LIVE_EXPECTED_LOGIN ?? config.MT5_EXPECTED_LOGIN,
    expectedEnvironment: "live"
  };
}

function adapterMatchesEnvironment(adapter: DerivMT5BrokerAdapter, live: boolean): boolean {
  const status = adapter.getStatus();
  if (!status.connected || !status.eaConnected) return false;
  if (live) {
    return status.isDemo === false && status.tradeMode === "REAL";
  }
  return status.isDemo === true;
}

/**
 * Shared singleton used by LiveEngineSession / Mt5CfdRuntime.
 * Same transport: HttpMt5BridgeClient → mt5-bridge → mailbox → EA.
 */
export async function getOrConnectMt5Adapter(
  config: AppConfig,
  environment?: "DEMO" | "LIVE"
): Promise<DerivMT5BrokerAdapter> {
  const live =
    environment === "LIVE" ||
    (environment == null && config.EXECUTION_MODE === "broker_real_mt5");
  if (sharedAdapter && adapterMatchesEnvironment(sharedAdapter, live)) {
    return sharedAdapter;
  }
  if (sharedAdapter) {
    await sharedAdapter.disconnect().catch(() => undefined);
    sharedAdapter = null;
  }
  const env = live ? ("LIVE" as const) : ("DEMO" as const);
  const bridgeUrl = resolveMt5BridgeUrlForEnvironment(config, env);

  const baseLive = live ? buildLiveMt5BrokerConfig(config) : buildDerivMt5BrokerConfig(config);
  const adapter = new DerivMT5BrokerAdapter({
    ...baseLive,
    bridgeUrl
  });
  await adapter.connect();
  sharedAdapter = adapter;
  return adapter;
}

/**
 * Fresh adapter with the SAME config/transport as the live engine.
 * Prefer this for CLI/research so disconnect() does not tear down the engine singleton.
 */
export async function createConfiguredMt5Adapter(config: AppConfig): Promise<DerivMT5BrokerAdapter> {
  const live = config.EXECUTION_MODE === "broker_real_mt5";
  const adapter = new DerivMT5BrokerAdapter(
    live ? buildLiveMt5BrokerConfig(config) : buildDerivMt5BrokerConfig(config)
  );
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
