import { type ExecutionBackend } from "../../execution/executionMode.js";
import { describeMt5AutonomousAvailability, publicMt5RolloutSnapshot } from "./engineRollout.js";
import { type BrokerSymbolMappingRecord } from "./brokerSymbolMapping.js";
import { type Mt5BridgeCircuitSnapshot } from "./bridgeCircuit.js";
import {
  publicLiveCapabilitySnapshot,
  resolveLiveTradingCapability,
  type LiveMt5CapabilityConfig
} from "./liveMt5Policy.js";

export const REAL_MT5_NOT_IMPLEMENTED = "REAL_MT5_EXECUTION_NOT_IMPLEMENTED";
export const MT5_ENGINE_DISABLED = "MT5_ENGINE_DISABLED";

export interface Mt5AccessConfig extends Partial<LiveMt5CapabilityConfig> {
  EXECUTION_MODE: ExecutionBackend | string;
  REAL_MONEY_ENABLED: boolean;
  LIVE_MT5_ENABLED?: boolean;
  LIVE_TRADING_ENABLED?: boolean;
  MT5_ENGINE_ENABLED?: boolean;
  MT5_TEST_MODE?: boolean;
  MT5_BRIDGE_URL?: string | null;
  MT5_BRIDGE_HOST?: string | null;
  MT5_BRIDGE_PORT?: number | null;
  MT5_EXPECTED_BROKER?: string | null;
  MT5_EXPECTED_ENVIRONMENT?: "demo" | "live" | null;
  MT5_EXPECTED_SERVER?: string | null;
  MT5_MAGIC_NUMBER?: number | null;
  MT5_MAX_TEST_VOLUME?: number | null;
  MT5_MAX_TEST_RISK_PERCENT?: number | null;
  STRATEGY_SELECTION_MODE?: string | null;
  MT5_ENGINE_SYMBOL_ALLOWLIST?: string | null;
  MT5_ENGINE_STRATEGY_ALLOWLIST?: string | null;
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS?: number | null;
  MT5_ENGINE_MAX_VOLUME?: number | null;
  MT5_ENGINE_MAX_RISK_PERCENT?: number | null;
}

/**
 * True when EXECUTION_MODE selects the live MT5 backend.
 * REAL_MONEY_ENABLED alone does NOT mark the path as live.
 */
export function isMt5RealPath(config: Pick<Mt5AccessConfig, "EXECUTION_MODE">): boolean {
  return config.EXECUTION_MODE === "broker_real_mt5";
}

/** Demo adapter construction is refused for broker_real_mt5. */
export function assertMt5DemoAdapterAllowed(
  config: Pick<Mt5AccessConfig, "EXECUTION_MODE">
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
    const cap = resolveLiveTradingCapability(config);
    if (!cap.liveTradingSupported) {
      return { allowed: false, reason: REAL_MT5_NOT_IMPLEMENTED };
    }
    if (!config.MT5_ENGINE_ENABLED) {
      return { allowed: false, reason: MT5_ENGINE_DISABLED };
    }
    return { allowed: true, reason: null };
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
export function publicMt5ConfigSnapshot(
  config: Mt5AccessConfig,
  mappings: BrokerSymbolMappingRecord[] = [],
  persistedArmed = false
): Record<string, unknown> {
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

  const live = publicLiveCapabilitySnapshot(
    {
      REAL_MONEY_ENABLED: Boolean(config.REAL_MONEY_ENABLED),
      LIVE_MT5_ENABLED: Boolean(config.LIVE_MT5_ENABLED),
      LIVE_ALLOWED_SYMBOLS: config.LIVE_ALLOWED_SYMBOLS,
      LIVE_MAX_CONCURRENT_POSITIONS: config.LIVE_MAX_CONCURRENT_POSITIONS,
      LIVE_MAX_RISK_PER_TRADE_PERCENT: config.LIVE_MAX_RISK_PER_TRADE_PERCENT,
      LIVE_MAX_DAILY_LOSS: config.LIVE_MAX_DAILY_LOSS,
      LIVE_MAX_LOT_SIZE: config.LIVE_MAX_LOT_SIZE,
      LIVE_SMOKE_TEST_MODE: config.LIVE_SMOKE_TEST_MODE,
      MT5_BRIDGE_SECRET: config.MT5_BRIDGE_SECRET,
      MT5_BRIDGE_URL: config.MT5_BRIDGE_URL,
      MT5_BRIDGE_HOST: config.MT5_BRIDGE_HOST,
      MT5_EXPECTED_ENVIRONMENT: config.MT5_EXPECTED_ENVIRONMENT,
      MT5_EXPECTED_BROKER: config.MT5_EXPECTED_BROKER,
      MT5_EXPECTED_SERVER: config.MT5_EXPECTED_SERVER,
      MT5_EXPECTED_LOGIN: config.MT5_EXPECTED_LOGIN
    },
    persistedArmed
  );

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
    rollout: publicMt5RolloutSnapshot(config, mappings),
    autonomous: describeMt5AutonomousAvailability(config, mappings),
    ...live
  };
}

export type Mt5BridgeReachability = "online" | "unhealthy" | "offline";
export type Mt5EaReachability = "online" | "offline" | "unknown";
export type Mt5ReconciliationFreshness = "fresh" | "stale" | "unknown";

export interface Mt5LinkHealth {
  bridge: Mt5BridgeReachability;
  ea: Mt5EaReachability;
  reconciliation: Mt5ReconciliationFreshness;
  circuit: Mt5BridgeCircuitSnapshot | null;
  lastBridgeSuccessAt: number | null;
  lastEaSuccessAt: number | null;
  executionBlockReason: string | null;
  ready: boolean;
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
  error?: string | null,
  mappings: BrokerSymbolMappingRecord[] = [],
  health?: Mt5LinkHealth | null
): { status: Record<string, unknown> } {
  const snapshot = publicMt5ConfigSnapshot(config, mappings);
  const liveCap = resolveLiveTradingCapability(config);

  if (isMt5RealPath(config) && !liveCap.liveTradingSupported) {
    return {
      status: {
        mode: config.EXECUTION_MODE,
        enabled: false,
        connected: false,
        engineAutomationEnabled: false,
        error: REAL_MT5_NOT_IMPLEMENTED,
        liveTradingSupported: false,
        liveTradingEnabled: false,
        realMoneyEnabled: liveCap.realMoneyEnabled,
        config: snapshot,
        bridge: "offline",
        ea: "unknown",
        reconciliation: "unknown",
        ready: false
      }
    };
  }

  if (isMt5RealPath(config) && liveCap.liveTradingSupported) {
    const bridge = health?.bridge ?? (live?.connected ? "online" : "offline");
    const httpLive = bridge === "online";
    const ea = health?.ea ?? (live?.eaConnected ? "online" : live?.connected ? "offline" : "unknown");
    const ready = httpLive && Boolean(health?.ready ?? live?.connected);
    return {
      status: {
        mode: config.EXECUTION_MODE,
        enabled: true,
        demo: false,
        isDemo: false,
        environment: "live",
        liveTradingSupported: true,
        liveTradingEnabled: liveCap.liveTradingEnabled,
        realMoneyEnabled: true,
        testMode: false,
        connected: httpLive,
        eaConnected: ea === "online",
        tradeMode: live?.tradeMode ?? null,
        marginMode: live?.marginMode ?? null,
        login: live?.login ?? null,
        company: live?.company ?? null,
        server: live?.server ?? null,
        leverage: live?.leverage ?? null,
        currency: live?.currency ?? null,
        account: live?.account ?? null,
        lastError: live?.lastError ?? error ?? null,
        engineAutomationEnabled: Boolean(config.MT5_ENGINE_ENABLED),
        openPositions: live?.openPositions ?? [],
        error: error ?? null,
        config: snapshot,
        bridge,
        ea,
        reconciliation: health?.reconciliation ?? "unknown",
        circuitState: health?.circuit?.circuitState ?? null,
        consecutiveFailures: health?.circuit?.consecutiveFailures ?? 0,
        lastBridgeSuccessAt: health?.lastBridgeSuccessAt ?? health?.circuit?.lastSuccessAt ?? null,
        lastEaSuccessAt: health?.lastEaSuccessAt ?? null,
        nextProbeAt: health?.circuit?.nextProbeAt ?? null,
        executionBlockReason: health?.executionBlockReason ?? error ?? null,
        ready
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
        liveTradingSupported: liveCap.liveTradingSupported,
        liveTradingEnabled: liveCap.liveTradingEnabled,
        realMoneyEnabled: liveCap.realMoneyEnabled,
        message:
          "MT5 DEMO APIs idle. Set EXECUTION_MODE=broker_demo_mt5 (primary) or MT5_TEST_MODE=true. paper_cfd remains the local/dev fallback.",
        config: snapshot,
        bridge: "offline",
        ea: "unknown",
        reconciliation: "unknown",
        ready: false
      }
    };
  }

  const bridge = health?.bridge ?? (live?.connected ? "online" : "offline");
  const httpLive = bridge === "online";
  const ea = health?.ea ?? (live?.eaConnected ? "online" : live?.connected ? "offline" : "unknown");
  const ready = httpLive && Boolean(health?.ready ?? live?.connected);

  return {
    status: {
      mode: config.EXECUTION_MODE,
      enabled: true,
      demo: live?.isDemo ?? live?.tradeMode === "DEMO",
      isDemo: live?.isDemo ?? live?.tradeMode === "DEMO",
      environment: "demo",
      liveTradingSupported: liveCap.liveTradingSupported,
      liveTradingEnabled: liveCap.liveTradingEnabled,
      realMoneyEnabled: liveCap.realMoneyEnabled,
      testMode: snapshot.mt5TestMode,
      connected: httpLive,
      eaConnected: ea === "online",
      tradeMode: live?.tradeMode ?? null,
      marginMode: live?.marginMode ?? null,
      login: live?.login ?? null,
      company: live?.company ?? null,
      server: live?.server ?? null,
      leverage: live?.leverage ?? null,
      currency: live?.currency ?? null,
      account: live?.account ?? null,
      lastError: live?.lastError ?? error ?? null,
      engineAutomationEnabled: snapshot.engineAutomationEnabled,
      openPositions: live?.openPositions ?? [],
      error: error ?? null,
      config: snapshot,
      bridge,
      ea,
      reconciliation: health?.reconciliation ?? "unknown",
      circuitState: health?.circuit?.circuitState ?? null,
      consecutiveFailures: health?.circuit?.consecutiveFailures ?? 0,
      lastBridgeSuccessAt: health?.lastBridgeSuccessAt ?? health?.circuit?.lastSuccessAt ?? null,
      lastEaSuccessAt: health?.lastEaSuccessAt ?? null,
      nextProbeAt: health?.circuit?.nextProbeAt ?? null,
      executionBlockReason: health?.executionBlockReason ?? error ?? null,
      ready
    }
  };
}
