import { type PrismaClient } from "@regimex/database";
import { type Logger } from "pino";
import { type BrokerOpenPosition } from "@regimex/shared";
import { evaluateR10ProfitLock, R10_PROFIT_LOCK_SYMBOL } from "@regimex/trading-engine";
import { recordPositionEvent } from "./paperPersistence.js";

export type ProfitLockLocalPosition = {
  id: string;
  symbol: string;
  status: string;
  direction: string;
  entryPrice: unknown;
  initialStopLoss: unknown;
  stopLoss: unknown;
  takeProfit: unknown;
  brokerPositionId: string | null;
  currentPrice: unknown;
};

export type ProfitLockBrokerAdapter = {
  modifyPosition(request: {
    brokerPositionId: string;
    stopLoss: number;
    takeProfit?: number | null;
  }): Promise<BrokerOpenPosition>;
};

/**
 * Progressive R_10 profit-lock during open-position reconciliation.
 * Mutates matching entries in `brokerOpen` after a successful modify so
 * subsequent SL/TP sync does not overwrite with stale broker stops.
 */
export async function applyR10ProfitLocks(input: {
  prisma: PrismaClient;
  adapter: ProfitLockBrokerAdapter;
  logger: Logger;
  brokerOpen: BrokerOpenPosition[];
  localOpen: ProfitLockLocalPosition[];
}): Promise<void> {
  const { prisma, adapter, logger, brokerOpen, localOpen } = input;

  for (const local of localOpen) {
    if (local.symbol !== R10_PROFIT_LOCK_SYMBOL) continue;
    if (local.status !== "OPEN") continue;
    if (!local.brokerPositionId) continue;

    const broker = brokerOpen.find((p) => p.brokerPositionId === local.brokerPositionId);
    if (!broker) continue;

    const entryPrice = local.entryPrice != null ? Number(local.entryPrice) : null;
    const initialStopLoss = local.initialStopLoss != null ? Number(local.initialStopLoss) : null;
    const existingTakeProfit =
      broker.takeProfit != null
        ? Number(broker.takeProfit)
        : local.takeProfit != null
          ? Number(local.takeProfit)
          : null;

    const decision = evaluateR10ProfitLock({
      symbol: local.symbol,
      status: local.status,
      direction: local.direction,
      entryPrice,
      initialStopLoss,
      currentStopLoss: broker.stopLoss,
      currentPrice: broker.currentPrice,
      brokerPositionId: local.brokerPositionId,
      takeProfit: existingTakeProfit
    });

    if (decision.action !== "MODIFY") continue;

    try {
      await adapter.modifyPosition({
        brokerPositionId: local.brokerPositionId,
        stopLoss: decision.proposedStop,
        takeProfit: existingTakeProfit
      });
    } catch (err) {
      logger.warn(
        {
          err,
          positionId: local.id,
          brokerPositionId: local.brokerPositionId,
          proposedStop: decision.proposedStop,
          favorableR: decision.favorableR,
          protectedR: decision.protectedR
        },
        "MT5 profit-lock modifyPosition failed; continuing reconcile"
      );
      continue;
    }

    // Keep in-memory broker snapshot aligned so later SL/TP sync won't regress.
    broker.stopLoss = decision.proposedStop;
    if (existingTakeProfit != null) broker.takeProfit = existingTakeProfit;

    await prisma.position.update({
      where: { id: local.id },
      data: {
        stopLoss: decision.proposedStop,
        currentPrice: broker.currentPrice,
        ...(existingTakeProfit != null ? { takeProfit: existingTakeProfit } : {})
      }
    });

    // Keep the in-memory local snapshot aligned for the subsequent SL/TP plan.
    local.stopLoss = decision.proposedStop;
    local.currentPrice = broker.currentPrice;

    await recordPositionEvent(prisma, local.id, "PROFIT_LOCK_UPDATED", {
      favorableR: decision.favorableR,
      protectedR: decision.protectedR,
      oldStopLoss: decision.oldStopLoss,
      newStopLoss: decision.proposedStop,
      currentPrice: broker.currentPrice,
      entryPrice,
      initialStopLoss,
      brokerPositionId: local.brokerPositionId
    });

    logger.info(
      {
        positionId: local.id,
        brokerPositionId: local.brokerPositionId,
        favorableR: decision.favorableR,
        protectedR: decision.protectedR,
        oldStopLoss: decision.oldStopLoss,
        newStopLoss: decision.proposedStop,
        currentPrice: broker.currentPrice
      },
      "MT5 profit-lock stop updated"
    );
  }
}
