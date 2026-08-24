import { describe, expect, it } from "vitest";
import { InstrumentMetadataRegistry } from "./instrumentRegistry.js";
import { PaperCFDBrokerAdapter } from "./paperCFDBroker.js";
import { type InstrumentMetadata } from "@regimex/shared";

const instrument: InstrumentMetadata = {
  symbol: "R_10",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 5,
  tickSize: 0.01,
  tickValue: 1,
  marginRate: 0.01,
  spreadBps: 12,
  slippageBps: 4,
  pricePrecision: 3,
  currency: "USD"
};

describe("PaperCFDBrokerAdapter", () => {
  it("maintains separate balance/equity/margin state", async () => {
    const registry = new InstrumentMetadataRegistry();
    registry.register(instrument);
    const broker = new PaperCFDBrokerAdapter(registry, {
      currency: "USD",
      initialBalance: 10_000,
      fallbackSpreadBps: 10,
      fallbackSlippageBps: 5,
      maxQuoteAgeMs: 30_000
    });
    await broker.connect();
    broker.setQuote({ symbol: "R_10", bid: 1000, ask: 1000.2, mid: 1000.1, timestamp: Date.now() });

    const accountBefore = await broker.getAccount();
    expect(accountBefore.balance).toBe(10_000);
    expect(accountBefore.equity).toBe(10_000);

    const open = await broker.openMarketPosition({
      idempotencyKey: "test-key-1",
      symbol: "R_10",
      direction: "BUY",
      volume: 0.1,
      stopLoss: 990,
      takeProfit: 1020,
      quote: { symbol: "R_10", bid: 1000, ask: 1000.2, mid: 1000.1, timestamp: Date.now() },
      instrument,
      riskAmount: 50,
      riskPercent: 0.5,
      initialRiskReward: 2,
      marginRequired: 1
    });

    expect(open.accepted).toBe(true);
    expect(open.appliedSpreadBps).toBe(12);
    expect(open.appliedSlippageBps).toBe(4);

    const accountAfter = await broker.getAccount();
    expect(accountAfter.usedMargin).toBeGreaterThan(0);
    expect(accountAfter.freeMargin).toBeLessThan(accountAfter.equity);

    const dup = await broker.openMarketPosition({
      idempotencyKey: "test-key-1",
      symbol: "R_10",
      direction: "BUY",
      volume: 0.1,
      stopLoss: 990,
      takeProfit: 1020,
      quote: { symbol: "R_10", bid: 1000, ask: 1000.2, mid: 1000.1, timestamp: Date.now() },
      instrument,
      riskAmount: 50,
      riskPercent: 0.5,
      initialRiskReward: 2,
      marginRequired: 1
    });
    expect(dup.brokerPositionId).toBe(open.brokerPositionId);
  });

  it("fails closed without enabled instrument metadata", async () => {
    const registry = new InstrumentMetadataRegistry();
    const broker = new PaperCFDBrokerAdapter(registry, {
      currency: "USD",
      initialBalance: 10_000,
      fallbackSpreadBps: 10,
      fallbackSlippageBps: 5,
      maxQuoteAgeMs: 30_000
    });
    await broker.connect();

    const open = await broker.openMarketPosition({
      idempotencyKey: "missing-meta",
      symbol: "R_10",
      direction: "BUY",
      volume: 0.1,
      stopLoss: 990,
      takeProfit: 1020,
      quote: { symbol: "R_10", bid: 1000, ask: 1000.2, mid: 1000.1, timestamp: Date.now() },
      instrument: { ...instrument, enabled: false },
      riskAmount: 50,
      riskPercent: 0.5,
      initialRiskReward: 2,
      marginRequired: 1
    });
    expect(open.accepted).toBe(false);
  });
});
