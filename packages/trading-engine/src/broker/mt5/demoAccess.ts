import { type ExecutionBackend } from "../../execution/executionMode.js";
import { describeMt5AutonomousAvailability, publicMt5RolloutSnapshot } from "./engineRollout.js";

export const REAL_MT5_NOT_IMPLEMENTED = "REAL_MT5_EXECUTION_NOT_IMPLEMENTED";
export const MT5_ENGINE_DISABLED = "MT5_ENGINE_DISABLED";

export interface Mt5AccessConfig {
  EXECUTION_MODE: ExecutionBackend | string;
  REAL_MONEY_ENABLED: boolean;
  MT5_ENGINE_ENABLED?: boolean;
  MT5_TEST_MODE?: boolean;
  MT5_BRIDGE_URL?: string | null;
  MT5_BRIDGE_HOST?: string | null;
  MT5_BRIDGE_PORT?: number | null;
  MT5_EXPECTED_BROKER?: string | null;
  MT5_EXPECTED_ENVIRONMENT?: "demo" | "live" | string | null;
  MT5_EXPECTED_SERVER?: string | null;
  MT5_MAGIC_NUMBER?: number | null;
  MT5_MAX_TEST_VOLUME?: number | null;
  MT5_MAX_TEST_RISK_PERCENT?: number | null;
  STRATEGY_SELECTION_MODE?: string | null;
  MT5_ENGINE_SYMBOL_ALLOWLIST?: string | null;
  MT5_ENGINE_STRATEGY_ALLOWLIST?: string | null;
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS?: number | null;
}

/** Real MT5 / real-money paths are architecture-only. Never construct a demo adapter for them. */
export function isMt5RealPath(config: Pick<Mt5AccessConfig, "EXECUTION_MODE" | "REAL_MONEY_ENABLED">): boolean {
  return config.EXECUTION_MODE === "broker_real_mt5" || config.REAL_MONEY_ENABLED === true;
}

export function assertMt5DemoAdapterAllowed(
  config: Pick<Mt5AccessConfig, "EXECUTION_MODE" | "REAL_MONEY_ENABLED">
): void {
  if (isMt5RealPath(config)) {
    throw new Error(REAL_MT5_NOT_IMPLEMENTED);
  }
}

/** Status / symbols / preflight / guarded TEST APIs. Does not enable engine orders. */
export function isMt5DemoApiEnabled(config: Mt5AccessConfig): boolean {
  if (isMt5RealPath(config)) return false;
  return config.EXECUTION_MODE === "broker_demo_mt5" || config.MT5_TEST_MODE === true;
}

/**
 * Automated strategy → MT5 DEMO. Requires broker_demo_mt5 AND the engine flag.
 * MT5_TEST_MODE alone never enables engine orders.
 */
export function isMt5EngineAutomationEnabled(config: Mt5AccessConfig): boolean {
  if (isMt5RealPath(config)) return false;
  return config.EXECUTION_MODE === "broker_demo_mt5" && config.MT5_ENGINE_ENABLED === true;
}

export function gateMt5EngineOrders(config: Mt5AccessConfig): {
  allowed: boolean;
  reason: string | null;
} {
  if (isMt5RealPath(config)) {
    return { allowed: false, reason: REAL_MT5_NOT_IMPLEMENTED };
  }
  if (config.EXECUTION_MODE !== "broker_demo_mt5") {
    return { allowed: false, reason: "MT5_NOT_ACTIVE_EXECUTION_MODE" };
  }
  if (!config.MT5_ENGINE_ENABLED) {
    return { allowed: false, reason: MT5_ENGINE_DISABLED };
  }
  return { allowed: true, reason: null };
}

/** Non-secret diagnostics for /broker-demo/mt5/status. Never include secrets. */
export function publicMt5ConfigSnapshot(config: Mt5AccessConfig): {
  executionMode: string;
  realMoneyEnabled: boolean;
  mt5TestMode: boolean;
  mt5EngineEnabled: boolean;
  engineAutomationEnabled: boolean;
  mt5ApiEnabled: boolean;
  expectedBroker: string | null;
  expectedEnvironment: string | null;
  expectedServer: string | null;
  magicNumber: number | null;
  maxTestVolume: number | null;
  maxTestRiskPercent: number | null;
  bridgeHost: string | null;
  strategySelectionMode: string | null;
  rollout: ReturnType<typeof publicMt5RolloutSnapshot>;
  autonomous: ReturnType<typeof describeMt5AutonomousAvailability>;
} {
  const bridgeHost = (() => {
    if (config.MT5_BRIDGE_URL) {
      try {
        return new URL(config.MT5_BRIDGE_URL).host;
      } catch {
        return "invalid-url";
      }
    }
    if (config.MT5_BRIDGE_HOST) {
      return `${config.MT5_BRIDGE_HOST}:${config.MT5_BRIDGE_PORT ?? 8765}`;
    }
    return null;
  })();

  return {
    executionMode: String(config.EXECUTION_MODE),
    realMoneyEnabled: config.REAL_MONEY_ENABLED === true,
    mt5TestMode: config.MT5_TEST_MODE === true,
    mt5EngineEnabled: config.MT5_ENGINE_ENABLED === true,
    engineAutomationEnabled: isMt5EngineAutomationEnabled(config),
    mt5ApiEnabled: isMt5DemoApiEnabled(config),
    expectedBroker: config.MT5_EXPECTED_BROKER ?? null,
    expectedEnvironment: config.MT5_EXPECTED_ENVIRONMENT ?? null,
    expectedServer: config.MT5_EXPECTED_SERVER ?? null,
    magicNumber: config.MT5_MAGIC_NUMBER ?? null,
    maxTestVolume: config.MT5_MAX_TEST_VOLUME ?? null,
    maxTestRiskPercent: config.MT5_MAX_TEST_RISK_PERCENT ?? null,
    bridgeHost,
    strategySelectionMode: config.STRATEGY_SELECTION_MODE ?? null,
    rollout: publicMt5RolloutSnapshot(config),
    autonomous: describeMt5AutonomousAvailability(config)
  };
}

export function buildMt5StatusEnvelope(
  config: Mt5AccessConfig,
  live?: {
    connected?: boolean;
    eaConnected?: boolean;
    isDemo?: boolean;
    tradeMode?: string | null;
    marginMode?: string | null;
    login?: string | null;
    company?: string | null;
    server?: string | null;
    leverage?: number | null;
    currency?: string | null;
    account?: unknown;
    lastError?: string | null;
    openPositions?: unknown[];
  } | null,
  error?: string | null
): { status: Record<string, unknown> } {
  const snapshot = publicMt5ConfigSnapshot(config);

  if (isMt5RealPath(config)) {
    return {
      status: {
        mode: config.EXECUTION_MODE,
        enabled: false,
        connected: false,
        engineAutomationEnabled: false,
        error: REAL_MT5_NOT_IMPLEMENTED,
        config: snapshot
      }
    };
  }

  if (!isMt5DemoApiEnabled(config)) {
    return {
      status: {
        mode: config.EXECUTION_MODE,
        enabled: false,
        connected: false,
        engineAutomationEnabled: false,
        message:
          "MT5 DEMO APIs idle. Set EXECUTION_MODE=broker_demo_mt5 (primary) or MT5_TEST_MODE=true. paper_cfd remains the local/dev fallback.",
        config: snapshot
      }
    };
  }

  return {
    status: {
      mode: config.EXECUTION_MODE,
      enabled: true,
      demo: live?.isDemo ?? live?.tradeMode === "DEMO",
      isDemo: live?.isDemo ?? live?.tradeMode === "DEMO",
      testMode: snapshot.mt5TestMode,
      connected: live?.connected ?? false,
      eaConnected: live?.eaConnected ?? false,
      tradeMode: live?.tradeMode ?? null,
      marginMode: live?.marginMode ?? null,
      login: live?.login ?? null,
      company: live?.company ?? null,
      server: live?.server ?? null,
      leverage: live?.leverage ?? null,
      currency: live?.currency ?? null,
      account: live?.account ?? null,
      lastError: live?.lastError ?? null,
      engineAutomationEnabled: snapshot.engineAutomationEnabled,
      openPositions: live?.openPositions ?? [],
      error: error ?? null,
      config: snapshot
    }
  };
}
