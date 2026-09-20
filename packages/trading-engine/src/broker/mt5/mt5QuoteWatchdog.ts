import type { Mt5BridgeCircuitState } from "./bridgeCircuit.js";

export const MT5_QUOTE_FEED_UNAVAILABLE = "MT5_QUOTE_FEED_UNAVAILABLE";
export const MT5_BRIDGE_CIRCUIT_OPEN = "MT5_BRIDGE_CIRCUIT_OPEN";
export const MT5_BROKER_QUOTE_STALE = "MT5_BROKER_QUOTE_STALE";
export const MT5_MARKET_DATA_STALE = "MT5_MARKET_DATA_STALE";
/** Non-positive / non-finite bid/ask/mid — typically closed market; symbol-local only. */
export const MT5_SYMBOL_MARKET_CLOSED = "MT5_SYMBOL_MARKET_CLOSED";
/** getQuote returned null for this symbol (mapping/missing) — symbol-local, not shared infra. */
export const MT5_SYMBOL_QUOTE_UNAVAILABLE = "MT5_SYMBOL_QUOTE_UNAVAILABLE";

const SYMBOL_LOCAL_ERROR_CODES = new Set<string>([
  MT5_SYMBOL_MARKET_CLOSED,
  MT5_SYMBOL_QUOTE_UNAVAILABLE
]);

export function isMt5SymbolLocalQuoteError(code: string | null | undefined): boolean {
  return code != null && SYMBOL_LOCAL_ERROR_CODES.has(code);
}

export interface Mt5QuotePollHealth {
  lastQuotePollAttemptAt: number | null;
  lastQuotePollSuccessAt: number | null;
  consecutiveQuotePollFailures: number;
  lastQuotePollErrorCode: string | null;
  lastBrokerQuoteTimestamp: number | null;
}

export function createMt5QuotePollHealth(): Mt5QuotePollHealth {
  return {
    lastQuotePollAttemptAt: null,
    lastQuotePollSuccessAt: null,
    consecutiveQuotePollFailures: 0,
    lastQuotePollErrorCode: null,
    lastBrokerQuoteTimestamp: null
  };
}

export function recordMt5QuotePollAttempt(health: Mt5QuotePollHealth, now: number): void {
  health.lastQuotePollAttemptAt = now;
}

export function recordMt5QuotePollSuccess(
  health: Mt5QuotePollHealth,
  brokerQuoteTimestamp: number,
  now: number
): void {
  health.lastQuotePollSuccessAt = now;
  health.consecutiveQuotePollFailures = 0;
  health.lastQuotePollErrorCode = null;
  health.lastBrokerQuoteTimestamp = brokerQuoteTimestamp;
}

export function recordMt5QuotePollFailure(
  health: Mt5QuotePollHealth,
  errorCode: string,
  now: number,
  brokerQuoteTimestamp?: number | null
): void {
  health.consecutiveQuotePollFailures += 1;
  health.lastQuotePollErrorCode = errorCode;
  if (brokerQuoteTimestamp != null && Number.isFinite(brokerQuoteTimestamp)) {
    health.lastBrokerQuoteTimestamp = brokerQuoteTimestamp;
  }
}

export function isBrokerQuoteTimestampStale(
  brokerQuoteTimestamp: number | null | undefined,
  now: number,
  maxAgeMs: number
): boolean {
  if (brokerQuoteTimestamp == null || !Number.isFinite(brokerQuoteTimestamp)) return true;
  if (!(maxAgeMs > 0)) return false;
  return now - brokerQuoteTimestamp > maxAgeMs;
}

export interface Mt5QuoteWatchdogInput {
  now: number;
  staleDataMs: number;
  brokerQuoteMaxAgeMs: number;
  circuitState: Mt5BridgeCircuitState;
  health: Mt5QuotePollHealth;
  /** Local last trusted feed timestamp (successful poll + fresh broker quote). */
  lastTickAt: number | null;
}

export interface Mt5QuoteWatchdogEvaluation {
  /**
   * Shared LiveEngine row should move to DEGRADED (infra / cross-symbol feed loss).
   * Symbol-local closed market must not set this.
   */
  shouldDegradeShared: boolean;
  /** This symbol may submit orders / rely on live ticks. */
  symbolTradable: boolean;
  reasonCode: string | null;
  stateReason: string | null;
  detail: string | null;
  /** @deprecated Use shouldDegradeShared — kept for call-site compatibility. */
  shouldDegrade: boolean;
}

export function evaluateMt5QuoteWatchdog(input: Mt5QuoteWatchdogInput): Mt5QuoteWatchdogEvaluation {
  const { now, staleDataMs, brokerQuoteMaxAgeMs, circuitState, health, lastTickAt } = input;

  const pack = (
    partial: Omit<Mt5QuoteWatchdogEvaluation, "shouldDegrade">
  ): Mt5QuoteWatchdogEvaluation => ({
    ...partial,
    shouldDegrade: partial.shouldDegradeShared
  });

  if (circuitState === "OPEN") {
    return pack({
      shouldDegradeShared: true,
      symbolTradable: false,
      reasonCode: MT5_BRIDGE_CIRCUIT_OPEN,
      stateReason: MT5_BRIDGE_CIRCUIT_OPEN,
      detail: "MT5 bridge circuit is open; quote polling and execution are fail-closed"
    });
  }

  // Symbol-local issues never own the shared engine row.
  if (isMt5SymbolLocalQuoteError(health.lastQuotePollErrorCode)) {
    const closed = health.lastQuotePollErrorCode === MT5_SYMBOL_MARKET_CLOSED;
    return pack({
      shouldDegradeShared: false,
      symbolTradable: false,
      reasonCode: health.lastQuotePollErrorCode,
      stateReason: health.lastQuotePollErrorCode,
      detail: closed
        ? "Symbol quote unusable (non-positive/non-finite prices — market likely closed); symbol non-tradable"
        : "Symbol quote unavailable; symbol non-tradable"
    });
  }

  const pollStale =
    health.lastQuotePollSuccessAt == null || now - health.lastQuotePollSuccessAt > staleDataMs;
  if (pollStale) {
    const detail =
      health.lastQuotePollSuccessAt == null
        ? "No successful MT5 quote poll yet"
        : `No successful MT5 quote poll for ${Math.round((now - health.lastQuotePollSuccessAt) / 1000)}s`;
    const infraCode = health.lastQuotePollErrorCode;
    return pack({
      shouldDegradeShared: true,
      symbolTradable: false,
      reasonCode: MT5_QUOTE_FEED_UNAVAILABLE,
      stateReason: MT5_QUOTE_FEED_UNAVAILABLE,
      detail:
        infraCode && infraCode !== MT5_BROKER_QUOTE_STALE
          ? `${detail}; lastError=${infraCode}`
          : detail
    });
  }

  if (isBrokerQuoteTimestampStale(health.lastBrokerQuoteTimestamp, now, brokerQuoteMaxAgeMs)) {
    const ageSec =
      health.lastBrokerQuoteTimestamp != null
        ? Math.round((now - health.lastBrokerQuoteTimestamp) / 1000)
        : null;
    return pack({
      shouldDegradeShared: true,
      symbolTradable: false,
      reasonCode: MT5_BROKER_QUOTE_STALE,
      stateReason: MT5_BROKER_QUOTE_STALE,
      detail:
        ageSec != null
          ? `Broker quote timestamp is ${ageSec}s old (max ${Math.round(brokerQuoteMaxAgeMs / 1000)}s)`
          : "Broker quote timestamp missing"
    });
  }

  if (lastTickAt != null && now - lastTickAt > staleDataMs) {
    return pack({
      shouldDegradeShared: true,
      symbolTradable: false,
      reasonCode: MT5_MARKET_DATA_STALE,
      stateReason: MT5_MARKET_DATA_STALE,
      detail: `Trusted market data is ${Math.round((now - lastTickAt) / 1000)}s old`
    });
  }

  return pack({
    shouldDegradeShared: false,
    symbolTradable: true,
    reasonCode: null,
    stateReason: null,
    detail: null
  });
}

/** Per-session contribution used to reconcile the shared LiveEngine row. */
export interface Mt5SessionHealthContribution {
  symbol: string;
  shouldDegradeShared: boolean;
  reasonCode: string | null;
  stateReason: string | null;
  symbolTradable: boolean;
  lastTickAt: number | null;
}

export interface Mt5AggregateEngineHealth {
  /** Shared row should be DEGRADED when any session reports infra failure. */
  sharedDegraded: boolean;
  /** Safe to restore RUNNING_* only when no session reports infra failure. */
  canRecoverShared: boolean;
  reasonCode: string | null;
  stateReason: string | null;
  detail: string;
  degradedSymbols: string[];
  nonTradableSymbols: string[];
  /** Newest trusted tick across sessions (for shared lastTickAt). */
  newestLastTickAt: number | null;
}

export function aggregateMt5SessionHealth(
  sessions: Mt5SessionHealthContribution[]
): Mt5AggregateEngineHealth {
  const degraded = sessions.filter((s) => s.shouldDegradeShared);
  const nonTradable = sessions.filter((s) => !s.symbolTradable);
  let newestLastTickAt: number | null = null;
  for (const s of sessions) {
    if (s.lastTickAt != null && (newestLastTickAt == null || s.lastTickAt > newestLastTickAt)) {
      newestLastTickAt = s.lastTickAt;
    }
  }
  const primary = degraded[0] ?? null;
  const sharedDegraded = degraded.length > 0;
  return {
    sharedDegraded,
    canRecoverShared: !sharedDegraded,
    reasonCode: primary?.reasonCode ?? null,
    stateReason: primary?.stateReason ?? null,
    detail: sharedDegraded
      ? `Infra quote health failed for: ${degraded.map((s) => s.symbol).join(", ")}`
      : nonTradable.length > 0
        ? `Shared infra OK; non-tradable symbols: ${nonTradable.map((s) => s.symbol).join(", ")}`
        : "All sessions tradable",
    degradedSymbols: degraded.map((s) => s.symbol),
    nonTradableSymbols: nonTradable.map((s) => s.symbol),
    newestLastTickAt
  };
}
