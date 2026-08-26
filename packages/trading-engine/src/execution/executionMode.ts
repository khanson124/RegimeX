export type ExecutionBackend =
  | "paper_cfd"
  | "broker_demo_cfd"
  | "broker_demo_mt5"
  | "broker_real_cfd"
  | "broker_real_mt5"
  | "legacy_binary";

export interface ExecutionModeConfig {
  EXECUTION_MODE: ExecutionBackend;
  LEGACY_BINARY_ENABLED: boolean;
  REAL_MONEY_ENABLED: boolean;
  BROKER_REAL_ACK?: string | null;
  BROKER_REAL_ACCOUNT_ID?: string | null;
  CTRADER_CLIENT_ID?: string | null;
  CTRADER_CLIENT_SECRET?: string | null;
  CTRADER_ACCOUNT_ID?: string | null;
  CTRADER_ACCESS_TOKEN?: string | null;
  CTRADER_ENVIRONMENT?: "demo" | "live" | null;
  MT5_BRIDGE_URL?: string | null;
  MT5_BRIDGE_HOST?: string | null;
  MT5_BRIDGE_PORT?: number | null;
  MT5_BRIDGE_SECRET?: string | null;
  MT5_EXPECTED_ENVIRONMENT?: "demo" | "live" | null;
}

/**
 * Authoritative execution backend resolution.
 *
 * Fail-closed rules:
 * - broker_real_cfd → REAL_CFD_EXECUTION_NOT_IMPLEMENTED (even with REAL_MONEY_ENABLED)
 * - broker_real_mt5 → REAL_MT5_EXECUTION_NOT_IMPLEMENTED (even with REAL_MONEY_ENABLED)
 * - REAL_MONEY_ENABLED=true is refused for every implemented mode
 * - broker_demo_cfd requires credentials + CTRADER_ENVIRONMENT=demo
 * - broker_demo_mt5 is the primary DEMO forward path (bridge URL/secret + demo env)
 * - paper_cfd remains a supported local/dev/fallback backend
 */
export function resolveExecutionBackend(config: ExecutionModeConfig): ExecutionBackend {
  // Real-money modes are architecture-only. Check these FIRST so
  // REAL_MONEY_ENABLED=true cannot unlock a funded path by flipping one flag.
  if (config.EXECUTION_MODE === "broker_real_mt5") {
    throw new Error(
      "REAL_MT5_EXECUTION_NOT_IMPLEMENTED: broker_real_mt5 is architecture-only. Refusing to start."
    );
  }

  if (config.EXECUTION_MODE === "broker_real_cfd") {
    throw new Error(
      "REAL_CFD_EXECUTION_NOT_IMPLEMENTED: broker_real_cfd is architecture-only. Refusing to start."
    );
  }

  if (config.REAL_MONEY_ENABLED) {
    throw new Error(
      "REAL_MONEY_ENABLED=true is refused. Real CFD/MT5 execution is not implemented. Refusing unsafe config."
    );
  }

  if (config.EXECUTION_MODE === "legacy_binary") {
    if (!config.LEGACY_BINARY_ENABLED) {
      throw new Error(
        "EXECUTION_MODE=legacy_binary requires LEGACY_BINARY_ENABLED=true. Refusing to start legacy execution."
      );
    }
    return "legacy_binary";
  }

  if (config.EXECUTION_MODE === "broker_demo_cfd") {
    if (config.CTRADER_ENVIRONMENT === "live") {
      throw new Error("broker_demo_cfd requires CTRADER_ENVIRONMENT=demo");
    }
    const missing: string[] = [];
    if (!config.CTRADER_CLIENT_ID) missing.push("CTRADER_CLIENT_ID");
    if (!config.CTRADER_CLIENT_SECRET) missing.push("CTRADER_CLIENT_SECRET");
    if (!config.CTRADER_ACCOUNT_ID) missing.push("CTRADER_ACCOUNT_ID");
    if (!config.CTRADER_ACCESS_TOKEN) missing.push("CTRADER_ACCESS_TOKEN");
    if (missing.length) {
      throw new Error(
        `EXECUTION_MODE=broker_demo_cfd missing required credentials: ${missing.join(", ")}`
      );
    }
    return "broker_demo_cfd";
  }

  if (config.EXECUTION_MODE === "broker_demo_mt5") {
    if (config.MT5_EXPECTED_ENVIRONMENT === "live") {
      throw new Error("broker_demo_mt5 requires MT5_EXPECTED_ENVIRONMENT=demo");
    }
    const missing: string[] = [];
    if (!config.MT5_BRIDGE_SECRET) missing.push("MT5_BRIDGE_SECRET");
    if (!config.MT5_BRIDGE_URL && !config.MT5_BRIDGE_HOST) missing.push("MT5_BRIDGE_URL");
    if (missing.length) {
      throw new Error(
        `EXECUTION_MODE=broker_demo_mt5 missing required config: ${missing.join(", ")}`
      );
    }
    return "broker_demo_mt5";
  }

  if (config.EXECUTION_MODE !== "paper_cfd") {
    throw new Error(`Unknown EXECUTION_MODE: ${String(config.EXECUTION_MODE)}`);
  }

  return "paper_cfd";
}

export function isPaperCfdExecution(config: ExecutionModeConfig): boolean {
  return resolveExecutionBackend(config) === "paper_cfd";
}

export function isBrokerDemoCfdExecution(config: ExecutionModeConfig): boolean {
  return resolveExecutionBackend(config) === "broker_demo_cfd";
}

export function isBrokerDemoMt5Execution(config: ExecutionModeConfig): boolean {
  return resolveExecutionBackend(config) === "broker_demo_mt5";
}

/** Docker DNS URL for the mt5-bridge service. Never use 127.0.0.1 from a container. */
export function resolveMt5BridgeUrl(config: ExecutionModeConfig): string {
  if (config.MT5_BRIDGE_URL) return config.MT5_BRIDGE_URL;
  const host = config.MT5_BRIDGE_HOST || "mt5-bridge";
  const port = config.MT5_BRIDGE_PORT || 8765;
  return `http://${host}:${port}`;
}

/**
 * CFD BUY/SELL path (paper, MT5 DEMO, cTrader DEMO).
 * Never used by legacy binary proposal/buy.
 */
export function assertCfdExecutionReachable(config: ExecutionModeConfig): void {
  if (config.REAL_MONEY_ENABLED) {
    throw new Error(
      "REAL_MONEY_ENABLED=true is refused. Real CFD/MT5 execution is not implemented. Refusing unsafe config."
    );
  }
  if (config.EXECUTION_MODE === "broker_real_mt5") {
    throw new Error("REAL_MT5_EXECUTION_NOT_IMPLEMENTED");
  }
  if (config.EXECUTION_MODE === "broker_real_cfd") {
    throw new Error("REAL_CFD_EXECUTION_NOT_IMPLEMENTED");
  }
  if (config.EXECUTION_MODE === "legacy_binary") {
    throw new Error("CFD execution is blocked while EXECUTION_MODE is legacy_binary");
  }
  const mode = resolveExecutionBackend(config);
  if (mode !== "paper_cfd" && mode !== "broker_demo_cfd" && mode !== "broker_demo_mt5") {
    throw new Error(`CFD execution is not reachable for EXECUTION_MODE=${mode}`);
  }
}

/**
 * Legacy Deriv binary proposal/buy/proposal_open_contract only.
 * Must NOT be called from paper/MT5/cTrader CFD runtimes.
 */
export function assertLegacyBinaryReachable(config: ExecutionModeConfig): void {
  if (config.REAL_MONEY_ENABLED) {
    throw new Error(
      "REAL_MONEY_ENABLED=true is refused. Real CFD/MT5 execution is not implemented. Refusing unsafe config."
    );
  }
  if (
    config.EXECUTION_MODE === "paper_cfd" ||
    config.EXECUTION_MODE === "broker_demo_cfd" ||
    config.EXECUTION_MODE === "broker_demo_mt5" ||
    config.EXECUTION_MODE === "broker_real_cfd" ||
    config.EXECUTION_MODE === "broker_real_mt5"
  ) {
    throw new Error(
      "Legacy binary execution (proposal/buy/proposal_open_contract) is blocked while EXECUTION_MODE is CFD"
    );
  }
  if (config.EXECUTION_MODE !== "legacy_binary" || !config.LEGACY_BINARY_ENABLED) {
    throw new Error("Legacy binary execution is not reachable");
  }
}
