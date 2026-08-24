import { type AppConfig } from "@regimex/config";
import {
  DerivMT5BrokerAdapter,
  type DerivMt5BrokerConfig,
  resolveMt5BridgeUrl
} from "@regimex/trading-engine";

let sharedAdapter: DerivMT5BrokerAdapter | null = null;

export function buildDerivMt5BrokerConfig(config: AppConfig): DerivMt5BrokerConfig {
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

export async function disconnectMt5Adapter(): Promise<void> {
  if (sharedAdapter) {
    await sharedAdapter.disconnect();
    sharedAdapter = null;
  }
}
