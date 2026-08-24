import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { roundMoney, type InstrumentMetadata } from "@regimex/shared";
import { mapDbInstrumentMetadata } from "@regimex/trading-engine";

const num = (v: { toNumber(): number } | number) => (typeof v === "number" ? v : v.toNumber());

export async function ensurePaperAccount(
  prisma: PrismaClient,
  userId: string,
  config: Pick<AppConfig, "PAPER_INITIAL_BALANCE">
): Promise<{ id: string; equity: number; balance: number }> {
  const existing = await prisma.paperAccount.findUnique({ where: { userId } });
  if (existing) {
    return {
      id: existing.id,
      equity: num(existing.equity),
      balance: num(existing.balance)
    };
  }

  const initial = config.PAPER_INITIAL_BALANCE;
  const created = await prisma.paperAccount.create({
    data: {
      userId,
      currency: "USD",
      initialBalance: initial,
      balance: initial,
      equity: initial,
      usedMargin: 0,
      freeMargin: initial,
      realizedPnl: 0,
      floatingPnl: 0
    }
  });
  return { id: created.id, equity: initial, balance: initial };
}

export async function persistPaperAccountSnapshot(
  prisma: PrismaClient,
  paperAccountId: string,
  snapshot: {
    balance: number;
    equity: number;
    usedMargin: number;
    freeMargin: number;
    realizedPnl: number;
    floatingPnl: number;
  }
): Promise<void> {
  await prisma.paperAccount.update({
    where: { id: paperAccountId },
    data: {
      balance: roundMoney(snapshot.balance),
      equity: roundMoney(snapshot.equity),
      usedMargin: roundMoney(snapshot.usedMargin),
      freeMargin: roundMoney(snapshot.freeMargin),
      realizedPnl: roundMoney(snapshot.realizedPnl),
      floatingPnl: roundMoney(snapshot.floatingPnl)
    }
  });
}

export async function loadInstrumentMetadata(
  prisma: PrismaClient,
  symbol: string
): Promise<InstrumentMetadata | null> {
  const symbolRow = await prisma.symbol.findUnique({ where: { derivSymbol: symbol } });
  if (!symbolRow) return null;
  const row = await prisma.instrumentMetadata.findUnique({
    where: { symbolId: symbolRow.id },
    include: { symbol: true }
  });
  if (!row) return null;
  return mapDbInstrumentMetadata({
    enabled: row.enabled,
    verified: row.verified,
    source: row.source,
    notes: row.notes,
    contractSize: row.contractSize,
    volumeStep: row.volumeStep,
    minVolume: row.minVolume,
    maxVolume: row.maxVolume,
    tickSize: row.tickSize,
    tickValue: row.tickValue,
    marginRate: row.marginRate,
    spreadBps: row.spreadBps,
    slippageBps: row.slippageBps,
    currency: row.currency,
    symbol: row.symbol
  });
}

export async function recordPositionEvent(
  prisma: PrismaClient,
  positionId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await prisma.positionEvent.create({
    data: { positionId, eventType, payload: payload as object }
  });
}
