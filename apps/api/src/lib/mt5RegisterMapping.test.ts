import { type PrismaClient } from "@regimex/database";
import { ValidationError } from "@regimex/shared";
import { defaultVolatilitySymbol, mapMt5SymbolToInstrument } from "@regimex/trading-engine";
import { describe, expect, it, vi } from "vitest";
import { registerMt5BrokerMapping } from "./mt5RegisterMapping.js";

const INTERNAL_SYMBOL_ID = "sym-internal-r10";
const INTERNAL_SYMBOL = {
  id: INTERNAL_SYMBOL_ID,
  derivSymbol: "R_10",
  displayName: "Volatility 10 Index",
  enabled: true,
  pricePrecision: 3,
  candleIntervals: ["1m", "5m"],
  createdAt: new Date(),
  updatedAt: new Date()
};

function verifiedLiveSymbol() {
  return defaultVolatilitySymbol();
}

function unverifiedLiveSymbol() {
  return {
    ...defaultVolatilitySymbol(),
    tradeAllowed: false,
    tradeMode: "DISABLED" as const
  };
}

function createPrismaMock(options: {
  existingMetadata?: Record<string, unknown> | null;
  mappingId?: string;
}) {
  const metadataStore = options.existingMetadata
    ? { ...options.existingMetadata, symbolId: INTERNAL_SYMBOL_ID }
    : null;

  const prisma = {
    symbol: {
      findUnique: vi.fn(async () => INTERNAL_SYMBOL),
      upsert: vi.fn(),
      create: vi.fn()
    },
    brokerSymbolMapping: {
      upsert: vi.fn(async () => ({
        id: options.mappingId ?? "mapping-1",
        internalSymbolId: INTERNAL_SYMBOL_ID,
        broker: "Deriv",
        venue: "MT5",
        executionMode: "broker_demo_mt5",
        brokerSymbol: "Volatility 10 Index",
        verified: true,
        source: "mt5_live_discovery",
        notes: "test",
        minVolume: 0.01,
        volumeStep: 0.01,
        maxVolume: 100,
        tickSize: 0.001,
        tickValue: 0.001,
        contractSize: 1,
        fillingMode: "FOK",
        createdAt: new Date(),
        updatedAt: new Date()
      }))
    },
    instrumentMetadata: {
      upsert: vi.fn(async (args: {
        where: { symbolId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const payload = metadataStore
          ? { ...metadataStore, ...args.update, symbolId: args.where.symbolId }
          : { id: "meta-1", ...args.create };
        metadataStore && Object.assign(metadataStore, payload);
        return payload;
      })
    }
  };

  return { prisma: prisma as unknown as PrismaClient, metadataStore };
}

describe("registerMt5BrokerMapping", () => {
  it("persists verified live MT5 metadata to InstrumentMetadata for the internal symbol", async () => {
    const { prisma } = createPrismaMock({});
    const live = verifiedLiveSymbol();
    const mapped = mapMt5SymbolToInstrument(live, "USD");

    const result = await registerMt5BrokerMapping(
      prisma,
      {
        getLiveSymbol: async () => live,
        getCurrency: () => "USD"
      },
      { internalSymbol: "R_10", brokerSymbol: live.name }
    );

    expect(prisma.symbol.findUnique).toHaveBeenCalledWith({
      where: { derivSymbol: "R_10" }
    });
    expect(prisma.symbol.upsert).not.toHaveBeenCalled();
    expect(prisma.symbol.create).not.toHaveBeenCalled();
    expect(prisma.instrumentMetadata.upsert).toHaveBeenCalledWith({
      where: { symbolId: INTERNAL_SYMBOL_ID },
      create: expect.objectContaining({
        symbolId: INTERNAL_SYMBOL_ID,
        enabled: mapped.instrument.enabled,
        verified: true,
        source: "mt5_live_discovery",
        contractSize: mapped.instrument.contractSize,
        volumeStep: mapped.instrument.volumeStep,
        minVolume: mapped.instrument.minVolume,
        maxVolume: mapped.instrument.maxVolume,
        tickSize: mapped.instrument.tickSize,
        tickValue: mapped.instrument.tickValue,
        marginRate: mapped.instrument.marginRate,
        spreadBps: mapped.instrument.spreadBps,
        slippageBps: mapped.instrument.slippageBps,
        currency: "USD"
      }),
      update: expect.objectContaining({
        verified: true,
        source: "mt5_live_discovery",
        contractSize: mapped.instrument.contractSize
      })
    });
    expect(result.instrumentMetadata).toMatchObject({
      symbolId: INTERNAL_SYMBOL_ID,
      verified: true,
      currency: "USD"
    });
    expect(result.mapping.internalSymbol).toBe("R_10");
  });

  it("updates existing InstrumentMetadata on re-registration", async () => {
    const { prisma } = createPrismaMock({
      existingMetadata: {
        id: "meta-existing",
        enabled: false,
        verified: false,
        source: "legacy",
        notes: "old",
        contractSize: 0.5,
        volumeStep: 0.05,
        minVolume: 0.05,
        maxVolume: 50,
        tickSize: 0.01,
        tickValue: 0.01,
        marginRate: 0.02,
        spreadBps: 1,
        slippageBps: 2,
        currency: "EUR"
      }
    });
    const live = verifiedLiveSymbol();
    const mapped = mapMt5SymbolToInstrument(live, "USD");

    const result = await registerMt5BrokerMapping(
      prisma,
      {
        getLiveSymbol: async () => live,
        getCurrency: () => "USD"
      },
      { internalSymbol: "R_10", brokerSymbol: live.name }
    );

    expect(prisma.instrumentMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { symbolId: INTERNAL_SYMBOL_ID },
        update: expect.objectContaining({
          verified: true,
          source: "mt5_live_discovery",
          contractSize: mapped.instrument.contractSize,
          currency: "USD"
        })
      })
    );
    expect(result.instrumentMetadata.verified).toBe(true);
    expect(result.instrumentMetadata.contractSize).toBe(mapped.instrument.contractSize);
  });

  it("rejects unverified MT5 metadata and does not persist InstrumentMetadata", async () => {
    const { prisma } = createPrismaMock({});
    const live = unverifiedLiveSymbol();

    await expect(
      registerMt5BrokerMapping(
        prisma,
        {
          getLiveSymbol: async () => live,
          getCurrency: () => "USD"
        },
        { internalSymbol: "R_10", brokerSymbol: live.name }
      )
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prisma.brokerSymbolMapping.upsert).not.toHaveBeenCalled();
    expect(prisma.instrumentMetadata.upsert).not.toHaveBeenCalled();
    expect(prisma.symbol.upsert).not.toHaveBeenCalled();
    expect(prisma.symbol.create).not.toHaveBeenCalled();
  });

  it("does not create a duplicate internal Symbol row", async () => {
    const { prisma } = createPrismaMock({});

    await registerMt5BrokerMapping(
      prisma,
      {
        getLiveSymbol: async () => verifiedLiveSymbol(),
        getCurrency: () => "USD"
      },
      { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" }
    );

    expect(prisma.symbol.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.symbol.upsert).not.toHaveBeenCalled();
    expect(prisma.symbol.create).not.toHaveBeenCalled();
  });
});
