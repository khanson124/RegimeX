import { type AppConfig } from "./index.js";

/** Per-session copy. Selecting a venue never enables REAL flags, arms trading or changes limits. */
export function resolveMt5EnvironmentConfig(config: AppConfig, environment: "DEMO" | "LIVE" | null): AppConfig {
  if (environment == null || !["broker_demo_mt5", "broker_real_mt5"].includes(config.EXECUTION_MODE)) return config;
  if (environment === "DEMO") return { ...config, EXECUTION_MODE: "broker_demo_mt5",
    MT5_EXPECTED_ENVIRONMENT: "demo", MT5_BRIDGE_URL: config.MT5_DEMO_BRIDGE_URL ?? config.MT5_BRIDGE_URL };
  return { ...config, EXECUTION_MODE: "broker_real_mt5", MT5_EXPECTED_ENVIRONMENT: "live",
    MT5_BRIDGE_URL: config.MT5_LIVE_BRIDGE_URL ?? config.MT5_BRIDGE_URL,
    MT5_EXPECTED_BROKER: config.MT5_LIVE_EXPECTED_BROKER ?? config.MT5_EXPECTED_BROKER,
    MT5_EXPECTED_SERVER: config.MT5_LIVE_EXPECTED_SERVER ?? config.MT5_EXPECTED_SERVER,
    MT5_EXPECTED_LOGIN: config.MT5_LIVE_EXPECTED_LOGIN ?? config.MT5_EXPECTED_LOGIN };
}
