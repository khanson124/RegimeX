import { type AppConfig } from "@regimex/config";
import { type PrismaClient } from "@regimex/database";
import {
  selectMt5PositionsForEmergencyClose,
  buildExitCostTelemetry
} from "@regimex/trading-engine";
import { getOrConnectMt5Adapter } from "./mt5AdapterFactory.js";
import { type Logger } from "pino";
import { refreshEvidenceForClosedPosition } from "./mt5ForwardEvidence.js";
import {
  createTelegramTradeNotifier,
  type TelegramTradeNotifier
} from "../notifications/telegram.js";
import { closeLocalPositionIfCloseable } from "./mt5ExecutionIntegrity.js";

async function attachExitCostTelemetry(input: {
  prisma: PrismaClient;
  positionId: string;
  direction: string;
  symbol: string;
  closeReason: string;
  actualExitPrice: number | null;
  preCloseQuote: { bid: number; ask: number; timestamp?: number } | null;
  tickSize?: number;
}): Promise<void> {
  const existing = await input.prisma.position.findUnique({
    where: { id: input.positionId },
    select: { metadata: true }
  });
  const meta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const exitCostTelemetry = buildExitCostTelemetry({
    closeReason: input.closeReason,
    direction: input.direction as "BUY" | "SELL",
    actualExitPrice: input.actualExitPrice,
    localClosedAtMs: Date.now(),
    preCloseQuote: input.preCloseQuote
      ? {
          bid: input.preCloseQuote.bid,
          ask: input.preCloseQuote.ask,
          brokerQuoteTimestampMs: input.preCloseQuote.timestamp ?? null,
          localReceivedAtMs: Date.now(),
          tickSize: input.tickSize ?? 0.001,
          symbol: input.symbol
        }
      : null
  });
  await input.prisma.position.update({
    where: { id: input.positionId },
    data: {
      metadata: {
        ...meta,
        exitCostTelemetry
      } as object
    }
  });
}

export async function closeMt5LocalPosition(input: {
  prisma: PrismaClient;
  config: AppConfig;
  userId: string;
  positionId: string;
  logger: Logger;
  telegram?: TelegramTradeNotifier;
}): Promise<{ closed: boolean; reasons: string[] }> {
  const pos = await input.prisma.position.findFirst({
    where: { id: input.positionId, userId: input.userId }
  });
  if (!pos) return { closed: false, reasons: ["Position not found"] };
  if (pos.status === "CLOSED") return { closed: true, reasons: ["Already closed"] };
  if (!pos.brokerPositionId) return { closed: false, reasons: ["No brokerPositionId"] };

  const meta = (pos.metadata ?? {}) as { ownedByRegimeX?: boolean; magic?: number };
  if (meta.ownedByRegimeX === false) {
    return { closed: false, reasons: ["Refusing to close EXTERNAL/manual MT5 position"] };
  }

  const adapter = await getOrConnectMt5Adapter(input.config);
  let preCloseQuote: { bid: number; ask: number; timestamp?: number } | null = null;
  try {
    const brokerSymbol =
      ((pos.metadata ?? {}) as { brokerSymbol?: string }).brokerSymbol ?? pos.symbol;
    preCloseQuote = (await adapter.getQuote(brokerSymbol)) ?? null;
  } catch {
    preCloseQuote = null;
  }
  const closed = await adapter.closePosition({
    brokerPositionId: pos.brokerPositionId,
    reason: "MANUAL"
  });
  const closedAt = new Date();
  const applied = await closeLocalPositionIfCloseable({
    prisma: input.prisma,
    positionId: pos.id,
    data: {
      closePrice: closed.closePrice,
      realizedPnl: closed.realizedPnl,
      closeReason: "MANUAL",
      closedAt
    },
    logger: input.logger
  });
  if (!applied.applied) {
    return { closed: true, reasons: ["Already closed or stale state"] };
  }
  await attachExitCostTelemetry({
    prisma: input.prisma,
    positionId: pos.id,
    direction: pos.direction,
    symbol: pos.symbol,
    closeReason: "MANUAL",
    actualExitPrice: closed.closePrice,
    preCloseQuote
  });
  await input.prisma.positionEvent.create({
    data: {
      positionId: pos.id,
      eventType: "CLOSED",
      payload: { ...closed, venue: "MT5_DEMO" } as object
    }
  });
  input.logger.info(
    { positionId: pos.id, brokerPositionId: pos.brokerPositionId },
    "MT5 position closed after broker confirmation"
  );
  const telegram =
    input.telegram ??
    createTelegramTradeNotifier({
      config: input.config,
      prisma: input.prisma,
      logger: input.logger
    });
  telegram.notifyClosed({
    positionId: pos.id,
    symbol: pos.symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice != null ? Number(pos.entryPrice) : null,
    exitPrice: closed.closePrice,
    volume: Number(pos.volume),
    realizedPnl: closed.realizedPnl,
    closeReason: "MANUAL",
    strategyId: pos.strategyId,
    brokerPositionId: pos.brokerPositionId,
    openedAt: pos.openedAt,
    closedAt
  });
  await refreshEvidenceForClosedPosition(input.prisma, input.config, pos);
  return { closed: true, reasons: [] };
}

export async function emergencyCloseOwnedMt5Positions(input: {
  prisma: PrismaClient;
  config: AppConfig;
  userId: string;
  logger: Logger;
}): Promise<{ closed: string[]; skipped: string[]; failed: string[] }> {
  const adapter = await getOrConnectMt5Adapter(input.config);
  const brokerOpen = await adapter.getOpenPositions();
  const localOpen = await input.prisma.position.findMany({
    where: { userId: input.userId, status: { in: ["OPEN", "PENDING", "OPEN_REQUESTED"] } }
  });
  const localIds = new Set(
    localOpen.map((p) => p.brokerPositionId).filter((id): id is string => Boolean(id))
  );
  const plan = selectMt5PositionsForEmergencyClose({
    brokerOpen: brokerOpen.map((p) => ({
      positionTicket: Number(p.brokerPositionId),
      orderTicket: Number(p.metadata?.orderTicket ?? 0),
      dealTicket: p.metadata?.dealTicket != null ? Number(p.metadata.dealTicket) : null,
      symbol: p.symbol,
      direction: p.direction,
      volume: p.volume,
      entryPrice: p.entryPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      currentPrice: p.currentPrice,
      floatingPnl: p.floatingPnl,
      magic: Number(p.metadata?.magic ?? 0),
      comment: String(p.metadata?.comment ?? ""),
      openedAt: p.openedAt
    })),
    localBrokerIds: localIds,
    magic: input.config.MT5_MAGIC_NUMBER
  });

  const closed: string[] = [];
  const failed: string[] = [];
  const telegram = createTelegramTradeNotifier({
    config: input.config,
    prisma: input.prisma,
    logger: input.logger
  });
  for (const id of plan.close) {
    try {
      const result = await adapter.closePosition({ brokerPositionId: id, reason: "RISK_SHUTDOWN" });
      const closedAt = new Date();
      const local = localOpen.find((p) => p.brokerPositionId === id);
      if (!local) {
        failed.push(`${id}:local_missing`);
        continue;
      }
      const applied = await closeLocalPositionIfCloseable({
        prisma: input.prisma,
        positionId: local.id,
        data: {
          closePrice: result.closePrice,
          realizedPnl: result.realizedPnl,
          closeReason: "RISK_SHUTDOWN",
          closedAt
        },
        logger: input.logger
      });
      if (!applied.applied) continue;
      closed.push(id);
      telegram.notifyClosed({
        positionId: local.id,
        symbol: local.symbol,
        direction: local.direction,
        entryPrice: local.entryPrice != null ? Number(local.entryPrice) : null,
        exitPrice: result.closePrice,
        volume: Number(local.volume),
        realizedPnl: result.realizedPnl,
        closeReason: "RISK_SHUTDOWN",
        strategyId: local.strategyId,
        brokerPositionId: local.brokerPositionId,
        openedAt: local.openedAt,
        closedAt
      });
      await refreshEvidenceForClosedPosition(input.prisma, input.config, local);
    } catch (err) {
      failed.push(`${id}:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  input.logger.warn(
    { closed, skipped: plan.skipExternal, failed },
    "MT5 emergency close of RegimeX-owned positions only"
  );
  return { closed, skipped: plan.skipExternal, failed };
}
