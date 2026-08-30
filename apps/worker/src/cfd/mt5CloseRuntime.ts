import { type AppConfig } from "@regimex/config";
import { type PrismaClient } from "@regimex/database";
import { selectMt5PositionsForEmergencyClose } from "@regimex/trading-engine";
import { getOrConnectMt5Adapter } from "./mt5AdapterFactory.js";
import { type Logger } from "pino";
import { refreshEvidenceForClosedPosition } from "./mt5ForwardEvidence.js";
import {
  createTelegramTradeNotifier,
  type TelegramTradeNotifier
} from "../notifications/telegram.js";

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
  const closed = await adapter.closePosition({
    brokerPositionId: pos.brokerPositionId,
    reason: "MANUAL"
  });
  const closedAt = new Date();
  await input.prisma.position.update({
    where: { id: pos.id },
    data: {
      status: "CLOSED",
      closePrice: closed.closePrice,
      realizedPnl: closed.realizedPnl,
      closeReason: "MANUAL",
      closedAt
    }
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
      await input.prisma.position.updateMany({
        where: { userId: input.userId, brokerPositionId: id },
        data: {
          status: "CLOSED",
          closePrice: result.closePrice,
          realizedPnl: result.realizedPnl,
          closeReason: "RISK_SHUTDOWN",
          closedAt
        }
      });
      closed.push(id);
      const local = localOpen.find((p) => p.brokerPositionId === id);
      if (local) {
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
      }
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
