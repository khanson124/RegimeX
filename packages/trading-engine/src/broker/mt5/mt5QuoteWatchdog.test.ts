import { describe, expect, it } from "vitest";
import {
  aggregateMt5SessionHealth,
  createMt5QuotePollHealth,
  evaluateMt5QuoteWatchdog,
  isBrokerQuoteTimestampStale,
  isMt5SymbolLocalQuoteError,
  MT5_BRIDGE_CIRCUIT_OPEN,
  MT5_BROKER_QUOTE_STALE,
  MT5_MARKET_DATA_STALE,
  MT5_QUOTE_FEED_UNAVAILABLE,
  MT5_SYMBOL_MARKET_CLOSED,
  MT5_SYMBOL_QUOTE_UNAVAILABLE,
  recordMt5QuotePollFailure,
  recordMt5QuotePollSuccess
} from "./mt5QuoteWatchdog.js";
import { shouldConsumeStrategySignalCooldown } from "./strategySignalCooldown.js";

const STALE_MS = 45_000;
const NOW = 1_700_000_000_000;

function healthWithSuccess(at: number, brokerTs: number) {
  const health = createMt5QuotePollHealth();
  recordMt5QuotePollSuccess(health, brokerTs, at);
  return health;
}

describe("mt5QuoteWatchdog", () => {
  it("1. recent successful quote polling keeps engine running", () => {
    const health = healthWithSuccess(NOW, NOW - 1_000);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: NOW - 1_000
    });
    expect(eval_.shouldDegrade).toBe(false);
    expect(eval_.shouldDegradeShared).toBe(false);
    expect(eval_.symbolTradable).toBe(true);
  });

  it("2. >45s without successful quote poll degrades with MT5_QUOTE_FEED_UNAVAILABLE", () => {
    const health = createMt5QuotePollHealth();
    recordMt5QuotePollSuccess(health, NOW - 60_000, NOW - 60_000);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: NOW - 60_000
    });
    expect(eval_.shouldDegrade).toBe(true);
    expect(eval_.shouldDegradeShared).toBe(true);
    expect(eval_.symbolTradable).toBe(false);
    expect(eval_.reasonCode).toBe(MT5_QUOTE_FEED_UNAVAILABLE);
  });

  it("3. bridge timeout on last poll surfaces in feed-unavailable detail", () => {
    const health = createMt5QuotePollHealth();
    recordMt5QuotePollFailure(health, "MT5_BRIDGE_TIMEOUT", NOW - 5_000);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: null
    });
    expect(eval_.reasonCode).toBe(MT5_QUOTE_FEED_UNAVAILABLE);
    expect(eval_.detail).toContain("MT5_BRIDGE_TIMEOUT");
    expect(eval_.shouldDegradeShared).toBe(true);
  });

  it("4. circuit OPEN produces MT5_BRIDGE_CIRCUIT_OPEN", () => {
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "OPEN",
      health: createMt5QuotePollHealth(),
      lastTickAt: NOW
    });
    expect(eval_.reasonCode).toBe(MT5_BRIDGE_CIRCUIT_OPEN);
    expect(eval_.stateReason).toBe(MT5_BRIDGE_CIRCUIT_OPEN);
    expect(eval_.shouldDegradeShared).toBe(true);
    expect(eval_.symbolTradable).toBe(false);
  });

  it("5. fresh quote clears degradation conditions", () => {
    const health = healthWithSuccess(NOW, NOW - 2_000);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: NOW - 2_000
    });
    expect(eval_.shouldDegrade).toBe(false);
    expect(eval_.symbolTradable).toBe(true);
  });

  it("7. stale broker quote timestamp is detected", () => {
    expect(isBrokerQuoteTimestampStale(NOW - 60_000, NOW, STALE_MS)).toBe(true);
    const health = healthWithSuccess(NOW, NOW - 60_000);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: NOW - 2_000
    });
    expect(eval_.reasonCode).toBe(MT5_BROKER_QUOTE_STALE);
    expect(eval_.shouldDegradeShared).toBe(true);
  });

  it("trusted feed stale without poll failure uses MT5_MARKET_DATA_STALE", () => {
    const health = healthWithSuccess(NOW - 5_000, NOW - 5_000);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: NOW - 50_000
    });
    expect(eval_.reasonCode).toBe(MT5_MARKET_DATA_STALE);
  });

  it("closed-market zero prices are symbol-local — not shared DEGRADED", () => {
    const health = createMt5QuotePollHealth();
    recordMt5QuotePollFailure(health, MT5_SYMBOL_MARKET_CLOSED, NOW, 0);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: null
    });
    expect(isMt5SymbolLocalQuoteError(MT5_SYMBOL_MARKET_CLOSED)).toBe(true);
    expect(eval_.reasonCode).toBe(MT5_SYMBOL_MARKET_CLOSED);
    expect(eval_.shouldDegradeShared).toBe(false);
    expect(eval_.shouldDegrade).toBe(false);
    expect(eval_.symbolTradable).toBe(false);
  });

  it("null symbol quote is symbol-local non-tradable", () => {
    const health = createMt5QuotePollHealth();
    recordMt5QuotePollFailure(health, MT5_SYMBOL_QUOTE_UNAVAILABLE, NOW);
    const eval_ = evaluateMt5QuoteWatchdog({
      now: NOW,
      staleDataMs: STALE_MS,
      brokerQuoteMaxAgeMs: STALE_MS,
      circuitState: "CLOSED",
      health,
      lastTickAt: null
    });
    expect(eval_.shouldDegradeShared).toBe(false);
    expect(eval_.symbolTradable).toBe(false);
    expect(eval_.reasonCode).toBe(MT5_SYMBOL_QUOTE_UNAVAILABLE);
  });
});

describe("aggregateMt5SessionHealth multi-symbol", () => {
  it("R_10 healthy + XAUUSD closed: shared not degraded; XAU non-tradable", () => {
    const agg = aggregateMt5SessionHealth([
      {
        symbol: "R_10",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW - 1_000
      },
      {
        symbol: "XAUUSD",
        shouldDegradeShared: false,
        reasonCode: MT5_SYMBOL_MARKET_CLOSED,
        stateReason: MT5_SYMBOL_MARKET_CLOSED,
        symbolTradable: false,
        lastTickAt: null
      }
    ]);
    expect(agg.sharedDegraded).toBe(false);
    expect(agg.canRecoverShared).toBe(true);
    expect(agg.nonTradableSymbols).toEqual(["XAUUSD"]);
    expect(agg.degradedSymbols).toEqual([]);
    expect(agg.newestLastTickAt).toBe(NOW - 1_000);
  });

  it("both healthy: shared recoverable and all tradable", () => {
    const agg = aggregateMt5SessionHealth([
      {
        symbol: "R_10",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW
      },
      {
        symbol: "XAUUSD",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW - 500
      }
    ]);
    expect(agg.sharedDegraded).toBe(false);
    expect(agg.canRecoverShared).toBe(true);
    expect(agg.nonTradableSymbols).toEqual([]);
    expect(agg.newestLastTickAt).toBe(NOW);
  });

  it("both unhealthy infra: shared degraded", () => {
    const agg = aggregateMt5SessionHealth([
      {
        symbol: "R_10",
        shouldDegradeShared: true,
        reasonCode: MT5_BRIDGE_CIRCUIT_OPEN,
        stateReason: MT5_BRIDGE_CIRCUIT_OPEN,
        symbolTradable: false,
        lastTickAt: null
      },
      {
        symbol: "XAUUSD",
        shouldDegradeShared: true,
        reasonCode: MT5_BRIDGE_CIRCUIT_OPEN,
        stateReason: MT5_BRIDGE_CIRCUIT_OPEN,
        symbolTradable: false,
        lastTickAt: null
      }
    ]);
    expect(agg.sharedDegraded).toBe(true);
    expect(agg.canRecoverShared).toBe(false);
    expect(agg.degradedSymbols).toEqual(["R_10", "XAUUSD"]);
  });

  it("recovery after Gold reopens: XAU tradable again keeps shared healthy", () => {
    const closed = aggregateMt5SessionHealth([
      {
        symbol: "R_10",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW - 10_000
      },
      {
        symbol: "XAUUSD",
        shouldDegradeShared: false,
        reasonCode: MT5_SYMBOL_MARKET_CLOSED,
        stateReason: MT5_SYMBOL_MARKET_CLOSED,
        symbolTradable: false,
        lastTickAt: null
      }
    ]);
    expect(closed.sharedDegraded).toBe(false);

    const reopened = aggregateMt5SessionHealth([
      {
        symbol: "R_10",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW
      },
      {
        symbol: "XAUUSD",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW - 200
      }
    ]);
    expect(reopened.sharedDegraded).toBe(false);
    expect(reopened.canRecoverShared).toBe(true);
    expect(reopened.nonTradableSymbols).toEqual([]);
    expect(reopened.newestLastTickAt).toBe(NOW);
  });

  it("one infra failure degrades shared even if sibling is healthy", () => {
    const agg = aggregateMt5SessionHealth([
      {
        symbol: "R_10",
        shouldDegradeShared: false,
        reasonCode: null,
        stateReason: null,
        symbolTradable: true,
        lastTickAt: NOW
      },
      {
        symbol: "XAUUSD",
        shouldDegradeShared: true,
        reasonCode: MT5_QUOTE_FEED_UNAVAILABLE,
        stateReason: MT5_QUOTE_FEED_UNAVAILABLE,
        symbolTradable: false,
        lastTickAt: null
      }
    ]);
    expect(agg.sharedDegraded).toBe(true);
    expect(agg.canRecoverShared).toBe(false);
    expect(agg.degradedSymbols).toEqual(["XAUUSD"]);
  });
});

describe("shouldConsumeStrategySignalCooldown", () => {
  it("8. lifecycle-blocked signal does not consume cooldown", () => {
    expect(
      shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "LIFECYCLE_BLOCKED" })
    ).toBe(false);
    expect(
      shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "RECONCILIATION_UNAVAILABLE" })
    ).toBe(false);
    expect(
      shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "MT5_BRIDGE_UNHEALTHY" })
    ).toBe(false);
  });

  it("9. submitted/executed signals consume cooldown", () => {
    expect(shouldConsumeStrategySignalCooldown({ opened: true, decisionCode: "OPENED" })).toBe(true);
    expect(
      shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "EXECUTION_REJECTED" })
    ).toBe(true);
    expect(
      shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "EXECUTION_AMBIGUOUS" })
    ).toBe(true);
  });

  it("capacity/risk blocks before submission do not consume cooldown", () => {
    expect(
      shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "MAX_CONCURRENT_POSITIONS" })
    ).toBe(false);
    expect(shouldConsumeStrategySignalCooldown({ opened: false, decisionCode: "RISK_BLOCKED" })).toBe(
      false
    );
  });
});
