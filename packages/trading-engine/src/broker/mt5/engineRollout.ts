import { type StrategyEvidenceLifecycle } from "@regimex/shared";
import { type ExecutionBackend } from "../../execution/executionMode.js";
import { type Mt5AccessConfig } from "./demoAccess.js";
import {
  BROKER_SYMBOL_MAPPING_MISSING,
  BROKER_SYMBOL_MAPPING_UNVERIFIED,
  BROKER_SYMBOL_UNAVAILABLE,
  type BrokerSymbolMappingRecord,
  resolveBrokerSymbolMapping
} from "./brokerSymbolMapping.js";
import { BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME, rolloutBlockedByBrokerMinVolume } from "./engineVolume.js";

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

/** Parsed MT5_ENGINE_STRATEGY_ALLOWLIST — empty means fail-closed for broker_demo_mt5 selection. */
export function resolveMt5EngineStrategyAllowlist(config: Mt5EngineRolloutConfig): string[] {
  return parseCsvAllowlist(config.MT5_ENGINE_STRATEGY_ALLOWLIST);
}

/**
 * Restricts broker_demo_mt5 strategy candidates to MT5_ENGINE_STRATEGY_ALLOWLIST.
 * Other execution backends pass through unchanged.
 */
export function applyMt5StrategySelectionAllowlist<T>(
  strategies: readonly T[],
  getStrategyId: (strategy: T) => string,
  executionBackend: ExecutionBackend,
  config: Mt5EngineRolloutConfig
): T[] {
  if (executionBackend !== "broker_demo_mt5") return [...strategies];
  const allowlist = resolveMt5EngineStrategyAllowlist(config);
  if (allowlist.length === 0) return [];
  return strategies.filter((s) => allowlist.includes(getStrategyId(s)));
}

export interface Mt5FixedStrategySelectionGate {
  allowed: boolean;
  reason: string | null;
  decisionCode: "FIXED_STRATEGY_ALLOWED" | "FIXED_STRATEGY_NOT_CONFIGURED" | "ALLOWLIST" | "STRATEGY_NOT_ALLOWED";
}

/** Fail-closed gate for broker_demo_mt5 SINGLE/fixed strategy mode. */
export function gateMt5FixedStrategySelection(input: {
  config: Mt5EngineRolloutConfig;
  fixedStrategyId: string | null | undefined;
}): Mt5FixedStrategySelectionGate {
  if (!input.fixedStrategyId) {
    return {
      allowed: false,
      reason: "FIXED_STRATEGY_NOT_CONFIGURED",
      decisionCode: "FIXED_STRATEGY_NOT_CONFIGURED"
    };
  }
  const allowlist = resolveMt5EngineStrategyAllowlist(input.config);
  if (allowlist.length === 0) {
    return {
      allowed: false,
      reason: MT5_ENGINE_STRATEGY_ALLOWLIST_EMPTY,
      decisionCode: "ALLOWLIST"
    };
  }
  if (!allowlist.includes(input.fixedStrategyId)) {
    return {
      allowed: false,
      reason: MT5_ENGINE_STRATEGY_NOT_ALLOWED,
      decisionCode: "STRATEGY_NOT_ALLOWED"
    };
  }
  return { allowed: true, reason: null, decisionCode: "FIXED_STRATEGY_ALLOWED" };
}

/** Allowlist contains internal RegimeX symbols (R_10), never broker-native MT5 names. */
export function allowlistMatchesInternalSymbol(allowlist: string[], internalSymbol: string): boolean {
  return allowlist.includes(internalSymbol);
}

export interface Mt5EngineRolloutConfig extends Mt5AccessConfig {
  MT5_ENGINE_SYMBOL_ALLOWLIST?: string | null;
  MT5_ENGINE_STRATEGY_ALLOWLIST?: string | null;
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS?: number | null;
  MT5_ENGINE_MAX_VOLUME?: number | null;
  MT5_ENGINE_MAX_RISK_PERCENT?: number | null;
}

export interface Mt5EngineSubmissionInput {
  config: Mt5EngineRolloutConfig;
  /** Internal RegimeX symbol, e.g. R_10. */
  symbol: string;
  strategyId: string;
  openOwnedCount: number;
  lifecycle?: StrategyEvidenceLifecycle | null;
  mapping?: BrokerSymbolMappingRecord | null;
  /** Resolved capacity ceiling (profile ∩ env). When omitted, uses env only. */
  effectiveMaxConcurrentPositions?: number;
}

export type Mt5EngineSubmissionDecisionCode =
  | "SUBMIT"
  | "MT5_ENGINE_DISABLED"
  | "PAPER_MODE"
  | "REAL_MONEY_BLOCKED"
  | "ALLOWLIST"
  | "SYMBOL_NOT_ALLOWED"
  | "STRATEGY_NOT_ALLOWED"
  | "MAX_CONCURRENT"
  | "MAX_CONCURRENT_POSITIONS"
  | "EVIDENCE_BLOCKED"
  | "LIFECYCLE_BLOCKED"
  | "BROKER_SYMBOL_MAPPING_MISSING"
  | "BROKER_SYMBOL_MAPPING_UNVERIFIED"
  | "BROKER_SYMBOL_UNAVAILABLE"
  | "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME";

export interface Mt5EngineSubmissionGate {
  allowed: boolean;
  reason: string | null;
  decisionCode: Mt5EngineSubmissionDecisionCode;
}

function mappingDecisionCode(
  reasonCode: string | null
): Extract<
  Mt5EngineSubmissionDecisionCode,
  | "BROKER_SYMBOL_MAPPING_MISSING"
  | "BROKER_SYMBOL_MAPPING_UNVERIFIED"
  | "BROKER_SYMBOL_UNAVAILABLE"
> {
  if (reasonCode === BROKER_SYMBOL_MAPPING_UNVERIFIED) return "BROKER_SYMBOL_MAPPING_UNVERIFIED";
  if (reasonCode === BROKER_SYMBOL_UNAVAILABLE || reasonCode === "BROKER_SYMBOL_ONE_SECOND_VARIANT") {
    return "BROKER_SYMBOL_UNAVAILABLE";
  }
  return "BROKER_SYMBOL_MAPPING_MISSING";
}

/** Mapping + broker-min vs engine-max. Independent of MT5_ENGINE_ENABLED. */
export function gateMt5MappingAndVolume(input: {
  config: Mt5EngineRolloutConfig;
  symbol: string;
  mapping?: BrokerSymbolMappingRecord | null;
}): Mt5EngineSubmissionGate {
  const resolved = resolveBrokerSymbolMapping(input.symbol, input.mapping ?? null);
  if (!resolved.ok) {
    return {
      allowed: false,
      reason: resolved.reasonCode ?? BROKER_SYMBOL_MAPPING_MISSING,
      decisionCode: mappingDecisionCode(resolved.reasonCode)
    };
  }
  const engineMax = input.config.MT5_ENGINE_MAX_VOLUME ?? 0.01;
  if (
    rolloutBlockedByBrokerMinVolume({
      brokerMinVolume: input.mapping?.minVolume,
      engineMaxVolume: engineMax
    })
  ) {
    return {
      allowed: false,
      reason: BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME,
      decisionCode: "BROKER_MIN_VOLUME_EXCEEDS_ENGINE_MAX_VOLUME"
    };
  }
  return { allowed: true, reason: null, decisionCode: "SUBMIT" };
}

/**
 * Fail-closed autonomous MT5 DEMO gate.
 * Empty internal-symbol or strategy allowlist blocks all engine orders.
 * MT5_TEST_MODE never enables this path.
 */
export function gateMt5EngineSubmission(input: Mt5EngineSubmissionInput): Mt5EngineSubmissionGate {
  const { config, symbol, strategyId, openOwnedCount, lifecycle, mapping } = input;

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
  if (!allowlistMatchesInternalSymbol(symbols, symbol)) {
    return { allowed: false, reason: MT5_ENGINE_SYMBOL_NOT_ALLOWED, decisionCode: "SYMBOL_NOT_ALLOWED" };
  }
  if (!strategies.includes(strategyId)) {
    return { allowed: false, reason: MT5_ENGINE_STRATEGY_NOT_ALLOWED, decisionCode: "STRATEGY_NOT_ALLOWED" };
  }

  const mappingGate = gateMt5MappingAndVolume({ config, symbol, mapping: mapping ?? null });
  if (!mappingGate.allowed) return mappingGate;

  if (lifecycle && BLOCKED_LIFECYCLES.has(lifecycle)) {
    return {
      allowed: false,
      reason: `${MT5_ENGINE_LIFECYCLE_BLOCKED}:${lifecycle}`,
      decisionCode: "LIFECYCLE_BLOCKED"
    };
  }

  const maxConcurrent =
    input.effectiveMaxConcurrentPositions ?? config.MT5_ENGINE_MAX_CONCURRENT_POSITIONS ?? 1;
  if (openOwnedCount >= maxConcurrent) {
    return { allowed: false, reason: MT5_ENGINE_MAX_CONCURRENT, decisionCode: "MAX_CONCURRENT_POSITIONS" };
  }

  return { allowed: true, reason: null, decisionCode: "SUBMIT" };
}

export function publicMt5RolloutSnapshot(
  config: Mt5EngineRolloutConfig,
  mappings: BrokerSymbolMappingRecord[] = []
): {
  symbolAllowlist: string[];
  allowedInternalSymbols: string[];
  strategyAllowlist: string[];
  maxConcurrentPositions: number;
  engineMaxVolume: number;
  engineMaxRiskPercent: number;
  allowlistsFailClosed: boolean;
  resolvedBrokerSymbols: Array<{
    internalSymbol: string;
    brokerSymbol: string | null;
    verified: boolean;
    reasonCode: string | null;
    minVolume: number | null;
    volumeStep: number | null;
    maxVolume: number | null;
  }>;
} {
  const allowedInternalSymbols = parseCsvAllowlist(config.MT5_ENGINE_SYMBOL_ALLOWLIST);
  const strategyAllowlist = parseCsvAllowlist(config.MT5_ENGINE_STRATEGY_ALLOWLIST);
  const byInternal = new Map(mappings.map((m) => [m.internalSymbol, m]));
  return {
    symbolAllowlist: allowedInternalSymbols,
    allowedInternalSymbols,
    strategyAllowlist,
    maxConcurrentPositions: config.MT5_ENGINE_MAX_CONCURRENT_POSITIONS ?? 1,
    engineMaxVolume: config.MT5_ENGINE_MAX_VOLUME ?? 0.01,
    engineMaxRiskPercent: config.MT5_ENGINE_MAX_RISK_PERCENT ?? 0.1,
    allowlistsFailClosed: allowedInternalSymbols.length === 0 || strategyAllowlist.length === 0,
    resolvedBrokerSymbols: allowedInternalSymbols.map((internalSymbol) => {
      const mapping = byInternal.get(internalSymbol) ?? null;
      const resolved = resolveBrokerSymbolMapping(internalSymbol, mapping);
      return {
        internalSymbol,
        brokerSymbol: resolved.brokerSymbol,
        verified: resolved.verified && resolved.ok,
        reasonCode: resolved.reasonCode,
        minVolume: mapping?.minVolume ?? null,
        volumeStep: mapping?.volumeStep ?? null,
        maxVolume: mapping?.maxVolume ?? null
      };
    })
  };
}

export function describeMt5AutonomousAvailability(
  config: Mt5EngineRolloutConfig,
  mappings: BrokerSymbolMappingRecord[] = []
): {
  enabled: boolean;
  blocked: boolean;
  reason: string | null;
  decisionCode: Mt5EngineSubmissionGate["decisionCode"] | "SUBMIT";
} {
  if (config.EXECUTION_MODE === "broker_real_mt5" || config.REAL_MONEY_ENABLED === true) {
    return {
      enabled: false,
      blocked: true,
      reason: "REAL_MT5_EXECUTION_NOT_IMPLEMENTED",
      decisionCode: "REAL_MONEY_BLOCKED"
    };
  }
  if (config.EXECUTION_MODE !== "broker_demo_mt5") {
    return {
      enabled: false,
      blocked: true,
      reason: MT5_NOT_ACTIVE_EXECUTION_MODE,
      decisionCode: "PAPER_MODE"
    };
  }

  const symbols = parseCsvAllowlist(config.MT5_ENGINE_SYMBOL_ALLOWLIST);
  const strategies = parseCsvAllowlist(config.MT5_ENGINE_STRATEGY_ALLOWLIST);
  const mapping = mappings.find((m) => m.internalSymbol === (symbols[0] ?? "")) ?? null;

  if (symbols.length > 0 && strategies.length > 0) {
    const mappingGate = gateMt5MappingAndVolume({
      config,
      symbol: symbols[0]!,
      mapping
    });
    if (!mappingGate.allowed) {
      return {
        enabled: false,
        blocked: true,
        reason: mappingGate.reason,
        decisionCode: mappingGate.decisionCode
      };
    }
  }

  const probe = gateMt5EngineSubmission({
    config,
    symbol: symbols[0] ?? "",
    strategyId: strategies[0] ?? "",
    openOwnedCount: 0,
    lifecycle: "EXPERIMENTAL",
    mapping
  });
  return {
    enabled: probe.allowed,
    blocked: !probe.allowed,
    reason: probe.reason,
    decisionCode: probe.decisionCode
  };
}
