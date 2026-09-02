import { ValidationError } from "@regimex/shared";
import {
  DerivMT5BrokerAdapter,
  DEFAULT_MT5_MAGIC,
  measurePaperVsBrokerDivergence,
  mapMt5SymbolToInstrument,
  planBrokerPositionReconciliation,
  resolveMt5BridgeUrl,
  selectMt5PositionsForEmergencyClose,
  assertMt5DemoAdapterAllowed,
  buildMt5StatusEnvelope,
  getSharedMt5BridgeCircuit,
  isMt5DemoApiEnabled,
  isMt5RealPath,
  probeMt5BridgeLive,
  REAL_MT5_NOT_IMPLEMENTED,
  type Mt5LinkHealth
} from "@regimex/trading-engine";
import { upsertInternalInstrumentMetadataFromMt5 } from "../lib/mt5InstrumentMetadata.js";
import { loadMt5BrokerMappings } from "../lib/mt5Mappings.js";
import { registerMt5BrokerMapping } from "../lib/mt5RegisterMapping.js";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";
import { type FastifyInstance } from "fastify";
import { z } from "zod";

const testTradeSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(["BUY", "SELL"]),
  confirm: z.literal("PLACE_MT5_DEMO_TEST_TRADE"),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  volumeLots: z.number().positive().optional()
});

export function registerBrokerDemoMt5Routes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get("/broker-demo/mt5/status", { preHandler: auth }, async () => {
    const mappings = await loadMt5BrokerMappings(ctx.prisma);
    if (isMt5RealPath(ctx.config)) {
      return buildMt5StatusEnvelope(ctx.config, null, REAL_MT5_NOT_IMPLEMENTED, mappings);
    }
    if (!isMt5DemoApiEnabled(ctx.config)) {
      return buildMt5StatusEnvelope(ctx.config, null, null, mappings);
    }
    try {
      const bridgeUrl = resolveMt5BridgeUrl(ctx.config);
      const probe = await probeMt5BridgeLive(bridgeUrl, 2_000);
      const circuit = getSharedMt5BridgeCircuit().snapshot();
      if (!probe.ok) {
        const bridge = probe.errorCode === "MT5_BRIDGE_TIMEOUT" ? "unhealthy" : "offline";
        const health: Mt5LinkHealth = {
          bridge,
          ea: "unknown",
          reconciliation: "stale",
          circuit,
          lastBridgeSuccessAt: circuit.lastSuccessAt,
          lastEaSuccessAt: null,
          executionBlockReason: probe.errorCode,
          ready: false
        };
        return buildMt5StatusEnvelope(
          ctx.config,
          { connected: false, lastError: probe.errorCode },
          probe.errorCode,
          mappings,
          health
        );
      }
      let ea: Mt5LinkHealth["ea"] = "unknown";
      let lastEaSuccessAt: number | null = null;
      try {
        const readyRes = await fetch(`${bridgeUrl.replace(/\/$/, "")}/health/ready`, {
          signal: AbortSignal.timeout(800)
        });
        if (readyRes.ok) {
          const ready = (await readyRes.json()) as {
            eaHealth?: string;
            lastSuccessfulEaReplyAt?: number | null;
          };
          if (ready.eaHealth === "online" || ready.eaHealth === "offline" || ready.eaHealth === "unknown") {
            ea = ready.eaHealth;
          }
          lastEaSuccessAt = ready.lastSuccessfulEaReplyAt ?? null;
        }
      } catch {
        ea = "unknown";
      }

      const adapter = await connectMt5Adapter(ctx);
      const live = adapter.getStatus();
      const positions = live.eaConnected ? await adapter.getOpenPositions() : [];
      const health: Mt5LinkHealth = {
        bridge: "online",
        ea: live.eaConnected ? "online" : ea,
        reconciliation: live.eaConnected ? "fresh" : "stale",
        circuit: getSharedMt5BridgeCircuit().snapshot(),
        lastBridgeSuccessAt: Date.now(),
        lastEaSuccessAt,
        executionBlockReason: live.eaConnected ? null : "MT5_EA_OFFLINE",
        ready: true
      };
      return buildMt5StatusEnvelope(
        ctx.config,
        {
          ...live,
          connected: true,
          openPositions: positions.map((p) => ({
            brokerPositionId: p.brokerPositionId,
            symbol: p.symbol,
            direction: p.direction,
            volume: p.volume,
            entryPrice: p.entryPrice,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            floatingPnl: p.floatingPnl,
            orderTicket: p.metadata?.orderTicket,
            dealTicket: p.metadata?.dealTicket,
            positionTicket: p.metadata?.positionTicket,
            ownedByRegimeX: p.metadata?.ownedByRegimeX,
            origin: p.metadata?.origin ?? null
          }))
        },
        null,
        mappings,
        health
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const circuit = getSharedMt5BridgeCircuit().snapshot();
      return buildMt5StatusEnvelope(
        ctx.config,
        { connected: false },
        message,
        mappings,
        {
          bridge: "unhealthy",
          ea: "unknown",
          reconciliation: "stale",
          circuit,
          lastBridgeSuccessAt: circuit.lastSuccessAt,
          lastEaSuccessAt: null,
          executionBlockReason: message,
          ready: false
        }
      );
    }
  });

  app.get("/broker-demo/mt5/symbols", { preHandler: auth }, async () => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!isMt5DemoApiEnabled(ctx.config)) {
      throw new ValidationError("MT5 symbol discovery requires broker_demo_mt5 or MT5_TEST_MODE");
    }
    const adapter = await connectMt5Adapter(ctx);
    const symbols = await adapter.discoverSymbols();
    return {
      symbols,
      note: "Do not map R_10/R_25/… until a live DEMO row is verified. Names are broker-defined."
    };
  });

  app.post("/broker-demo/mt5/register-symbol", { preHandler: auth }, async (request) => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!isMt5DemoApiEnabled(ctx.config)) {
      throw new ValidationError("MT5 symbol registration requires broker_demo_mt5 or MT5_TEST_MODE");
    }
    const body = z.object({ symbol: z.string().min(1) }).parse(request.body);
    const adapter = await connectMt5Adapter(ctx);
    const live = await adapter.getLiveSymbol(body.symbol);
    if (!live) {
      throw new ValidationError(`MT5 symbol not found: ${body.symbol}`);
    }
    const mapped = mapMt5SymbolToInstrument(live, adapter.getStatus().currency ?? "USD");
    const symbol = await ctx.prisma.symbol.upsert({
      where: { derivSymbol: live.name },
      create: {
        derivSymbol: live.name,
        displayName: live.description || live.name,
        enabled: true,
        pricePrecision: live.digits,
        candleIntervals: ["1m", "5m"]
      },
      update: {
        displayName: live.description || live.name,
        pricePrecision: live.digits,
        enabled: true
      }
    });
    const meta = mapped.instrument;
    const instrumentMetadata = await upsertInternalInstrumentMetadataFromMt5(ctx.prisma, symbol.id, meta);
    return {
      symbol,
      instrumentMetadata,
      verified: meta.verified,
      reasons: mapped.reasons,
      note: "Registering a symbol does not enable autonomous execution. Allowlists and MT5_ENGINE_ENABLED remain separate gates. Prefer POST /broker-demo/mt5/register-mapping to bind an internal RegimeX symbol (R_10) to a broker-native MT5 name without creating a duplicate catalogue row."
    };
  });

  app.post("/broker-demo/mt5/register-mapping", { preHandler: auth }, async (request) => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!isMt5DemoApiEnabled(ctx.config)) {
      throw new ValidationError("MT5 mapping registration requires broker_demo_mt5 or MT5_TEST_MODE");
    }
    const body = z
      .object({
        internalSymbol: z.string().min(1),
        brokerSymbol: z.string().min(1)
      })
      .parse(request.body);

    const adapter = await connectMt5Adapter(ctx);
    return registerMt5BrokerMapping(ctx.prisma, {
      getLiveSymbol: (brokerSymbol) => adapter.getLiveSymbol(brokerSymbol),
      getCurrency: () => adapter.getStatus().currency ?? "USD"
    }, body);
  });

  const preflightSchema = z.object({
    symbol: z.string().min(1),
    direction: z.enum(["BUY", "SELL"]),
    stopLoss: z.number().positive(),
    takeProfit: z.number().positive(),
    volumeLots: z.number().positive().optional()
  });

  app.post("/broker-demo/mt5/preflight", { preHandler: auth }, async (request) => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!isMt5DemoApiEnabled(ctx.config)) {
      throw new ValidationError("MT5 preflight requires broker_demo_mt5 or MT5_TEST_MODE");
    }
    const body = preflightSchema.parse(request.body);
    const adapter = await connectMt5Adapter(ctx);
    const preflight = await adapter.preflightTestTrade(body);
    return {
      ok: preflight.ok,
      wouldSubmitOrder: false,
      preflight
    };
  });

  app.post("/broker-demo/mt5/test-trade", { preHandler: auth }, async (request, reply) => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!ctx.config.MT5_TEST_MODE) {
      throw new ValidationError("MT5_TEST_MODE must be true for test trades");
    }
    const body = testTradeSchema.parse(request.body);
    const adapter = await connectMt5Adapter(ctx);
    const status = adapter.getStatus();
    if (!status.isDemo) {
      throw new ValidationError("Refusing test trade — native ACCOUNT_TRADE_MODE is not DEMO");
    }

    const instrument = await adapter.getInstrumentMetadata(body.symbol);
    if (!instrument?.verified) {
      throw new ValidationError(`Instrument ${body.symbol} unavailable/unverified on MT5`);
    }
    const quote = await adapter.getQuote(body.symbol);
    if (!quote) throw new ValidationError("No fresh MT5 quote");

    const volume = Math.min(body.volumeLots ?? instrument.minVolume, ctx.config.MT5_MAX_TEST_VOLUME);
    const idempotencyKey = `TEST:mt5:${request.userId}:${body.symbol}:${body.direction}`;

    const result = await adapter.openMarketPosition({
      idempotencyKey,
      symbol: body.symbol,
      direction: body.direction,
      volume,
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      quote,
      instrument,
      riskAmount: 0,
      riskPercent: ctx.config.MT5_MAX_TEST_RISK_PERCENT,
      initialRiskReward: null,
      marginRequired: 0,
      metadata: { origin: "TEST", excludeFromRanking: true, venue: "mt5" }
    });

    if (!result.accepted || !result.position) {
      return reply.status(400).send({
        ok: false,
        rejectionReasons: result.rejectionReasons
      });
    }

    const pos = await ctx.prisma.position.upsert({
      where: { idempotencyKey },
      create: {
        userId: request.userId,
        symbol: body.symbol,
        strategyId: "manual-test",
        strategyVersion: "test",
        direction: body.direction,
        volume: result.position.volume,
        origin: "TEST",
        interval: null,
        entryPrice: result.entryPrice,
        initialStopLoss: result.position.stopLoss,
        stopLoss: result.position.stopLoss,
        initialTakeProfit: result.position.takeProfit,
        takeProfit: result.position.takeProfit,
        currentPrice: quote.mid,
        status: "OPEN",
        brokerPositionId: result.brokerPositionId,
        idempotencyKey,
        marginUsed: result.position.marginUsed,
        correlationId: idempotencyKey,
        openedAt: new Date(),
        reasoning: { tag: "MT5_DEMO_TEST", excludeFromRanking: true } as object,
        metadata: {
          executionModel: "broker_demo_mt5",
          venue: "MT5_DEMO",
          origin: "TEST",
          excludeFromRanking: true,
          orderTicket: result.position.metadata?.orderTicket,
          dealTicket: result.position.metadata?.dealTicket,
          positionTicket: result.position.metadata?.positionTicket,
          magic: result.position.metadata?.magic,
          paperVsBroker: measurePaperVsBrokerDivergence({
            paperEntry: body.direction === "BUY" ? quote.ask : quote.bid,
            brokerEntry: result.entryPrice ?? quote.mid,
            paperVolume: volume,
            brokerVolume: result.position.volume
          })
        } as object
      },
      update: {
        status: "OPEN",
        brokerPositionId: result.brokerPositionId,
        entryPrice: result.entryPrice,
        stopLoss: result.position.stopLoss,
        takeProfit: result.position.takeProfit
      }
    });

    await ctx.prisma.positionEvent.create({
      data: {
        positionId: pos.id,
        eventType: "OPENED",
        payload: {
          brokerPositionId: result.brokerPositionId,
          entryPrice: result.entryPrice,
          stopLoss: result.position.stopLoss,
          takeProfit: result.position.takeProfit,
          tag: "TEST",
          venue: "MT5_DEMO",
          tickets: result.position.metadata
        } as object
      }
    });

    return {
      ok: true,
      positionId: pos.id,
      brokerPositionId: result.brokerPositionId,
      orderTicket: result.position.metadata?.orderTicket,
      dealTicket: result.position.metadata?.dealTicket,
      positionTicket: result.position.metadata?.positionTicket,
      fill: result.entryPrice,
      stopLoss: result.position.stopLoss,
      takeProfit: result.position.takeProfit,
      volume: result.position.volume,
      note: "Confirm this DEMO position in Deriv MT5. Close via API or MT5. Tagged TEST — excluded from ranking."
    };
  });

  app.post("/broker-demo/mt5/test-trade/:positionId/close", { preHandler: auth }, async (request) => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!ctx.config.MT5_TEST_MODE) {
      throw new ValidationError("MT5_TEST_MODE must be true");
    }
    const { positionId } = request.params as { positionId: string };
    const adapter = await connectMt5Adapter(ctx);
    const local = await ctx.prisma.position.findFirst({
      where: {
        userId: request.userId,
        OR: [{ id: positionId }, { brokerPositionId: positionId }]
      }
    });
    const brokerPositionId = local?.brokerPositionId ?? positionId;
    const closed = await adapter.closePosition({
      brokerPositionId,
      reason: "MANUAL"
    });
    await ctx.prisma.position.updateMany({
      where: { userId: request.userId, brokerPositionId },
      data: {
        status: "CLOSED",
        closePrice: closed.closePrice,
        realizedPnl: closed.realizedPnl,
        closeReason: "MANUAL",
        closedAt: new Date()
      }
    });
    return { ok: true, closed };
  });

  app.post("/broker-demo/mt5/reconcile", { preHandler: auth }, async (request) => {
    if (isMt5RealPath(ctx.config)) {
      throw new ValidationError(REAL_MT5_NOT_IMPLEMENTED);
    }
    if (!isMt5DemoApiEnabled(ctx.config)) {
      throw new ValidationError("MT5 reconcile requires broker_demo_mt5 or MT5_TEST_MODE");
    }
    const adapter = await connectMt5Adapter(ctx);
    const brokerOpen = await adapter.getOpenPositions();
    const localOpen = await ctx.prisma.position.findMany({
      where: {
        userId: request.userId,
        status: { in: ["OPEN", "PENDING", "OPEN_REQUESTED"] },
        OR: [
          { metadata: { path: ["executionModel"], equals: "broker_demo_mt5" } },
          { idempotencyKey: { startsWith: "TEST:mt5:" } }
        ]
      }
    });
    const plan = planBrokerPositionReconciliation({
      brokerOpen: brokerOpen.map((b) => ({
        brokerPositionId: b.brokerPositionId,
        stopLoss: b.stopLoss,
        takeProfit: b.takeProfit
      })),
      localOpen: localOpen.map((l) => ({
        brokerPositionId: l.brokerPositionId,
        stopLoss: Number(l.stopLoss),
        takeProfit: l.takeProfit != null ? Number(l.takeProfit) : null,
        status: l.status
      }))
    });

    for (const id of plan.updateSlTp) {
      const b = brokerOpen.find((p) => p.brokerPositionId === id);
      const local = localOpen.find((l) => l.brokerPositionId === id);
      if (!b || !local) continue;
      await ctx.prisma.position.update({
        where: { id: local.id },
        data: { stopLoss: b.stopLoss, takeProfit: b.takeProfit }
      });
      await ctx.prisma.positionEvent.create({
        data: {
          positionId: local.id,
          eventType: "RECONCILED",
          payload: { reason: "SL/TP broker wins", broker: b } as object
        }
      });
    }

    for (const id of plan.markLocalClosed) {
      const local = localOpen.find((l) => l.brokerPositionId === id);
      if (!local) continue;
      const evidence = await adapter.reconstructClosedPosition(Number(id));
      if (!evidence.found || evidence.pendingHistory) {
        await ctx.prisma.positionEvent.create({
          data: {
            positionId: local.id,
            eventType: "RECONCILIATION_PENDING_HISTORY",
            payload: {
              reason: "MT5 position missing and history cannot yet explain the close",
              brokerPositionId: id,
              evidence
            } as object
          }
        });
        continue;
      }
      await ctx.prisma.position.update({
        where: { id: local.id },
        data: {
          status: "CLOSED",
          closeReason: evidence.closeReason ?? "BROKER_CLOSE",
          closePrice: evidence.exitPrice,
          realizedPnl: evidence.realizedPnl,
          closedAt: evidence.closedAt ? new Date(evidence.closedAt) : new Date(),
          metadata: {
            ...((local.metadata as object | null) ?? {}),
            executionModel: "broker_demo_mt5",
            venue: "MT5_DEMO",
            orderTicket: evidence.orderTicket,
            entryDealTicket: evidence.entryDealTicket,
            exitDealTicket: evidence.exitDealTicket,
            brokerReason: evidence.brokerReason,
            brokerReasonRaw: evidence.brokerReasonRaw,
            commission: evidence.commission,
            swap: evidence.swap,
            fee: evidence.fee
          } as object
        }
      });
      await ctx.prisma.positionEvent.create({
        data: {
          positionId: local.id,
          eventType: "RECONCILED",
          payload: {
            reason: "MT5 history confirmed close",
            evidence,
            closeReason: evidence.closeReason,
            brokerReason: evidence.brokerReason
          } as object
        }
      });
    }

    const emergencyPreview = selectMt5PositionsForEmergencyClose({
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
      localBrokerIds: new Set(localOpen.map((l) => l.brokerPositionId).filter(Boolean) as string[]),
      magic: ctx.config.MT5_MAGIC_NUMBER ?? DEFAULT_MT5_MAGIC
    });

    return {
      plan,
      externalUntracked: plan.externalUntracked,
      emergencyWouldClose: emergencyPreview.close,
      emergencyWouldSkipExternal: emergencyPreview.skipExternal,
      note: "EXTERNAL untracked MT5 positions are listed but not auto-traded or auto-closed. Missing history is RECONCILIATION_PENDING_HISTORY, not a fabricated close."
    };
  });
}

export async function connectMt5Adapter(ctx: AppContext): Promise<DerivMT5BrokerAdapter> {
  assertMt5DemoAdapterAllowed(ctx.config);
  const adapter = new DerivMT5BrokerAdapter({
    requireDemoAccount: true,
    bridgeUrl: resolveMt5BridgeUrl(ctx.config),
    bridgeSecret: ctx.config.MT5_BRIDGE_SECRET ?? "",
    timeoutMs: ctx.config.MT5_COMMAND_TIMEOUT_MS,
    maxQuoteAgeMs: ctx.config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxTestVolume: ctx.config.MT5_MAX_TEST_VOLUME,
    maxTestRiskPercent: ctx.config.MT5_MAX_TEST_RISK_PERCENT,
    magic: ctx.config.MT5_MAGIC_NUMBER,
    expectedBroker: ctx.config.MT5_EXPECTED_BROKER,
    expectedServer: ctx.config.MT5_EXPECTED_SERVER,
    expectedLogin: ctx.config.MT5_EXPECTED_LOGIN,
    expectedEnvironment: ctx.config.MT5_EXPECTED_ENVIRONMENT
  });
  await adapter.connect();
  return adapter;
}
