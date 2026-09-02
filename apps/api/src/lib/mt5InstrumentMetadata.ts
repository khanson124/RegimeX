import { type PrismaClient } from "@regimex/database";
import { type InstrumentMetadata } from "@regimex/shared";

export function instrumentMetadataUpsertFields(meta: InstrumentMetadata) {
  return {
    enabled: meta.enabled,
    verified: meta.verified,
    source: meta.source ?? "mt5_live_discovery",
    notes: meta.notes ?? null,
    contractSize: meta.contractSize,
    volumeStep: meta.volumeStep,
    minVolume: meta.minVolume,
    maxVolume: meta.maxVolume,
    tickSize: meta.tickSize,
    tickValue: meta.tickValue,
    marginRate: meta.marginRate,
    spreadBps: meta.spreadBps,
    slippageBps: meta.slippageBps,
    currency: meta.currency
  };
}

export async function upsertInternalInstrumentMetadataFromMt5(
  prisma: PrismaClient,
  symbolId: string,
  meta: InstrumentMetadata
) {
  const fields = instrumentMetadataUpsertFields(meta);
  return prisma.instrumentMetadata.upsert({
    where: { symbolId },
    create: { symbolId, ...fields },
    update: fields
  });
}
