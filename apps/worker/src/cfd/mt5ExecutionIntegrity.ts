import { type PrismaClient } from "@regimex/database";
import { type BrokerQuote, type InstrumentMetadata, type OpenMarketPositionResult } from "@regimex/shared";
import {
  type DerivMT5BrokerAdapter,
  adaptMt5BrokerStops,
  canRejectPendingPositionStatus,
  canTransitionExecutionIntentState,
  compareProposedToFrozenExecutionParams,
  CREATED_INTENT_RESUME_TTL_MS,
  decideCapacityReservation,
  executionIntentIdempotencyKey,
  EXECUTION_INTENT_EXPIRED,
  EXECUTION_INTENT_PARAMETER_MISMATCH,
  EXECUTION_INTENT_STALE,
  isCreatedIntentExpired,
  isTerminalExecutionIntentState,
  isUnresolvedExecutionIntentState,
  MT5_CAPACITY_BLOCKED,
  MT5_CAPACITY_CONSUMING_STATUSES_EXTENDED,
  mergeOpenMt5ExecutionTelemetry,
  mergePositionMetadataForOpen,
  mt5CapacityAdvisoryLockKey,
  type Mt5ExecutionTelemetry,
  regimeXOrderComment,
  type FrozenExecutionParams
} from "@regimex/trading-engine";
import { isQuoteFresh } from "@regimex/trading-engine";
import { type Logger } from "pino";

export interface PendingPositionWithIntentInput {
  userId: string;
  signalId: string;
  correlationId: string;
  internalSymbol: string;
  brokerSymbol: string;
  strategyId: string;
  strategyVersion: string | null | undefined;
  regime: string | null | undefined;
  interval: string | null | undefined;
  direction: string;
  volume: number;
  stopLoss: number;
  takeProfit: number | null | undefined;
  riskAmount: number;
  riskPercent: number;
  initialRiskReward: number | null | undefined;
  reasoning: object;
  metadata: object;
  /** Hard capacity limit; reservation is atomic with create. */
  maxConcurrentPositions: number;
}

export type CreatePendingWithIntentResult =
  | {
      ok: true;
      capacityBlocked: false;
      position: Awaited<ReturnType<PrismaClient["position"]["create"]>>;
      intent: Awaited<ReturnType<PrismaClient["executionIntent"]["create"]>>;
      consumedSlotsBefore: number;
      consumedSlotsAfter: number;
      maxConcurrentPositions: number;
    }
  | {
      ok: false;
      capacityBlocked: true;
      consumedSlotsBefore: number;
      consumedSlotsAfter: number;
      maxConcurrentPositions: number;
      reason: string;
    };

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err != null && (err as { code?: string }).code === "P2002";
}

export async function countMt5ConsumedCapacitySlots(
  prisma: Pick<PrismaClient, "position">,
  userId: string
): Promise<number> {
  return prisma.position.count({
    where: {
      userId,
      origin: "ENGINE",
      status: { in: [...MT5_CAPACITY_CONSUMING_STATUSES_EXTENDED] }
    }
  });
}

export function extractFrozenExecutionParams(
  intent: {
    internalSymbol: string;
    brokerSymbol: string;
    direction: string;
    requestedVolume: unknown;
    requestedStopLoss: unknown;
    requestedTakeProfit: unknown | null;
    strategyId: string;
  },
  position: {
    riskAmount: unknown | null;
    riskPercent: unknown | null;
    initialRiskReward: unknown | null;
  }
): FrozenExecutionParams {
  const takeProfit = intent.requestedTakeProfit != null ? Number(intent.requestedTakeProfit) : null;
  if (takeProfit == null || !(takeProfit > 0)) {
    throw new Error("Frozen execution intent missing takeProfit");
  }
  return {
    internalSymbol: intent.internalSymbol,
    brokerSymbol: intent.brokerSymbol,
    direction: intent.direction as "BUY" | "SELL",
    volume: Number(intent.requestedVolume),
    stopLoss: Number(intent.requestedStopLoss),
    takeProfit,
    strategyId: intent.strategyId,
    riskAmount: Number(position.riskAmount ?? 0),
    riskPercent: Number(position.riskPercent ?? 0),
    initialRiskReward: position.initialRiskReward != null ? Number(position.initialRiskReward) : null
  };
}

export function validateFrozenIntentStopSafety(input: {
  frozen: FrozenExecutionParams;
  quote: BrokerQuote;
  adaptation: ReturnType<typeof adaptMt5BrokerStops>;
}): { ok: boolean; reasons: string[] } {
  const { frozen, quote, adaptation } = input;
  if (!adaptation.ok || adaptation.adjustedStopLoss == null || adaptation.adjustedTakeProfit == null) {
    return {
      ok: false,
      reasons: [adaptation.reasonCode ?? EXECUTION_INTENT_STALE, ...adaptation.reasons]
    };
  }
  if (adaptation.brokerAdjusted) {
    return { ok: false, reasons: [EXECUTION_INTENT_STALE, "frozen_stops_require_broker_adjustment"] };
  }
  const slDrift = Math.abs(adaptation.adjustedStopLoss - frozen.stopLoss);
  const tpDrift = Math.abs(adaptation.adjustedTakeProfit - frozen.takeProfit);
  if (slDrift > 1e-5 || tpDrift > 1e-5) {
    return { ok: false, reasons: [EXECUTION_INTENT_STALE, "frozen_stop_tp_no_longer_valid"] };
  }
  const entry = frozen.direction === "BUY" ? quote.ask : quote.bid;
  if (!(entry > 0)) {
    return { ok: false, reasons: [EXECUTION_INTENT_STALE, "invalid_market_price"] };
  }
  return { ok: true, reasons: [] };
}

export async function validateFrozenIntentSubmitSafety(input: {
  frozen: FrozenExecutionParams;
  quote: BrokerQuote;
  maxQuoteAgeMs: number;
  adaptation: ReturnType<typeof adaptMt5BrokerStops>;
}): Promise<{ ok: boolean; reasons: string[] }> {
  if (!isQuoteFresh(input.quote.timestamp, Date.now(), input.maxQuoteAgeMs)) {
    return { ok: false, reasons: ["STALE_QUOTE"] };
  }
  return validateFrozenIntentStopSafety({
    frozen: input.frozen,
    quote: input.quote,
    adaptation: input.adaptation
  });
}

export async function findExecutionIntentBySignal(prisma: PrismaClient, signalId: string) {
  return prisma.executionIntent.findUnique({ where: { signalId } });
}

async function createExecutionIntentRow(
  tx: Pick<PrismaClient, "executionIntent">,
  input: {
    userId: string;
    signalId: string;
    positionId: string;
    internalSymbol: string;
    brokerSymbol: string;
    direction: string;
    volume: number;
    stopLoss: number;
    takeProfit: number | null | undefined;
    strategyId: string;
    regime: string | null | undefined;
    correlationId: string;
  }
) {
  const idempotencyKey = executionIntentIdempotencyKey(input.signalId);
  const brokerComment = regimeXOrderComment(idempotencyKey);
  return tx.executionIntent.create({
    data: {
      userId: input.userId,
      signalId: input.signalId,
      positionId: input.positionId,
      idempotencyKey,
      brokerComment,
      internalSymbol: input.internalSymbol,
      brokerSymbol: input.brokerSymbol,
      direction: input.direction,
      requestedVolume: input.volume,
      requestedStopLoss: input.stopLoss,
      requestedTakeProfit: input.takeProfit ?? null,
      strategyId: input.strategyId,
      regime: input.regime ?? null,
      correlationId: input.correlationId,
      state: "CREATED"
    }
  });
}

/**
 * Atomically: advisory-lock user capacity → count consuming slots → create PENDING Position
 * + CREATED ExecutionIntent. Slot is reserved by the PENDING row before any MT5 submit.
 * Idempotent on unique conflicts when both rows already exist for the signal.
 */
export async function createPendingPositionWithExecutionIntent(
  prisma: PrismaClient,
  input: PendingPositionWithIntentInput,
  logger: Logger
): Promise<CreatePendingWithIntentResult> {
  const idempotencyKey = executionIntentIdempotencyKey(input.signalId);
  const lockKey = mt5CapacityAdvisoryLockKey(input.userId);
  const maxConcurrentPositions = input.maxConcurrentPositions;

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const existingPosition = await tx.position.findUnique({ where: { idempotencyKey } });
      const existingIntent = await tx.executionIntent.findUnique({ where: { signalId: input.signalId } });
      if (existingPosition && existingIntent) {
        const consumed = await tx.position.count({
          where: {
            userId: input.userId,
            origin: "ENGINE",
            status: { in: [...MT5_CAPACITY_CONSUMING_STATUSES_EXTENDED] }
          }
        });
        return {
          kind: "existing" as const,
          position: existingPosition,
          intent: existingIntent,
          consumedSlotsBefore: consumed,
          consumedSlotsAfter: consumed
        };
      }

      const consumedBefore = await tx.position.count({
        where: {
          userId: input.userId,
          origin: "ENGINE",
          status: { in: [...MT5_CAPACITY_CONSUMING_STATUSES_EXTENDED] }
        }
      });
      const decision = decideCapacityReservation({
        consumedBefore,
        maxConcurrent: maxConcurrentPositions
      });
      if (!decision.allowed) {
        return {
          kind: "blocked" as const,
          consumedSlotsBefore: consumedBefore,
          consumedSlotsAfter: consumedBefore
        };
      }

      const position = await tx.position.create({
        data: {
          userId: input.userId,
          signalId: input.signalId,
          symbol: input.internalSymbol,
          strategyId: input.strategyId,
          strategyVersion: input.strategyVersion ?? null,
          regime: input.regime ?? null,
          direction: input.direction,
          volume: input.volume,
          origin: "ENGINE",
          interval: input.interval ?? null,
          initialStopLoss: input.stopLoss,
          stopLoss: input.stopLoss,
          initialTakeProfit: input.takeProfit ?? null,
          takeProfit: input.takeProfit ?? null,
          entryType: "MARKET",
          status: "PENDING",
          initialRiskAmount: input.riskAmount,
          initialRiskPercent: input.riskPercent,
          initialRiskReward: input.initialRiskReward ?? null,
          riskAmount: input.riskAmount,
          riskPercent: input.riskPercent,
          idempotencyKey,
          correlationId: input.correlationId,
          reasoning: input.reasoning,
          metadata: input.metadata
        }
      });
      const intent = await createExecutionIntentRow(tx, {
        userId: input.userId,
        signalId: input.signalId,
        positionId: position.id,
        internalSymbol: input.internalSymbol,
        brokerSymbol: input.brokerSymbol,
        direction: input.direction,
        volume: input.volume,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        strategyId: input.strategyId,
        regime: input.regime,
        correlationId: input.correlationId
      });
      return {
        kind: "created" as const,
        position,
        intent,
        consumedSlotsBefore: consumedBefore,
        consumedSlotsAfter: consumedBefore + 1
      };
    });

    if (result.kind === "blocked") {
      logger.warn(
        {
          userId: input.userId,
          signalId: input.signalId,
          symbol: input.internalSymbol,
          maxConcurrentPositions,
          consumedSlotsBefore: result.consumedSlotsBefore,
          consumedSlotsAfter: result.consumedSlotsAfter,
          reason: MT5_CAPACITY_BLOCKED
        },
        "MT5 capacity blocked — concurrent reservation loser"
      );
      return {
        ok: false,
        capacityBlocked: true,
        consumedSlotsBefore: result.consumedSlotsBefore,
        consumedSlotsAfter: result.consumedSlotsAfter,
        maxConcurrentPositions,
        reason: MT5_CAPACITY_BLOCKED
      };
    }

    if (result.kind === "existing") {
      logger.info(
        {
          executionIntentId: result.intent.id,
          signalId: input.signalId,
          positionId: result.position.id,
          idempotencyKey,
          maxConcurrentPositions,
          consumedSlotsBefore: result.consumedSlotsBefore,
          consumedSlotsAfter: result.consumedSlotsAfter
        },
        "MT5 execution intent create idempotent — existing rows returned"
      );
      return {
        ok: true,
        capacityBlocked: false,
        position: result.position,
        intent: result.intent,
        consumedSlotsBefore: result.consumedSlotsBefore,
        consumedSlotsAfter: result.consumedSlotsAfter,
        maxConcurrentPositions
      };
    }

    logger.info(
      {
        executionIntentId: result.intent.id,
        idempotencyKey,
        signalId: input.signalId,
        positionId: result.position.id,
        brokerComment: result.intent.brokerComment,
        state: "CREATED",
        userId: input.userId,
        symbol: input.internalSymbol,
        maxConcurrentPositions,
        consumedSlotsBefore: result.consumedSlotsBefore,
        consumedSlotsAfter: result.consumedSlotsAfter
      },
      "MT5 capacity slot reserved — execution intent created"
    );
    return {
      ok: true,
      capacityBlocked: false,
      position: result.position,
      intent: result.intent,
      consumedSlotsBefore: result.consumedSlotsBefore,
      consumedSlotsAfter: result.consumedSlotsAfter,
      maxConcurrentPositions
    };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const [position, intent] = await Promise.all([
      prisma.position.findUnique({ where: { idempotencyKey } }),
      prisma.executionIntent.findUnique({ where: { signalId: input.signalId } })
    ]);
    if (position && intent) {
      const consumed = await countMt5ConsumedCapacitySlots(prisma, input.userId);
      logger.info(
        {
          executionIntentId: intent.id,
          signalId: input.signalId,
          positionId: position.id,
          idempotencyKey
        },
        "MT5 execution intent create idempotent — existing rows returned after unique race"
      );
      return {
        ok: true,
        capacityBlocked: false,
        position,
        intent,
        consumedSlotsBefore: consumed,
        consumedSlotsAfter: consumed,
        maxConcurrentPositions
      };
    }
    throw err;
  }
}

export async function markExecutionIntentSubmitted(prisma: PrismaClient, executionIntentId: string, logger: Logger) {
  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (!current) throw new Error(`ExecutionIntent ${executionIntentId} not found`);
  if (!canTransitionExecutionIntentState(current.state, "SUBMITTED")) {
    logger.warn(
      {
        executionIntentId,
        from: current.state,
        to: "SUBMITTED"
      },
      "MT5 execution intent transition skipped — invalid"
    );
    return current;
  }
  if (current.state === "SUBMITTED") return current;
  const intent = await prisma.executionIntent.update({
    where: { id: executionIntentId },
    data: { state: "SUBMITTED", submittedAt: new Date() }
  });
  logger.info(
    { executionIntentId, idempotencyKey: intent.idempotencyKey, signalId: intent.signalId, state: "SUBMITTED" },
    "MT5 execution intent submitted"
  );
  return intent;
}

export async function refreshPendingExecutionParams(input: {
  prisma: PrismaClient;
  positionId: string;
  executionIntentId: string;
  signalId: string;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  riskAmount: number;
  riskPercent: number;
  initialRiskReward: number | null;
  preflight: unknown;
  executionTelemetry: object;
  finalExecution: object;
  logger: Logger;
}): Promise<void> {
  const existing = await input.prisma.position.findUnique({
    where: { id: input.positionId },
    select: { metadata: true }
  });
  const existingMetadata = (existing?.metadata ?? {}) as Record<string, unknown>;
  await input.prisma.$transaction(async (tx) => {
    await tx.position.update({
      where: { id: input.positionId },
      data: {
        volume: input.volume,
        initialStopLoss: input.stopLoss,
        stopLoss: input.stopLoss,
        initialTakeProfit: input.takeProfit,
        takeProfit: input.takeProfit,
        initialRiskAmount: input.riskAmount,
        initialRiskPercent: input.riskPercent,
        initialRiskReward: input.initialRiskReward,
        riskAmount: input.riskAmount,
        riskPercent: input.riskPercent,
        metadata: {
          ...existingMetadata,
          executionTelemetry: input.executionTelemetry,
          volumePreflight: input.preflight,
          finalExecution: input.finalExecution
        } as never
      }
    });
    await tx.executionIntent.update({
      where: { id: input.executionIntentId },
      data: {
        requestedVolume: input.volume,
        requestedStopLoss: input.stopLoss,
        requestedTakeProfit: input.takeProfit
      }
    });
    await tx.signal.update({
      where: { id: input.signalId },
      data: {
        proposedVolume: input.volume,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit
      }
    });
  });
  input.logger.info(
    {
      positionId: input.positionId,
      executionIntentId: input.executionIntentId,
      signalId: input.signalId,
      volume: input.volume,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit
    },
    "MT5 pending execution parameters refreshed before submit"
  );
}

export async function markExecutionIntentBrokerConfirmed(
  prisma: PrismaClient,
  executionIntentId: string,
  broker: { brokerPositionId: string; orderTicket?: string | null; dealTicket?: string | null },
  logger: Logger
) {
  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (!current) throw new Error(`ExecutionIntent ${executionIntentId} not found`);
  if (!canTransitionExecutionIntentState(current.state, "BROKER_CONFIRMED")) {
    logger.warn(
      { executionIntentId, from: current.state, to: "BROKER_CONFIRMED" },
      "MT5 execution intent transition skipped — invalid"
    );
    return current;
  }
  if (current.state === "BROKER_CONFIRMED") return current;
  const intent = await prisma.executionIntent.update({
    where: { id: executionIntentId },
    data: {
      state: "BROKER_CONFIRMED",
      brokerConfirmedAt: new Date(),
      brokerPositionId: broker.brokerPositionId,
      brokerOrderTicket: broker.orderTicket ?? null,
      brokerDealTicket: broker.dealTicket ?? null
    }
  });
  logger.info(
    {
      executionIntentId,
      idempotencyKey: intent.idempotencyKey,
      signalId: intent.signalId,
      brokerPositionId: broker.brokerPositionId,
      state: "BROKER_CONFIRMED"
    },
    "MT5 execution intent broker confirmed"
  );
  return intent;
}

export async function markExecutionIntentPersisted(prisma: PrismaClient, executionIntentId: string, logger: Logger) {
  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (!current) throw new Error(`ExecutionIntent ${executionIntentId} not found`);
  if (!canTransitionExecutionIntentState(current.state, "PERSISTED")) {
    logger.warn(
      { executionIntentId, from: current.state, to: "PERSISTED" },
      "MT5 execution intent transition skipped — invalid"
    );
    return current;
  }
  if (current.state === "PERSISTED") return current;
  const intent = await prisma.executionIntent.update({
    where: { id: executionIntentId },
    data: { state: "PERSISTED", persistedAt: new Date() }
  });
  logger.info(
    { executionIntentId, idempotencyKey: intent.idempotencyKey, signalId: intent.signalId, state: "PERSISTED" },
    "MT5 execution intent persisted"
  );
  return intent;
}

export async function markExecutionIntentRejected(
  prisma: PrismaClient,
  executionIntentId: string,
  error: { code?: string; message?: string },
  logger: Logger
) {
  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (!current) throw new Error(`ExecutionIntent ${executionIntentId} not found`);
  if (!canTransitionExecutionIntentState(current.state, "REJECTED")) {
    logger.warn(
      { executionIntentId, from: current.state, to: "REJECTED" },
      "MT5 execution intent transition skipped — invalid"
    );
    return current;
  }
  if (current.state === "REJECTED") return current;
  const intent = await prisma.executionIntent.update({
    where: { id: executionIntentId },
    data: {
      state: "REJECTED",
      failedAt: new Date(),
      lastErrorCode: error.code ?? null,
      lastErrorMessage: error.message ?? null
    }
  });
  logger.warn(
    {
      executionIntentId,
      idempotencyKey: intent.idempotencyKey,
      signalId: intent.signalId,
      state: "REJECTED",
      lastErrorCode: error.code
    },
    "MT5 execution intent rejected"
  );
  return intent;
}

/**
 * Conditionally reject PENDING position + intent. Releases capacity exactly once.
 * No-op if position already terminal (CLOSED/REJECTED/OPEN).
 */
export async function failClosedPendingExecution(input: {
  prisma: PrismaClient;
  positionId: string;
  executionIntentId: string;
  code: string;
  message: string;
  logger: Logger;
}): Promise<{ released: boolean }> {
  const before = await input.prisma.position.findUnique({ where: { id: input.positionId } });
  if (!before) return { released: false };
  if (!canRejectPendingPositionStatus(before.status)) {
    input.logger.info(
      {
        positionId: input.positionId,
        executionIntentId: input.executionIntentId,
        status: before.status,
        code: input.code
      },
      "MT5 fail-closed skipped — position not pending"
    );
    return { released: false };
  }
  const updated = await input.prisma.position.updateMany({
    where: {
      id: input.positionId,
      status: { in: ["PENDING", "OPEN_REQUESTED"] }
    },
    data: { status: "REJECTED" }
  });
  await markExecutionIntentRejected(
    input.prisma,
    input.executionIntentId,
    { code: input.code, message: input.message },
    input.logger
  );
  if (updated.count > 0) {
    input.logger.warn(
      {
        executionIntentId: input.executionIntentId,
        positionId: input.positionId,
        code: input.code,
        userId: before.userId,
        symbol: before.symbol
      },
      "MT5 capacity slot released — execution failed closed"
    );
  }
  return { released: updated.count > 0 };
}

export async function markExecutionIntentAmbiguous(
  prisma: PrismaClient,
  executionIntentId: string,
  error: { code?: string; message?: string },
  logger: Logger
) {
  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (!current) throw new Error(`ExecutionIntent ${executionIntentId} not found`);
  if (!canTransitionExecutionIntentState(current.state, "AMBIGUOUS")) {
    logger.warn(
      { executionIntentId, from: current.state, to: "AMBIGUOUS" },
      "MT5 execution intent transition skipped — invalid"
    );
    return current;
  }
  if (current.state === "AMBIGUOUS") return current;
  const intent = await prisma.executionIntent.update({
    where: { id: executionIntentId },
    data: {
      state: "AMBIGUOUS",
      lastErrorCode: error.code ?? null,
      lastErrorMessage: error.message ?? null
    }
  });
  logger.warn(
    {
      executionIntentId,
      idempotencyKey: intent.idempotencyKey,
      signalId: intent.signalId,
      state: "AMBIGUOUS",
      lastErrorCode: error.code
    },
    "MT5 execution intent ambiguous — capacity remains consumed until resolved"
  );
  return intent;
}

export async function markExecutionIntentRecovered(
  prisma: PrismaClient,
  executionIntentId: string,
  broker: { brokerPositionId: string; orderTicket?: string | null; dealTicket?: string | null },
  logger: Logger
) {
  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (!current) throw new Error(`ExecutionIntent ${executionIntentId} not found`);
  if (!canTransitionExecutionIntentState(current.state, "RECOVERED")) {
    logger.warn(
      { executionIntentId, from: current.state, to: "RECOVERED" },
      "MT5 execution intent transition skipped — invalid"
    );
    return current;
  }
  if (current.state === "RECOVERED") return current;
  const intent = await prisma.executionIntent.update({
    where: { id: executionIntentId },
    data: {
      state: "RECOVERED",
      recoveredAt: new Date(),
      brokerPositionId: broker.brokerPositionId,
      brokerOrderTicket: broker.orderTicket ?? null,
      brokerDealTicket: broker.dealTicket ?? null
    }
  });
  logger.info(
    {
      executionIntentId,
      idempotencyKey: intent.idempotencyKey,
      signalId: intent.signalId,
      brokerPositionId: broker.brokerPositionId,
      state: "RECOVERED"
    },
    "MT5 execution intent recovered from broker"
  );
  return intent;
}

/**
 * Idempotent close: only transitions from capacity-consuming statuses to CLOSED.
 * Returns applied=false when already CLOSED or status cannot close (stale reconcile).
 */
export async function closeLocalPositionIfCloseable(input: {
  prisma: PrismaClient;
  positionId: string;
  data: {
    closePrice: number | null;
    realizedPnl: number | null;
    closeReason: string;
    closedAt: Date;
  };
  logger: Logger;
}): Promise<{ applied: boolean; previousStatus: string | null }> {
  const before = await input.prisma.position.findUnique({ where: { id: input.positionId } });
  if (!before) return { applied: false, previousStatus: null };
  if (before.status === "CLOSED") {
    input.logger.info(
      { positionId: input.positionId, brokerPositionId: before.brokerPositionId },
      "MT5 duplicate close prevented — already CLOSED"
    );
    return { applied: false, previousStatus: "CLOSED" };
  }
  const updated = await input.prisma.position.updateMany({
    where: {
      id: input.positionId,
      status: { in: ["OPEN", "PENDING", "OPEN_REQUESTED", "CLOSE_REQUESTED"] }
    },
    data: {
      status: "CLOSED",
      closePrice: input.data.closePrice,
      realizedPnl: input.data.realizedPnl,
      closeReason: input.data.closeReason,
      closedAt: input.data.closedAt
    }
  });
  if (updated.count === 0) {
    input.logger.warn(
      {
        positionId: input.positionId,
        previousStatus: before.status
      },
      "MT5 close skipped — stale state (cannot regress)"
    );
    return { applied: false, previousStatus: before.status };
  }
  input.logger.info(
    {
      positionId: input.positionId,
      userId: before.userId,
      symbol: before.symbol,
      previousStatus: before.status,
      brokerPositionId: before.brokerPositionId
    },
    "MT5 capacity slot released — position closed"
  );
  return { applied: true, previousStatus: before.status };
}

export type CreatedIntentStartupResolution = "awaiting_resume" | "expired" | "stale" | "broker_recovered";

/**
 * CREATED + !submittedAt policy: never auto-submit on startup.
 * Prove no broker fill, validate frozen params against fresh market, or fail closed.
 */
export async function resolveCreatedExecutionIntentOnStartup(input: {
  prisma: PrismaClient;
  intent: {
    id: string;
    signalId: string;
    createdAt: Date;
    brokerSymbol: string;
    direction: string;
    requestedVolume: unknown;
    requestedStopLoss: unknown;
    requestedTakeProfit: unknown | null;
    internalSymbol: string;
    strategyId: string;
  };
  position: {
    id: string;
    riskAmount: unknown | null;
    riskPercent: unknown | null;
    initialRiskReward: unknown | null;
  };
  quote: BrokerQuote;
  instrument: InstrumentMetadata;
  adaptation: ReturnType<typeof adaptMt5BrokerStops>;
  maxQuoteAgeMs: number;
  logger: Logger;
  now?: number;
}): Promise<CreatedIntentStartupResolution> {
  const now = input.now ?? Date.now();
  if (isCreatedIntentExpired(input.intent.createdAt, now)) {
    await failClosedPendingExecution({
      prisma: input.prisma,
      positionId: input.position.id,
      executionIntentId: input.intent.id,
      code: EXECUTION_INTENT_EXPIRED,
      message: "CREATED execution intent exceeded resume TTL without broker submission",
      logger: input.logger
    });
    return "expired";
  }

  const frozen = extractFrozenExecutionParams(input.intent, input.position);
  const safety = await validateFrozenIntentSubmitSafety({
    frozen,
    quote: input.quote,
    maxQuoteAgeMs: input.maxQuoteAgeMs,
    adaptation: input.adaptation
  });
  if (!safety.ok) {
    await failClosedPendingExecution({
      prisma: input.prisma,
      positionId: input.position.id,
      executionIntentId: input.intent.id,
      code: EXECUTION_INTENT_STALE,
      message: safety.reasons.join("; "),
      logger: input.logger
    });
    return "stale";
  }

  input.logger.info(
    {
      executionIntentId: input.intent.id,
      signalId: input.intent.signalId,
      idempotencyKey: executionIntentIdempotencyKey(input.intent.signalId),
      resumeTtlRemainingMs: CREATED_INTENT_RESUME_TTL_MS - (now - input.intent.createdAt.getTime())
    },
    "MT5 CREATED intent awaiting executeCfdSignal resume with frozen parameters — no startup auto-submit"
  );
  return "awaiting_resume";
}

export async function persistPositionOpenFromBrokerResult(input: {
  prisma: PrismaClient;
  positionId: string;
  signalId: string;
  executionIntentId: string;
  result: OpenMarketPositionResult;
  symbolAudit: { internalSymbol: string; brokerSymbol: string };
  preflight?: unknown;
  instrument?: InstrumentMetadata;
  logger: Logger;
}): Promise<void> {
  const { prisma, positionId, signalId, executionIntentId, result } = input;
  if (!result.accepted || !result.position) return;

  const existing = await prisma.position.findUnique({
    where: { id: positionId },
    select: {
      metadata: true,
      stopLoss: true,
      takeProfit: true,
      direction: true
    }
  });
  const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const pendingTelemetry = existingMeta.executionTelemetry as Mt5ExecutionTelemetry | undefined;
  const direction = (existing?.direction ?? result.position.direction) as "BUY" | "SELL";
  const stopLoss =
    existing?.stopLoss != null ? Number(existing.stopLoss) : Number(result.position.stopLoss);
  const takeProfit =
    existing?.takeProfit != null
      ? Number(existing.takeProfit)
      : result.position.takeProfit != null
        ? Number(result.position.takeProfit)
        : null;
  const actualFillPrice = result.entryPrice != null ? Number(result.entryPrice) : null;
  const actualFillVolume = Number(result.position.volume);
  const openedAt = new Date().toISOString();

  const executionTelemetry = mergeOpenMt5ExecutionTelemetry({
    pending: pendingTelemetry,
    direction,
    actualFillPrice,
    actualFillVolume,
    stopLoss,
    takeProfit,
    tickSize: pendingTelemetry?.tickSize ?? input.instrument?.tickSize,
    tickValue: pendingTelemetry?.tickValue ?? input.instrument?.tickValue,
    openedAt
  });

  const metadata = mergePositionMetadataForOpen({
    existingMetadata: existingMeta,
    symbolAudit: input.symbolAudit,
    preflight: input.preflight,
    brokerPositionMetadata: (result.position.metadata ?? {}) as Record<string, unknown>,
    executionTelemetry
  });

  const updated = await prisma.position.updateMany({
    where: {
      id: positionId,
      status: { in: ["PENDING", "OPEN_REQUESTED", "OPEN"] }
    },
    data: {
      status: "OPEN",
      brokerPositionId: result.brokerPositionId,
      entryPrice: result.entryPrice,
      currentPrice: result.entryPrice,
      volume: result.position.volume,
      appliedEntrySpreadBps: result.appliedSpreadBps,
      appliedEntrySlippageBps: result.appliedSlippageBps,
      marginUsed: result.position.marginUsed,
      floatingPnl: 0,
      openedAt: new Date(openedAt),
      metadata: metadata as object
    }
  });
  if (updated.count === 0) {
    input.logger.warn(
      { positionId, executionIntentId, signalId },
      "MT5 persist OPEN skipped — stale position state (cannot regress CLOSED/REJECTED)"
    );
    return;
  }
  await prisma.signal.update({
    where: { id: signalId },
    data: {
      status: "EXECUTED",
      proposedEntryPrice: result.entryPrice,
      proposedVolume: result.position.volume
    }
  });

  const current = await prisma.executionIntent.findUnique({ where: { id: executionIntentId } });
  if (current && current.state !== "RECOVERED" && current.state !== "BROKER_CONFIRMED") {
    await markExecutionIntentBrokerConfirmed(
      prisma,
      executionIntentId,
      {
        brokerPositionId: result.brokerPositionId ?? "",
        orderTicket: result.position.metadata?.orderTicket != null ? String(result.position.metadata.orderTicket) : null,
        dealTicket: result.position.metadata?.dealTicket != null ? String(result.position.metadata.dealTicket) : null
      },
      input.logger
    );
  }
  await markExecutionIntentPersisted(prisma, executionIntentId, input.logger);
}

export async function tryRecoverExecutionIntentFromBroker(input: {
  prisma: PrismaClient;
  adapter: DerivMT5BrokerAdapter;
  intent: {
    id: string;
    signalId: string;
    positionId: string | null;
    idempotencyKey: string;
    brokerSymbol: string;
    direction: string;
    requestedVolume: unknown;
    requestedStopLoss: unknown;
    requestedTakeProfit: unknown | null;
    internalSymbol: string;
  };
  positionId: string;
  instrument: InstrumentMetadata;
  quote: BrokerQuote;
  logger: Logger;
}): Promise<OpenMarketPositionResult | null> {
  const adopted = await input.adapter.tryAdoptOpenByIdempotency({
    idempotencyKey: input.intent.idempotencyKey,
    symbol: input.intent.brokerSymbol,
    direction: input.intent.direction as "BUY" | "SELL",
    volume: Number(input.intent.requestedVolume),
    stopLoss: Number(input.intent.requestedStopLoss),
    takeProfit: input.intent.requestedTakeProfit != null ? Number(input.intent.requestedTakeProfit) : null,
    quote: input.quote,
    instrument: input.instrument,
    riskAmount: 0,
    riskPercent: 0,
    initialRiskReward: null,
    marginRequired: 0,
    metadata: { signalId: input.intent.signalId, recovery: true }
  });
  if (!adopted?.accepted) return null;

  const meta = adopted.position?.metadata ?? {};
  await markExecutionIntentRecovered(
    input.prisma,
    input.intent.id,
    {
      brokerPositionId: adopted.brokerPositionId ?? "",
      orderTicket: meta.orderTicket != null ? String(meta.orderTicket) : null,
      dealTicket: meta.dealTicket != null ? String(meta.dealTicket) : null
    },
    input.logger
  );
  await persistPositionOpenFromBrokerResult({
    prisma: input.prisma,
    positionId: input.positionId,
    signalId: input.intent.signalId,
    executionIntentId: input.intent.id,
    result: adopted,
    symbolAudit: { internalSymbol: input.intent.internalSymbol, brokerSymbol: input.intent.brokerSymbol },
    instrument: input.instrument,
    logger: input.logger
  });
  input.logger.info(
    {
      executionIntentId: input.intent.id,
      idempotencyKey: input.intent.idempotencyKey,
      signalId: input.intent.signalId,
      brokerPositionId: adopted.brokerPositionId,
      recovery: "broker_comment_match"
    },
    "MT5 execution recovered from broker by idempotency comment"
  );
  return adopted;
}

export function shouldBlockDuplicateExecution(
  intent: { state: string; submittedAt?: Date | null } | null,
  position: { status: string } | null
): {
  block: boolean;
  reason?: string;
  resumeBeforeSubmit?: boolean;
} {
  if (position?.status === "OPEN") {
    return { block: true, reason: "position_already_open" };
  }
  if (!intent) return { block: false };
  if (intent.state === "CREATED" && !intent.submittedAt && position?.status === "PENDING") {
    return { block: false, resumeBeforeSubmit: true };
  }
  if (isTerminalExecutionIntentState(intent.state)) {
    return { block: true, reason: `intent_terminal_${intent.state.toLowerCase()}` };
  }
  if (isUnresolvedExecutionIntentState(intent.state)) {
    return { block: true, reason: `intent_unresolved_${intent.state.toLowerCase()}` };
  }
  return { block: false };
}
