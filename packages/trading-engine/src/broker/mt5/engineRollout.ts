import { type StrategyEvidenceLifecycle } from "@regimex/shared";
import { type Mt5AccessConfig } from "./demoAccess.js";

export const MT5_ENGINE_SYMBOL_ALLOWLIST_EMPTY = "MT5_ENGINE_SYMBOL_ALLOWLIST_EMPTY";
export const MT5_ENGINE_STRATEGY_ALLOWLIST_EMPTY = "MT5_ENGINE_STRATEGY_ALLOWLIST_EMPTY";
export const MT5_ENGINE_SYMBOL_NOT_ALLOWED = "MT5_ENGINE_SYMBOL_NOT_ALLOWED";
export const MT5_ENGINE_STRATEGY_NOT_ALLOWED = "MT5_ENGINE_STRATEGY_NOT_ALLOWED";
export const MT5_ENGINE_MAX_CONCURRENT = "MT5_ENGINE_MAX_CONCURRENT";
export const MT5_ENGINE_LIFECYCLE_BLOCKED = "MT5_ENGINE_LIFECYCLE_BLOCKED";
export const MT5_NOT_ACTIVE_EXECUTION_MODE = "MT5_NOT_ACTIVE_EXECUTION_MODE";

const BLOCKED_LIFECYCLES: ReadonlySet<StrategyEvidenceLifecycle> = new Set([
  "DEGRADED",
  "SUSPENDED",
  "REJECTED"
]);

export function parseCsvAllowlist(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Deriv forex catalogue names (`frxEURUSD`) map to MT5 broker names (`EURUSD`). */
export function engineSymbolToMt5BrokerSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (/^frx/i.test(trimmed) && trimmed.length > 3) return trimmed.slice(3).toUpperCase();
  return trimmed;
}

export function allowlistMatchesSymbol(allowlist: string[], engineSymbol: string): boolean {
  const broker = engineSymbolToMt5BrokerSymbol(engineSymbol);
  return allowlist.includes(engineSymbol) || allowlist.includes(broker);
}

export interface Mt5EngineRolloutConfig extends Mt5AccessConfig {
  MT5_ENGINE_SYMBOL_ALLOWLIST?: string | null;
  MT5_ENGINE_STRATEGY_ALLOWLIST?: string | null;
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS?: number | null;
}

export interface Mt5EngineSubmissionInput {
  config: Mt5EngineRolloutConfig;
  symbol: string;
  strategyId: string;
  openOwnedCount: number;
  lifecycle?: StrategyEvidenceLifecycle | null;
}

export interface Mt5EngineSubmissionGate {
  allowed: boolean;
  reason: string | null;
  decisionCode:
    | "SUBMIT"
    | "MT5_ENGINE_DISABLED"
    | "PAPER_MODE"
    | "REAL_MONEY_BLOCKED"
    | "ALLOWLIST"
    | "MAX_CONCURRENT"
    | "EVIDENCE_BLOCKED";
}

/**
 * Fail-closed autonomous MT5 DEMO gate.
 * Empty symbol or strategy allowlist blocks all engine orders.
 * MT5_TEST_MODE never enables this path.
 */
export function gateMt5EngineSubmission(input: Mt5EngineSubmissionInput): Mt5EngineSubmissionGate {
  const { config, symbol, strategyId, openOwnedCount, lifecycle } = input;

  if (config.EXECUTION_MODE === "broker_real_mt5" || config.REAL_MONEY_ENABLED === true) {
    return { allowed: false, reason: "REAL_MT5_EXECUTION_NOT_IMPLEMENTED", decisionCode: "REAL_MONEY_BLOCKED" };
  }
  if (config.EXECUTION_MODE !== "broker_demo_mt5") {
    return { allowed: false, reason: MT5_NOT_ACTIVE_EXECUTION_MODE, decisionCode: "PAPER_MODE" };
  }
  if (config.MT5_ENGINE_ENABLED !== true) {
    return { allowed: false, reason: "MT5_ENGINE_DISABLED", decisionCode: "MT5_ENGINE_DISABLED" };
  }

  const symbols = parseCsvAllowlist(config.MT5_ENGINE_SYMBOL_ALLOWLIST);
  if (symbols.length === 0) {
    return {
      allowed: false,
      reason: MT5_ENGINE_SYMBOL_ALLOWLIST_EMPTY,
      decisionCode: "ALLOWLIST"
    };
  }
  const strategies = parseCsvAllowlist(config.MT5_ENGINE_STRATEGY_ALLOWLIST);
  if (strategies.length === 0) {
    return {
      allowed: false,
      reason: MT5_ENGINE_STRATEGY_ALLOWLIST_EMPTY,
      decisionCode: "ALLOWLIST"
    };
  }
  if (!allowlistMatchesSymbol(symbols, symbol)) {
    return { allowed: false, reason: MT5_ENGINE_SYMBOL_NOT_ALLOWED, decisionCode: "ALLOWLIST" };
  }
  if (!strategies.includes(strategyId)) {
    return { allowed: false, reason: MT5_ENGINE_STRATEGY_NOT_ALLOWED, decisionCode: "ALLOWLIST" };
  }

  if (lifecycle && BLOCKED_LIFECYCLES.has(lifecycle)) {
    return {
      allowed: false,
      reason: `${MT5_ENGINE_LIFECYCLE_BLOCKED}:${lifecycle}`,
      decisionCode: "EVIDENCE_BLOCKED"
    };
  }

  const maxConcurrent = config.MT5_ENGINE_MAX_CONCURRENT_POSITIONS ?? 1;
  if (openOwnedCount >= maxConcurrent) {
    return { allowed: false, reason: MT5_ENGINE_MAX_CONCURRENT, decisionCode: "MAX_CONCURRENT" };
  }

  return { allowed: true, reason: null, decisionCode: "SUBMIT" };
}

export function publicMt5RolloutSnapshot(config: Mt5EngineRolloutConfig): {
  symbolAllowlist: string[];
  strategyAllowlist: string[];
  maxConcurrentPositions: number;
  allowlistsFailClosed: boolean;
} {
  const symbolAllowlist = parseCsvAllowlist(config.MT5_ENGINE_SYMBOL_ALLOWLIST);
  const strategyAllowlist = parseCsvAllowlist(config.MT5_ENGINE_STRATEGY_ALLOWLIST);
  return {
    symbolAllowlist,
    strategyAllowlist,
    maxConcurrentPositions: config.MT5_ENGINE_MAX_CONCURRENT_POSITIONS ?? 1,
    allowlistsFailClosed: symbolAllowlist.length === 0 || strategyAllowlist.length === 0
  };
}

export function describeMt5AutonomousAvailability(config: Mt5EngineRolloutConfig): {
  enabled: boolean;
  blocked: boolean;
  reason: string | null;
  decisionCode: Mt5EngineSubmissionGate["decisionCode"] | "SUBMIT";
} {
  const symbols = parseCsvAllowlist(config.MT5_ENGINE_SYMBOL_ALLOWLIST);
  const strategies = parseCsvAllowlist(config.MT5_ENGINE_STRATEGY_ALLOWLIST);
  const probe = gateMt5EngineSubmission({
    config,
    symbol: symbols[0] ?? "",
    strategyId: strategies[0] ?? "",
    openOwnedCount: 0,
    lifecycle: "EXPERIMENTAL"
  });
  return {
    enabled: probe.allowed,
    blocked: !probe.allowed,
    reason: probe.reason,
    decisionCode: probe.decisionCode
  };
}
