import { type AppConfig } from "@regimex/config";
import { type PrismaClient } from "@regimex/database";
import { type Logger } from "pino";
import { getOrConnectMt5Adapter } from "./mt5AdapterFactory.js";
import { recordPositionEvent } from "./paperPersistence.js";

/**
 * Worker-owned SL/TP modify for an open MT5 (or paper-synced) local position.
 * API never talks to the broker — only publishes MODIFY_POSITION.
 */
export async function modifyMt5LocalPosition(input: {
  prisma: PrismaClient;
  config: AppConfig;
  userId: string;
  positionId: string;
  stopLoss: number;
  takeProfit?: number | null;
  logger: Logger;
}): Promise<{ modified: boolean; reasons: string[] }> {
  const pos = await input.prisma.position.findFirst({
    where: { id: input.positionId, userId: input.userId }
  });
  if (!pos) return { modified: false, reasons: ["Position not found"] };
  if (pos.status !== "OPEN") {
    return { modified: false, reasons: [`Cannot modify position in status ${pos.status}`] };
  }
  if (!pos.brokerPositionId) {
    return { modified: false, reasons: ["No brokerPositionId"] };
  }

  const meta = (pos.metadata ?? {}) as { ownedByRegimeX?: boolean };
  if (meta.ownedByRegimeX === false) {
    return { modified: false, reasons: ["Refusing to modify EXTERNAL/manual MT5 position"] };
  }

  if (!Number.isFinite(input.stopLoss) || !(input.stopLoss > 0)) {
    return { modified: false, reasons: ["Invalid stopLoss"] };
  }

  const existingTp =
    input.takeProfit !== undefined
      ? input.takeProfit
      : pos.takeProfit != null
        ? Number(pos.takeProfit)
        : null;

  const adapter = await getOrConnectMt5Adapter(input.config);
  try {
    await adapter.modifyPosition({
      brokerPositionId: pos.brokerPositionId,
      stopLoss: input.stopLoss,
      takeProfit: existingTp
    });
  } catch (err) {
    input.logger.warn(
      { err, positionId: pos.id, brokerPositionId: pos.brokerPositionId },
      "MT5 modifyPosition failed"
    );
    return {
      modified: false,
      reasons: [err instanceof Error ? err.message : "modifyPosition failed"]
    };
  }

  await input.prisma.position.update({
    where: { id: pos.id },
    data: {
      stopLoss: input.stopLoss,
      ...(existingTp != null ? { takeProfit: existingTp } : {})
    }
  });

  await recordPositionEvent(input.prisma, pos.id, "MANUAL_SL_UPDATED", {
    oldStopLoss: pos.stopLoss != null ? Number(pos.stopLoss) : null,
    newStopLoss: input.stopLoss,
    takeProfit: existingTp,
    brokerPositionId: pos.brokerPositionId,
    source: "api"
  });

  input.logger.info(
    {
      positionId: pos.id,
      brokerPositionId: pos.brokerPositionId,
      stopLoss: input.stopLoss,
      takeProfit: existingTp
    },
    "MT5 position stop modified"
  );

  return { modified: true, reasons: [] };
}
