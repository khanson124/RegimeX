import { type PrismaClient } from "@regimex/database";
import { mappingRecordFromRow, type BrokerSymbolMappingRecord } from "@regimex/trading-engine";

export async function loadMt5BrokerMappings(prisma: PrismaClient): Promise<BrokerSymbolMappingRecord[]> {
  const rows = await prisma.brokerSymbolMapping.findMany({
    where: { venue: "MT5", executionMode: "broker_demo_mt5" },
    include: { symbol: true }
  });
  return rows.map(mappingRecordFromRow);
}
