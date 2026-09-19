/**
 * Operator-facing trading environment (DEMO vs LIVE).
 * Backend execution mode must match verified broker account kind — never label alone.
 */
import { type ExecutionBackend } from "../../execution/executionMode.js";

export type TradingEnvironment = "DEMO" | "LIVE";

export type Mt5AccountKind = "demo" | "live" | "unknown";

export const TRADING_ENV_ACCOUNT_MISMATCH = "TRADING_ENV_ACCOUNT_MISMATCH";
export const TRADING_ENV_BACKEND_MISMATCH = "TRADING_ENV_BACKEND_MISMATCH";
export const TRADING_ENV_SUBMISSIONS_BLOCKED = "TRADING_ENV_SUBMISSIONS_BLOCKED";
export const TRADING_ENV_SWITCH_IN_PROGRESS = "TRADING_ENV_SWITCH_IN_PROGRESS";
export const TRADING_ENV_AMBIGUOUS_INTENTS = "TRADING_ENV_AMBIGUOUS_INTENTS";
export const TRADING_ENV_TARGET_UNAVAILABLE = "TRADING_ENV_TARGET_UNAVAILABLE";

export function tradingEnvironmentToBackend(env: TradingEnvironment): ExecutionBackend {
  return env === "LIVE" ? "broker_real_mt5" : "broker_demo_mt5";
}

export function backendToTradingEnvironment(
  backend: ExecutionBackend
): TradingEnvironment | null {
  if (backend === "broker_demo_mt5") return "DEMO";
  if (backend === "broker_real_mt5") return "LIVE";
  return null;
}

export function accountKindFromBrokerStatus(input: {
  isDemo: boolean | null | undefined;
  tradeMode: string | null | undefined;
}): Mt5AccountKind {
  if (input.isDemo === true && String(input.tradeMode ?? "").toUpperCase() === "DEMO") {
    return "demo";
  }
  if (input.isDemo === false && String(input.tradeMode ?? "").toUpperCase() === "REAL") {
    return "live";
  }
  return "unknown";
}

/** Session mode + backend must agree before any MT5 OrderSend. */
export function assertMt5ModeBackendConsistency(input: {
  sessionMode: "ANALYSIS_ONLY" | "DEMO_TRADING" | "LIVE_TRADING";
  executionBackend: ExecutionBackend;
}): { ok: true } | { ok: false; reason: string } {
  if (input.sessionMode === "DEMO_TRADING" && input.executionBackend !== "broker_demo_mt5") {
    return {
      ok: false,
      reason: `${TRADING_ENV_BACKEND_MISMATCH}: DEMO_TRADING requires broker_demo_mt5 (got ${input.executionBackend})`
    };
  }
  if (input.sessionMode === "LIVE_TRADING" && input.executionBackend !== "broker_real_mt5") {
    return {
      ok: false,
      reason: `${TRADING_ENV_BACKEND_MISMATCH}: LIVE_TRADING requires broker_real_mt5 (got ${input.executionBackend})`
    };
  }
  return { ok: true };
}

export function assertAccountMatchesEnvironment(input: {
  environment: TradingEnvironment;
  accountKind: Mt5AccountKind;
}): { ok: true } | { ok: false; reason: string } {
  const need: Mt5AccountKind = input.environment === "LIVE" ? "live" : "demo";
  if (input.accountKind !== need) {
    return {
      ok: false,
      reason: `${TRADING_ENV_ACCOUNT_MISMATCH}: ${input.environment} requires ${need} account (got ${input.accountKind})`
    };
  }
  return { ok: true };
}

export interface TradingEnvironmentSwitchPlan {
  from: TradingEnvironment;
  to: TradingEnvironment;
  mustDisarmLive: boolean;
  mustBlockSubmissions: boolean;
  requireTargetAccountKind: Mt5AccountKind;
  targetBackend: ExecutionBackend;
}

export function planTradingEnvironmentSwitch(input: {
  from: TradingEnvironment;
  to: TradingEnvironment;
}): TradingEnvironmentSwitchPlan {
  return {
    from: input.from,
    to: input.to,
    mustDisarmLive: true, // always clear arm on any environment change
    mustBlockSubmissions: true,
    requireTargetAccountKind: input.to === "LIVE" ? "live" : "demo",
    targetBackend: tradingEnvironmentToBackend(input.to)
  };
}

export function evaluateTradingEnvironmentSwitchGate(input: {
  submissionsBlocked: boolean;
  switchInProgress: boolean;
  ambiguousOpenIntents: boolean;
  targetAvailable: boolean;
  targetAccountKind: Mt5AccountKind;
  to: TradingEnvironment;
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.switchInProgress) reasons.push(TRADING_ENV_SWITCH_IN_PROGRESS);
  if (input.ambiguousOpenIntents) reasons.push(TRADING_ENV_AMBIGUOUS_INTENTS);
  if (!input.targetAvailable) reasons.push(TRADING_ENV_TARGET_UNAVAILABLE);
  const account = assertAccountMatchesEnvironment({
    environment: input.to,
    accountKind: input.targetAccountKind
  });
  if (!account.ok) reasons.push(account.reason);
  return { allowed: reasons.length === 0, reasons };
}

/** Mid/bid/ask must be positive finite before feeding the candle aggregator. */
export function isUsableMt5QuotePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

export function resolveMt5BridgeUrlForEnvironment(
  config: {
    MT5_BRIDGE_URL?: string | null;
    MT5_DEMO_BRIDGE_URL?: string | null;
    MT5_LIVE_BRIDGE_URL?: string | null;
    MT5_BRIDGE_HOST?: string | null;
    MT5_BRIDGE_PORT?: number | null;
  },
  environment: TradingEnvironment
): string {
  if (environment === "LIVE" && config.MT5_LIVE_BRIDGE_URL) return config.MT5_LIVE_BRIDGE_URL;
  if (environment === "DEMO" && config.MT5_DEMO_BRIDGE_URL) return config.MT5_DEMO_BRIDGE_URL;
  if (config.MT5_BRIDGE_URL) return config.MT5_BRIDGE_URL;
  const host = config.MT5_BRIDGE_HOST ?? "mt5-bridge";
  const port = config.MT5_BRIDGE_PORT ?? 8765;
  return `http://${host}:${port}`;
}
