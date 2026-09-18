import { type AppConfig } from "@regimex/config";
import { type PrismaClient } from "@regimex/database";
import { type Logger } from "pino";
import { PaperCfdRuntime } from "./paperCfdRuntime.js";
import { recordPositionEvent } from "./paperPersistence.js";

/**
 * Update local paper position SL/TP and sync in-memory paper broker when possible.
 */
export async function modifyPaperLocalPosition(input: {
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

  const existingTp =
    input.takeProfit !== undefined
      ? input.takeProfit
      : pos.takeProfit != null
        ? Number(pos.takeProfit)
        : null;

  let modified = false;
  let reasons: string[] = [];
  try {
    const runtime = new PaperCfdRuntime(input.userId, {
      prisma: input.prisma,
      config: input.config,
      publish: async () => undefined,
      logger: input.logger
    });
    await runtime.init(pos.symbol);
    const result = await runtime.manualModify(pos.id, {
      stopLoss: input.stopLoss,
      takeProfit: existingTp
    });
    modified = result.modified;
    reasons = result.reasons;
  } catch (err) {
    input.logger.warn({ err, positionId: pos.id }, "Paper broker modify failed; updating local SL only");
    reasons = [err instanceof Error ? err.message : "paper modify failed"];
  }

  if (!modified) {
    await input.prisma.position.update({
      where: { id: pos.id },
      data: {
        stopLoss: input.stopLoss,
        ...(existingTp != null ? { takeProfit: existingTp } : {})
      }
    });
    modified = true;
    reasons = [];
  }

  await recordPositionEvent(input.prisma, pos.id, "MANUAL_SL_UPDATED", {
    oldStopLoss: pos.stopLoss != null ? Number(pos.stopLoss) : null,
    newStopLoss: input.stopLoss,
    takeProfit: existingTp,
    brokerPositionId: pos.brokerPositionId,
    source: "api"
  });

  return { modified, reasons };
}
