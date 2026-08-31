import { type PrismaClient } from "@regimex/database";
import { type BrokerQuote, type InstrumentMetadata, type OpenMarketPositionResult } from "@regimex/shared";
import {
  type DerivMT5BrokerAdapter,
  adaptMt5BrokerStops,
  compareProposedToFrozenExecutionParams,
  CREATED_INTENT_RESUME_TTL_MS,
  executionIntentIdempotencyKey,
  EXECUTION_INTENT_EXPIRED,
  EXECUTION_INTENT_PARAMETER_MISMATCH,
  EXECUTION_INTENT_STALE,
  isCreatedIntentExpired,
  isTerminalExecutionIntentState,
  isUnresolvedExecutionIntentState,
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
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err != null && (err as { code?: string }).code === "P2002";
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
 * Atomically create PENDING Position + CREATED ExecutionIntent.
 * Idempotent on unique conflicts when both rows already exist for the signal.
 */
export async function createPendingPositionWithExecutionIntent(
  prisma: PrismaClient,
  input: PendingPositionWithIntentInput,
  logger: Logger
) {
  const idempotencyKey = executionIntentIdempotencyKey(input.signalId);
  try {
    const result = await prisma.$transaction(async (tx) => {
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
      return { position, intent };
    });
    logger.info(
      {
        executionIntentId: result.intent.id,
        idempotencyKey,
        signalId: input.signalId,
        positionId: result.position.id,
        brokerComment: result.intent.brokerComment,
        state: "CREATED"
      },
      "MT5 execution intent created"
    );
    return result;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const [position, intent] = await Promise.all([
      prisma.position.findUnique({ where: { idempotencyKey } }),
      prisma.executionIntent.findUnique({ where: { signalId: input.signalId } })
    ]);
    if (position && intent) {
      logger.info(
        {
          executionIntentId: intent.id,
          signalId: input.signalId,
          positionId: position.id,
          idempotencyKey
        },
        "MT5 execution intent create idempotent — existing rows returned"
      );
      return { position, intent };
    }
    throw err;
  }
}

export async function markExecutionIntentSubmitted(prisma: PrismaClient, executionIntentId: string, logger: Logger) {
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

export async function markExecutionIntentBrokerConfirmed(
  prisma: PrismaClient,
  executionIntentId: string,
  broker: { brokerPositionId: string; orderTicket?: string | null; dealTicket?: string | null },
  logger: Logger
) {
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

export async function failClosedPendingExecution(input: {
  prisma: PrismaClient;
  positionId: string;
  executionIntentId: string;
  code: string;
  message: string;
  logger: Logger;
}): Promise<void> {
  await input.prisma.position.update({
    where: { id: input.positionId },
    data: { status: "REJECTED" }
  });
  await markExecutionIntentRejected(
    input.prisma,
    input.executionIntentId,
    { code: input.code, message: input.message },
    input.logger
  );
  input.logger.warn(
    {
      executionIntentId: input.executionIntentId,
      positionId: input.positionId,
      code: input.code
    },
    "MT5 execution failed closed"
  );
}

export async function markExecutionIntentAmbiguous(
  prisma: PrismaClient,
  executionIntentId: string,
  error: { code?: string; message?: string },
  logger: Logger
) {
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
    "MT5 execution intent ambiguous — will not resubmit until reconciled"
  );
  return intent;
}

export async function markExecutionIntentRecovered(
  prisma: PrismaClient,
  executionIntentId: string,
  broker: { brokerPositionId: string; orderTicket?: string | null; dealTicket?: string | null },
  logger: Logger
) {
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
  logger: Logger;
}): Promise<void> {
  const { prisma, positionId, signalId, executionIntentId, result } = input;
  if (!result.accepted || !result.position) return;

  await prisma.position.update({
    where: { id: positionId },
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
      openedAt: new Date(),
      metadata: {
        executionModel: "broker_demo_mt5",
        venue: "MT5_DEMO",
        ownedByRegimeX: true,
        engineSymbol: input.symbolAudit.internalSymbol,
        ...input.symbolAudit,
        volumePreflight: input.preflight,
        ...(result.position.metadata ?? {})
      } as object
    }
  });
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
