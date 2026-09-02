import { type PrismaClient } from "@regimex/database";
import { ValidationError } from "@regimex/shared";
import {
  isVolatilityOneSecondVariant,
  mapMt5SymbolToInstrument,
  type Mt5SymbolInfo
} from "@regimex/trading-engine";
import { upsertInternalInstrumentMetadataFromMt5 } from "./mt5InstrumentMetadata.js";

export interface RegisterMt5MappingInput {
  internalSymbol: string;
  brokerSymbol: string;
}

export interface RegisterMt5MappingDeps {
  getLiveSymbol: (brokerSymbol: string) => Promise<Mt5SymbolInfo | null>;
  getCurrency: () => string;
}

export async function registerMt5BrokerMapping(
  prisma: PrismaClient,
  deps: RegisterMt5MappingDeps,
  body: RegisterMt5MappingInput
) {
  if (isVolatilityOneSecondVariant(body.brokerSymbol)) {
    throw new ValidationError("Do not map (1s) variants onto R_10/R_25/R_50/R_75/R_100");
  }

  const internal = await prisma.symbol.findUnique({
    where: { derivSymbol: body.internalSymbol }
  });
  if (!internal) {
    throw new ValidationError(`Unknown internal RegimeX symbol: ${body.internalSymbol}`);
  }

  const live = await deps.getLiveSymbol(body.brokerSymbol);
  if (!live) {
    throw new ValidationError(`MT5 symbol not found: ${body.brokerSymbol}`);
  }
  if (isVolatilityOneSecondVariant(live.name)) {
    throw new ValidationError("Live MT5 name is a (1s) variant and cannot map to R_10/R_25/…");
  }

  const mapped = mapMt5SymbolToInstrument(live, deps.getCurrency());
  const meta = mapped.instrument;
  if (!meta.verified) {
    throw new ValidationError(
      `MT5 instrument ${live.name} is not verified (${mapped.reasons.join("; ") || "incomplete metadata"})`
    );
  }

  const mapping = await prisma.brokerSymbolMapping.upsert({
    where: {
      internalSymbolId_broker_venue_executionMode: {
        internalSymbolId: internal.id,
        broker: "Deriv",
        venue: "MT5",
        executionMode: "broker_demo_mt5"
      }
    },
    create: {
      internalSymbolId: internal.id,
      broker: "Deriv",
      venue: "MT5",
      executionMode: "broker_demo_mt5",
      brokerSymbol: live.name,
      verified: true,
      source: "mt5_live_discovery",
      notes: meta.notes ?? null,
      minVolume: meta.minVolume,
      volumeStep: meta.volumeStep,
      maxVolume: meta.maxVolume,
      tickSize: meta.tickSize,
      tickValue: meta.tickValue,
      contractSize: meta.contractSize,
      fillingMode: mapped.selectedFillingMode
    },
    update: {
      brokerSymbol: live.name,
      verified: true,
      source: "mt5_live_discovery",
      notes: meta.notes ?? null,
      minVolume: meta.minVolume,
      volumeStep: meta.volumeStep,
      maxVolume: meta.maxVolume,
      tickSize: meta.tickSize,
      tickValue: meta.tickValue,
      contractSize: meta.contractSize,
      fillingMode: mapped.selectedFillingMode
    }
  });

  const instrumentMetadata = await upsertInternalInstrumentMetadataFromMt5(prisma, internal.id, meta);

  return {
    mapping: {
      id: mapping.id,
      internalSymbol: internal.derivSymbol,
      brokerSymbol: mapping.brokerSymbol,
      broker: mapping.broker,
      venue: mapping.venue,
      executionMode: mapping.executionMode,
      verified: mapping.verified,
      source: mapping.source,
      minVolume: Number(mapping.minVolume),
      volumeStep: Number(mapping.volumeStep),
      maxVolume: Number(mapping.maxVolume),
      tickSize: Number(mapping.tickSize),
      tickValue: Number(mapping.tickValue),
      contractSize: Number(mapping.contractSize),
      fillingMode: mapping.fillingMode
    },
    instrumentMetadata: {
      symbolId: instrumentMetadata.symbolId,
      enabled: instrumentMetadata.enabled,
      verified: instrumentMetadata.verified,
      source: instrumentMetadata.source,
      notes: instrumentMetadata.notes,
      contractSize: Number(instrumentMetadata.contractSize),
      volumeStep: Number(instrumentMetadata.volumeStep),
      minVolume: Number(instrumentMetadata.minVolume),
      maxVolume: Number(instrumentMetadata.maxVolume),
      tickSize: Number(instrumentMetadata.tickSize),
      tickValue: Number(instrumentMetadata.tickValue),
      marginRate: Number(instrumentMetadata.marginRate),
      spreadBps: Number(instrumentMetadata.spreadBps),
      slippageBps: Number(instrumentMetadata.slippageBps),
      currency: instrumentMetadata.currency
    },
    live: {
      name: live.name,
      tradeMode: live.tradeMode,
      filling: mapped.selectedFillingMode
    },
    tradingEnabled: false,
    note: "Mapping verified from live MT5 discovery. This does not enable autonomous execution."
  };
}
