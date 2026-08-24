import { describe, expect, it } from "vitest";
import { MockMt5BridgeTransport, defaultVolatilitySymbol } from "./mockTransport.js";
import { DerivMT5BrokerAdapter } from "../derivMt5Broker.js";
import { DEFAULT_MT5_MAGIC } from "./types.js";
import {
  BROKER_SYMBOL_MAPPING_MISSING,
  BROKER_SYMBOL_MAPPING_UNVERIFIED,
  BROKER_SYMBOL_ONE_SECOND_VARIANT,
  BROKER_SYMBOL_UNAVAILABLE,
  MT5_SYNTHETIC_MAPPING_CANDIDATES,
  brokerSymbolForMt5Lookup,
  candidateBrokerSymbolForInternal,
  isVolatilityOneSecondVariant,
  mappingRecordFromRow,
  positionSymbolAudit,
  resolveBrokerSymbolMapping
} from "./brokerSymbolMapping.js";
import { planBrokerPositionReconciliation } from "../derivCfdReconciliation.js";

const verifiedV10 = {
  internalSymbol: "R_10",
  brokerSymbol: "Volatility 10 Index",
  verified: true,
  minVolume: 0.5,
  volumeStep: 0.01,
  maxVolume: 400
};

describe("broker symbol mapping", () => {
  it("lists V10-style candidates without treating them as verified", () => {
    expect(MT5_SYNTHETIC_MAPPING_CANDIDATES).toContainEqual({
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 Index"
    });
    expect(candidateBrokerSymbolForInternal("R_10")).toBe("Volatility 10 Index");
    expect(isVolatilityOneSecondVariant("Volatility 10 Index")).toBe(false);
    expect(isVolatilityOneSecondVariant("Volatility 10 (1s) Index")).toBe(true);
  });

  it("resolves a verified R_10 → Volatility 10 Index mapping", () => {
    const resolved = resolveBrokerSymbolMapping("R_10", verifiedV10);
    expect(resolved.ok).toBe(true);
    expect(resolved.brokerSymbol).toBe("Volatility 10 Index");
    expect(resolved.verified).toBe(true);
    expect(resolved.internalSymbol).toBe("R_10");
  });

  it("rejects a missing mapping fail-closed", () => {
    const resolved = resolveBrokerSymbolMapping("R_10", null);
    expect(resolved.ok).toBe(false);
    expect(resolved.reasonCode).toBe(BROKER_SYMBOL_MAPPING_MISSING);
    expect(resolved.brokerSymbol).toBeNull();
  });

  it("rejects an unverified mapping fail-closed", () => {
    const resolved = resolveBrokerSymbolMapping("R_10", { ...verifiedV10, verified: false });
    expect(resolved.ok).toBe(false);
    expect(resolved.reasonCode).toBe(BROKER_SYMBOL_MAPPING_UNVERIFIED);
    expect(resolved.brokerSymbol).toBe("Volatility 10 Index");
  });

  it("does not fall back to the internal name unless the mapping is verified identical", () => {
    expect(resolveBrokerSymbolMapping("R_10", null).brokerSymbol).not.toBe("R_10");
    const identical = resolveBrokerSymbolMapping("EURUSD", {
      internalSymbol: "EURUSD",
      brokerSymbol: "EURUSD",
      verified: true
    });
    expect(identical.ok).toBe(true);
    expect(identical.identicalNames).toBe(true);
    expect(identical.brokerSymbol).toBe("EURUSD");
  });

  it("never maps (1s) variants onto R_10", () => {
    const resolved = resolveBrokerSymbolMapping("R_10", {
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 (1s) Index",
      verified: true
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.reasonCode).toBe(BROKER_SYMBOL_ONE_SECOND_VARIANT);
  });

  it("treats an empty verified broker name as unavailable", () => {
    const resolved = resolveBrokerSymbolMapping("R_10", {
      internalSymbol: "R_10",
      brokerSymbol: "   ",
      verified: true
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.reasonCode).toBe(BROKER_SYMBOL_UNAVAILABLE);
  });

  it("keeps internal symbol on research/position audit and exposes both names", () => {
    expect(
      positionSymbolAudit({
        symbol: "R_10",
        metadata: { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" }
      })
    ).toEqual({ internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" });
  });

  it("uses brokerSymbol for MT5 lookup, not the internal catalogue id", () => {
    expect(
      brokerSymbolForMt5Lookup({
        symbol: "R_10",
        metadata: { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" }
      })
    ).toBe("Volatility 10 Index");
  });

  it("hydrates a Prisma-shaped row without mutating the internal symbol", () => {
    const record = mappingRecordFromRow({
      brokerSymbol: "Volatility 10 Index",
      verified: true,
      minVolume: { toNumber: () => 0.5 },
      volumeStep: 0.01,
      maxVolume: 400,
      symbol: { derivSymbol: "R_10" }
    });
    expect(record.internalSymbol).toBe("R_10");
    expect(record.brokerSymbol).toBe("Volatility 10 Index");
    expect(record.minVolume).toBe(0.5);
  });
});

describe("MT5 quote/open uses the broker-native name", () => {
  it("getQuote and getInstrument fail for R_10 and succeed for Volatility 10 Index", async () => {
    const live = defaultVolatilitySymbol();
    live.volumeMin = 0.5;
    live.volumeMax = 400;
    const mock = new MockMt5BridgeTransport({
      symbols: [live],
      quotes: [{ symbol: "Volatility 10 Index", bid: 4764, ask: 4764.2, timestamp: Date.now() }]
    });
    const adapter = new DerivMT5BrokerAdapter({
      requireDemoAccount: true,
      bridgeUrl: "http://mt5-bridge:8765",
      bridgeSecret: "test-secret-value-32chars-long!",
      timeoutMs: 5_000,
      maxQuoteAgeMs: 30_000,
      maxTestVolume: 1,
      maxTestRiskPercent: 5,
      magic: DEFAULT_MT5_MAGIC,
      expectedBroker: "Deriv",
      expectedEnvironment: "demo",
      transport: mock
    });
    await adapter.connect();

    expect(await adapter.getQuote("R_10")).toBeNull();
    expect(await adapter.getInstrumentMetadata("R_10")).toBeNull();
    const quote = await adapter.getQuote("Volatility 10 Index");
    expect(quote?.symbol).toBe("Volatility 10 Index");
    const meta = await adapter.getInstrumentMetadata("Volatility 10 Index");
    expect(meta?.symbol).toBe("Volatility 10 Index");
    expect(meta?.minVolume).toBe(0.5);
  });
});

describe("reconciliation uses brokerSymbol", () => {
  it("matches tickets independently of the internal research symbol", () => {
    const plan = planBrokerPositionReconciliation({
      brokerOpen: [{ brokerPositionId: "1001", stopLoss: 4750, takeProfit: 4780 }],
      localOpen: [
        {
          brokerPositionId: "1001",
          stopLoss: 4750,
          takeProfit: 4780,
          status: "OPEN"
        }
      ]
    });
    expect(plan.markLocalClosed).toEqual([]);
    expect(plan.updateSlTp).toEqual([]);
    expect(
      brokerSymbolForMt5Lookup({
        symbol: "R_10",
        metadata: { brokerSymbol: "Volatility 10 Index", internalSymbol: "R_10" }
      })
    ).toBe("Volatility 10 Index");
  });
});
