import { type AppConfig } from "@regimex/config";
import {
  DerivCfdBrokerAdapter,
  type BrokerDemoStatus,
  type DerivCfdBrokerConfig
} from "@regimex/trading-engine";

let sharedAdapter: DerivCfdBrokerAdapter | null = null;

export function buildDerivCfdBrokerConfig(config: AppConfig): DerivCfdBrokerConfig {
  return {
    route: "ctrader_open_api",
    requireDemoAccount: true,
    ctraderClientId: config.CTRADER_CLIENT_ID ?? "",
    ctraderClientSecret: config.CTRADER_CLIENT_SECRET ?? "",
    ctraderAccountId: config.CTRADER_ACCOUNT_ID ?? "",
    accessToken: config.CTRADER_ACCESS_TOKEN ?? "",
    environment: config.CTRADER_ENVIRONMENT ?? "demo",
    host: config.CTRADER_HOST,
    port: config.CTRADER_PORT,
    maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxVolumeLots: config.BROKER_DEMO_MAX_VOLUME,
    maxRiskPercent: config.BROKER_DEMO_MAX_RISK_PERCENT,
    moneyScale: config.CTRADER_MONEY_SCALE
  };
}

/**
 * Process-wide shared adapter for broker_demo_cfd status / guarded test trades.
 * Engine automation remains gated by BROKER_DEMO_ENGINE_ENABLED.
 */
export async function getOrConnectBrokerDemoAdapter(
  config: AppConfig
): Promise<DerivCfdBrokerAdapter> {
  if (sharedAdapter) {
    const status = sharedAdapter.getStatus();
    if (status.connected && status.accountAuthed) return sharedAdapter;
  }
  const adapter = new DerivCfdBrokerAdapter(buildDerivCfdBrokerConfig(config));
  await adapter.connect();
  sharedAdapter = adapter;
  return adapter;
}

export function getBrokerDemoStatusOrNull(): BrokerDemoStatus | null {
  return sharedAdapter?.getStatus() ?? null;
}

export async function disconnectBrokerDemoAdapter(): Promise<void> {
  if (sharedAdapter) {
    await sharedAdapter.disconnect();
    sharedAdapter = null;
  }
}
