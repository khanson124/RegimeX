import { type PrismaClient } from "@regimex/database";
import { mappingRecordFromRow, type BrokerSymbolMappingRecord } from "@regimex/trading-engine";

export type Mt5MappingExecutionMode = "broker_demo_mt5" | "broker_real_mt5";

/**
 * Load MT5 broker symbol mappings for the active execution environment.
 * Prefer env-scoped rows; optionally include the other MT5 mode as migration fallback.
 */
export async function loadMt5BrokerMappings(
  prisma: PrismaClient,
  executionMode: Mt5MappingExecutionMode = "broker_demo_mt5",
  opts?: { includeFallback?: boolean }
): Promise<BrokerSymbolMappingRecord[]> {
  const preferred = await prisma.brokerSymbolMapping.findMany({
    where: { venue: "MT5", executionMode },
    include: { symbol: true }
  });
  if (!opts?.includeFallback) {
    return preferred.map(mappingRecordFromRow);
  }
  const fallbackMode: Mt5MappingExecutionMode =
    executionMode === "broker_real_mt5" ? "broker_demo_mt5" : "broker_real_mt5";
  const preferredSymbols = new Set(preferred.map((r) => r.symbol.derivSymbol));
  const fallback = await prisma.brokerSymbolMapping.findMany({
    where: { venue: "MT5", executionMode: fallbackMode },
    include: { symbol: true }
  });
  const merged = [
    ...preferred,
    ...fallback.filter((r) => !preferredSymbols.has(r.symbol.derivSymbol))
  ];
  return merged.map(mappingRecordFromRow);
}
