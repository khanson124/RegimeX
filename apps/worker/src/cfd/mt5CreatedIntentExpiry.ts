import { type PrismaClient } from "@regimex/database";
import {
  type DerivMT5BrokerAdapter,
  CREATED_INTENT_RESUME_TTL_MS,
  EXECUTION_INTENT_EXPIRED,
  isCreatedIntentExpired
} from "@regimex/trading-engine";
import { type Logger } from "pino";
import {
  failClosedPendingExecution,
  tryRecoverExecutionIntentFromBroker
} from "./mt5ExecutionIntegrity.js";
import { recordPositionEvent } from "./paperPersistence.js";

/** How often reconcileOpen may sweep expired never-submitted CREATED intents. */
export const CREATED_INTENT_EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Bound each sweep so heartbeat never scans unbounded history. */
export const CREATED_INTENT_EXPIRY_SWEEP_LIMIT = 50;

export interface ExpireStaleCreatedResult {
  examined: number;
  expired: number;
  recovered: number;
  skipped: number;
}

/**
 * Runtime cleanup for never-submitted CREATED intents past CREATED_INTENT_RESUME_TTL_MS.
 *
 * Only CREATED + submittedAt=null. Never TTL-expires SUBMITTED/AMBIGUOUS/etc.
 * Before REJECTED: defensive broker adopt. No OrderSend.
 */
export async function expireStaleCreatedExecutionIntents(input: {
  prisma: PrismaClient;
  adapter: DerivMT5BrokerAdapter;
  userId: string;
  logger: Logger;
  now?: number;
}): Promise<ExpireStaleCreatedResult> {
  const { prisma, adapter, userId, logger } = input;
  const now = input.now ?? Date.now();
  const cutoff = new Date(now - CREATED_INTENT_RESUME_TTL_MS);

  const intents = await prisma.executionIntent.findMany({
    where: {
      userId,
      state: "CREATED",
      submittedAt: null,
      createdAt: { lt: cutoff }
    },
    orderBy: { createdAt: "asc" },
    take: CREATED_INTENT_EXPIRY_SWEEP_LIMIT
  });

  let expired = 0;
  let recovered = 0;
  let skipped = 0;

  for (const intent of intents) {
    if (intent.state !== "CREATED" || intent.submittedAt != null) {
      skipped += 1;
      continue;
    }
    if (!isCreatedIntentExpired(intent.createdAt, now)) {
      skipped += 1;
      continue;
    }
    if (!intent.positionId) {
      logger.warn(
        { executionIntentId: intent.id, signalId: intent.signalId },
        "Stale CREATED intent missing positionId — skipping expiry"
      );
      skipped += 1;
      continue;
    }

    const position = await prisma.position.findUnique({ where: { id: intent.positionId } });
    if (!position) {
      skipped += 1;
      continue;
    }
    if (position.status === "OPEN" && position.brokerPositionId) {
      skipped += 1;
      continue;
    }
    if (position.status === "REJECTED" || position.status === "CLOSED") {
      await prisma.executionIntent.updateMany({
        where: { id: intent.id, state: "CREATED", submittedAt: null },
        data: {
          state: "REJECTED",
          failedAt: new Date(),
          lastErrorCode: EXECUTION_INTENT_EXPIRED,
          lastErrorMessage: "Position already terminal; syncing expired CREATED intent"
        }
      });
      expired += 1;
      continue;
    }
    if (position.status !== "PENDING" && position.status !== "OPEN_REQUESTED") {
      skipped += 1;
      continue;
    }

    const quote = await adapter.getQuote(intent.brokerSymbol);
    const instrument = await adapter.getInstrumentMetadata(intent.brokerSymbol);
    if (quote && instrument) {
      const adopted = await tryRecoverExecutionIntentFromBroker({
        prisma,
        adapter,
        intent,
        positionId: position.id,
        instrument,
        quote,
        logger
      });
      if (adopted?.accepted) {
        await recordPositionEvent(prisma, position.id, "OPENED", {
          source: "created_ttl_sweep_broker_adopt",
          brokerPositionId: adopted.brokerPositionId,
          executionIntentId: intent.id
        });
        recovered += 1;
        logger.info(
          {
            executionIntentId: intent.id,
            signalId: intent.signalId,
            positionId: position.id,
            brokerPositionId: adopted.brokerPositionId
          },
          "Stale CREATED intent adopted from broker during TTL sweep — not expired"
        );
        continue;
      }
    } else {
      // Cannot rule out broker execution without quote/instrument — fail closed (keep slot).
      logger.warn(
        {
          executionIntentId: intent.id,
          brokerSymbol: intent.brokerSymbol,
          hasQuote: Boolean(quote),
          hasInstrument: Boolean(instrument)
        },
        "Stale CREATED expiry deferred — broker query unavailable; capacity remains consumed"
      );
      skipped += 1;
      continue;
    }

    const result = await failClosedPendingExecution({
      prisma,
      positionId: position.id,
      executionIntentId: intent.id,
      code: EXECUTION_INTENT_EXPIRED,
      message: "CREATED execution intent exceeded resume TTL without broker submission (runtime sweep)",
      logger
    });
    if (result.released) {
      await recordPositionEvent(prisma, position.id, "REJECTED", {
        source: "created_ttl_sweep",
        code: EXECUTION_INTENT_EXPIRED
      });
      expired += 1;
      logger.info(
        {
          userId,
          executionIntentId: intent.id,
          positionId: position.id,
          signalId: intent.signalId,
          symbol: position.symbol
        },
        "MT5 capacity slot released — expired never-submitted CREATED intent"
      );
    } else {
      skipped += 1;
    }
  }

  return { examined: intents.length, expired, recovered, skipped };
}

export function shouldRunCreatedIntentExpirySweep(
  lastSweepAtMs: number | null,
  now = Date.now(),
  intervalMs = CREATED_INTENT_EXPIRY_SWEEP_INTERVAL_MS
): boolean {
  if (lastSweepAtMs == null) return true;
  return now - lastSweepAtMs >= intervalMs;
}
