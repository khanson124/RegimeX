import type { Mt5BridgeCircuitState } from "./bridgeCircuit.js";

export const MT5_QUOTE_FEED_UNAVAILABLE = "MT5_QUOTE_FEED_UNAVAILABLE";
export const MT5_BRIDGE_CIRCUIT_OPEN = "MT5_BRIDGE_CIRCUIT_OPEN";
export const MT5_BROKER_QUOTE_STALE = "MT5_BROKER_QUOTE_STALE";
export const MT5_MARKET_DATA_STALE = "MT5_MARKET_DATA_STALE";

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
  shouldDegrade: boolean;
  reasonCode: string | null;
  stateReason: string | null;
  detail: string | null;
}

export function evaluateMt5QuoteWatchdog(input: Mt5QuoteWatchdogInput): Mt5QuoteWatchdogEvaluation {
  const { now, staleDataMs, brokerQuoteMaxAgeMs, circuitState, health, lastTickAt } = input;
  const none = {
    shouldDegrade: false,
    reasonCode: null,
    stateReason: null,
    detail: null
  } as const;

  if (circuitState === "OPEN") {
    return {
      shouldDegrade: true,
      reasonCode: MT5_BRIDGE_CIRCUIT_OPEN,
      stateReason: MT5_BRIDGE_CIRCUIT_OPEN,
      detail: "MT5 bridge circuit is open; quote polling and execution are fail-closed"
    };
  }

  const pollStale =
    health.lastQuotePollSuccessAt == null || now - health.lastQuotePollSuccessAt > staleDataMs;
  if (pollStale) {
    const detail =
      health.lastQuotePollSuccessAt == null
        ? "No successful MT5 quote poll yet"
        : `No successful MT5 quote poll for ${Math.round((now - health.lastQuotePollSuccessAt) / 1000)}s`;
    const infraCode = health.lastQuotePollErrorCode;
    return {
      shouldDegrade: true,
      reasonCode: MT5_QUOTE_FEED_UNAVAILABLE,
      stateReason: MT5_QUOTE_FEED_UNAVAILABLE,
      detail:
        infraCode && infraCode !== MT5_BROKER_QUOTE_STALE
          ? `${detail}; lastError=${infraCode}`
          : detail
    };
  }

  if (isBrokerQuoteTimestampStale(health.lastBrokerQuoteTimestamp, now, brokerQuoteMaxAgeMs)) {
    const ageSec =
      health.lastBrokerQuoteTimestamp != null
        ? Math.round((now - health.lastBrokerQuoteTimestamp) / 1000)
        : null;
    return {
      shouldDegrade: true,
      reasonCode: MT5_BROKER_QUOTE_STALE,
      stateReason: MT5_BROKER_QUOTE_STALE,
      detail:
        ageSec != null
          ? `Broker quote timestamp is ${ageSec}s old (max ${Math.round(brokerQuoteMaxAgeMs / 1000)}s)`
          : "Broker quote timestamp missing"
    };
  }

  if (lastTickAt != null && now - lastTickAt > staleDataMs) {
    return {
      shouldDegrade: true,
      reasonCode: MT5_MARKET_DATA_STALE,
      stateReason: MT5_MARKET_DATA_STALE,
      detail: `Trusted market data is ${Math.round((now - lastTickAt) / 1000)}s old`
    };
  }

  return none;
}
