import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import {
  adaptMt5BrokerStops,
  type DerivMT5BrokerAdapter,
  isUnresolvedExecutionIntentState
} from "@regimex/trading-engine";
import { type Logger } from "pino";
import { recordPositionEvent } from "./paperPersistence.js";
import {
  extractFrozenExecutionParams,
  markExecutionIntentPersisted,
  resolveCreatedExecutionIntentOnStartup,
  tryRecoverExecutionIntentFromBroker
} from "./mt5ExecutionIntegrity.js";

const UNRESOLVED_STATES = ["CREATED", "SUBMITTED", "BROKER_CONFIRMED", "AMBIGUOUS", "RECOVERED"] as const;

/**
 * On worker/MT5 runtime startup: reconcile unresolved execution intents and PENDING positions
 * against broker magic+comment identity. Idempotent — never issues a second OrderSend.
 */
export async function recoverUnresolvedMt5ExecutionIntents(input: {
  prisma: PrismaClient;
  adapter: DerivMT5BrokerAdapter;
  userId: string;
  config: Pick<AppConfig, "MAX_EXECUTION_QUOTE_AGE_MS">;
  logger: Logger;
}): Promise<{ recovered: number; stillUnresolved: number; failedClosed: number; awaitingResume: number }> {
  const { prisma, adapter, userId, config, logger } = input;
  let recovered = 0;
  let stillUnresolved = 0;
  let failedClosed = 0;
  let awaitingResume = 0;

  const intents = await prisma.executionIntent.findMany({
    where: { userId, state: { in: [...UNRESOLVED_STATES] } },
    orderBy: { createdAt: "asc" }
  });

  for (const intent of intents) {
    if (!intent.positionId) {
      logger.warn(
        { executionIntentId: intent.id, signalId: intent.signalId, state: intent.state },
        "MT5 execution intent missing positionId — skipping recovery"
      );
      stillUnresolved += 1;
      continue;
    }

    const position = await prisma.position.findUnique({ where: { id: intent.positionId } });
    if (!position) {
      stillUnresolved += 1;
      continue;
    }
    if (position.status === "OPEN" && position.brokerPositionId) {
      if (intent.state !== "PERSISTED") {
        await prisma.executionIntent.update({
          where: { id: intent.id },
          data: { state: "PERSISTED", persistedAt: new Date(), brokerPositionId: position.brokerPositionId }
        });
        recovered += 1;
      }
      continue;
    }
    if (position.status === "REJECTED" && intent.state !== "REJECTED") {
      await prisma.executionIntent.update({
        where: { id: intent.id },
        data: { state: "REJECTED", failedAt: new Date() }
      });
      continue;
    }

    const quote = await adapter.getQuote(intent.brokerSymbol);
    const instrument = await adapter.getInstrumentMetadata(intent.brokerSymbol);
    if (!quote || !instrument) {
      logger.warn(
        { executionIntentId: intent.id, brokerSymbol: intent.brokerSymbol },
        "MT5 execution recovery skipped — quote/instrument unavailable"
      );
      stillUnresolved += 1;
      continue;
    }

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
        source: "execution_recovery",
        brokerPositionId: adopted.brokerPositionId,
        executionIntentId: intent.id,
        idempotencyKey: intent.idempotencyKey
      });
      if (intent.state === "RECOVERED") {
        await markExecutionIntentPersisted(prisma, intent.id, logger);
      }
      recovered += 1;
      continue;
    }

    if (intent.state === "CREATED" && !intent.submittedAt) {
      const frozen = extractFrozenExecutionParams(intent, position);
      const liveSymbol = await adapter.getLiveSymbol(intent.brokerSymbol);
      const adaptation = adaptMt5BrokerStops({
        direction: frozen.direction,
        stopLoss: frozen.stopLoss,
        takeProfit: frozen.takeProfit,
        entryPrice: frozen.direction === "BUY" ? quote.ask : quote.bid,
        targetRMultiple: frozen.initialRiskReward ?? 2,
        bid: quote.bid,
        ask: quote.ask,
        point: liveSymbol?.point,
        tickSize: liveSymbol?.tickSize ?? instrument.tickSize,
        digits: liveSymbol?.digits ?? instrument.pricePrecision,
        stopsLevel: liveSymbol?.stopsLevel,
        freezeLevel: liveSymbol?.freezeLevel
      });
      const resolution = await resolveCreatedExecutionIntentOnStartup({
        prisma,
        intent,
        position,
        quote,
        instrument,
        adaptation,
        maxQuoteAgeMs: config.MAX_EXECUTION_QUOTE_AGE_MS,
        logger
      });
      if (resolution === "awaiting_resume") {
        awaitingResume += 1;
        stillUnresolved += 1;
      } else {
        failedClosed += 1;
        stillUnresolved += 1;
      }
      continue;
    }

    if (isUnresolvedExecutionIntentState(intent.state)) {
      logger.warn(
        {
          executionIntentId: intent.id,
          idempotencyKey: intent.idempotencyKey,
          signalId: intent.signalId,
          state: intent.state
        },
        "MT5 execution recovery failed closed — broker match not found, will not resubmit"
      );
      failedClosed += 1;
      stillUnresolved += 1;
    }
  }

  const pendingWithoutIntent = await prisma.position.findMany({
    where: { userId, status: "PENDING", origin: "ENGINE" }
  });
  for (const row of pendingWithoutIntent) {
    if (!row.signalId) continue;
    const existingIntent = await prisma.executionIntent.findUnique({ where: { signalId: row.signalId } });
    if (existingIntent) continue;

    const mapping = (row.metadata ?? {}) as { engineSymbol?: string };
    const brokerSymbol =
      typeof mapping.engineSymbol === "string"
        ? await resolveBrokerSymbolFromPosition(prisma, row.symbol)
        : row.symbol;
    const quote = await adapter.getQuote(brokerSymbol);
    const instrument = await adapter.getInstrumentMetadata(brokerSymbol);
    if (!quote || !instrument) continue;

    const adopted = await adapter.tryAdoptOpenByIdempotency({
      idempotencyKey: row.idempotencyKey,
      symbol: brokerSymbol,
      direction: row.direction as "BUY" | "SELL",
      volume: Number(row.volume),
      stopLoss: Number(row.stopLoss),
      takeProfit: row.takeProfit != null ? Number(row.takeProfit) : null,
      quote,
      instrument,
      riskAmount: Number(row.riskAmount ?? 0),
      riskPercent: Number(row.riskPercent ?? 0),
      initialRiskReward: row.initialRiskReward != null ? Number(row.initialRiskReward) : null,
      marginRequired: 0,
      metadata: { legacyPendingRecovery: true, positionId: row.id }
    });
    if (!adopted?.accepted || !adopted.position) continue;

    await prisma.position.update({
      where: { id: row.id },
      data: {
        status: "OPEN",
        brokerPositionId: adopted.brokerPositionId,
        entryPrice: adopted.entryPrice,
        currentPrice: adopted.entryPrice,
        volume: adopted.position.volume,
        openedAt: new Date()
      }
    });
    await recordPositionEvent(prisma, row.id, "RECONCILED", {
      scenario: "legacy_pending_adopt_by_comment",
      brokerPositionId: adopted.brokerPositionId,
      idempotencyKey: row.idempotencyKey,
      heuristic: true
    });
    logger.warn(
      {
        positionId: row.id,
        idempotencyKey: row.idempotencyKey,
        brokerPositionId: adopted.brokerPositionId,
        heuristic: true
      },
      "Recovered legacy PENDING position by broker comment (no execution intent row)"
    );
    recovered += 1;
  }

  return { recovered, stillUnresolved, failedClosed, awaitingResume };
}

async function resolveBrokerSymbolFromPosition(
  prisma: PrismaClient,
  internalSymbol: string
): Promise<string> {
  const row = await prisma.brokerSymbolMapping.findFirst({
    where: {
      venue: "MT5",
      executionMode: "broker_demo_mt5",
      symbol: { derivSymbol: internalSymbol }
    }
  });
  return row?.brokerSymbol ?? internalSymbol;
}
