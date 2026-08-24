import { ValidationError } from "@regimex/shared";
import {
  DerivCfdBrokerAdapter,
  measurePaperVsBrokerDivergence,
  planBrokerPositionReconciliation
} from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";
import { type FastifyInstance } from "fastify";
import { z } from "zod";

const testTradeSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(["BUY", "SELL"]),
  /** Must confirm consciously. */
  confirm: z.literal("PLACE_DEMO_TEST_TRADE"),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  /** Optional override — defaults to broker min volume. */
  volumeLots: z.number().positive().optional()
});

/**
 * Broker-demo CFD status + guarded one-trade connectivity test.
 * Automated engine trading is separate (BROKER_DEMO_ENGINE_ENABLED).
 */
export function registerBrokerDemoRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get("/broker-demo/status", { preHandler: auth }, async () => {
    const mode = ctx.config.EXECUTION_MODE;
    if (mode !== "broker_demo_cfd" && !ctx.config.BROKER_DEMO_TEST_MODE) {
      return {
        status: {
          mode,
          enabled: false,
          message: "Set EXECUTION_MODE=broker_demo_cfd or BROKER_DEMO_TEST_MODE=true"
        }
      };
    }

    try {
      const adapter = await connectAdapter(ctx);
      const status = adapter.getStatus();
      const positions = status.accountAuthed ? await adapter.getOpenPositions() : [];
      return {
        status: {
          mode: "broker_demo_cfd",
          enabled: true,
          demo: true,
          ...status,
          openPositions: positions.map((p) => ({
            brokerPositionId: p.brokerPositionId,
            symbol: p.symbol,
            direction: p.direction,
            volume: p.volume,
            entryPrice: p.entryPrice,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            floatingPnl: p.floatingPnl
          })),
          engineAutomationEnabled: ctx.config.BROKER_DEMO_ENGINE_ENABLED,
          testMode: ctx.config.BROKER_DEMO_TEST_MODE
        }
      };
    } catch (err) {
      return {
        status: {
          mode: "broker_demo_cfd",
          enabled: true,
          demo: true,
          connected: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
    }
  });

  app.post("/broker-demo/test-trade", { preHandler: auth }, async (request, reply) => {
    if (!ctx.config.BROKER_DEMO_TEST_MODE) {
      throw new ValidationError("BROKER_DEMO_TEST_MODE must be true for test trades");
    }
    if (ctx.config.EXECUTION_MODE === "broker_real_cfd" || ctx.config.REAL_MONEY_ENABLED) {
      throw new ValidationError("REAL_CFD_EXECUTION_NOT_IMPLEMENTED");
    }
    const body = testTradeSchema.parse(request.body);
    const adapter = await connectAdapter(ctx);
    const status = adapter.getStatus();
    if (!status.isDemo) {
      throw new ValidationError("Refusing test trade — account is not DEMO");
    }

    const instrument = await adapter.getInstrumentMetadata(body.symbol);
    if (!instrument?.verified) {
      throw new ValidationError(`Instrument ${body.symbol} unavailable/unverified on broker`);
    }
    const quote = await adapter.getQuote(body.symbol);
    if (!quote) throw new ValidationError("No fresh broker quote");

    const volume = body.volumeLots ?? instrument.minVolume;
    const idempotencyKey = `TEST:${request.userId}:${Date.now()}`;

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
      riskPercent: 0.01,
      initialRiskReward: null,
      marginRequired: 0,
      metadata: { origin: "TEST", excludeFromRanking: true }
    });

    if (!result.accepted || !result.position) {
      return reply.status(400).send({
        ok: false,
        rejectionReasons: result.rejectionReasons,
        divergence: null
      });
    }

    // Persist as TEST origin so ranking ignores it
    const pos = await ctx.prisma.position.create({
      data: {
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
        reasoning: {
          tag: "BROKER_DEMO_TEST",
          excludeFromRanking: true
        } as object,
        metadata: {
          executionModel: "broker_demo_cfd",
          paperVsBroker: measurePaperVsBrokerDivergence({
            paperEntry: body.direction === "BUY" ? quote.ask : quote.bid,
            brokerEntry: result.entryPrice ?? quote.mid,
            paperVolume: volume,
            brokerVolume: result.position.volume
          })
        } as object
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
          tag: "TEST"
        } as object
      }
    });

    return {
      ok: true,
      positionId: pos.id,
      brokerPositionId: result.brokerPositionId,
      fill: result.entryPrice,
      stopLoss: result.position.stopLoss,
      takeProfit: result.position.takeProfit,
      volume: result.position.volume,
      note: "Confirm this DEMO position in Deriv cTrader. Close via API or cTrader UI."
    };
  });

  app.post("/broker-demo/test-trade/:brokerPositionId/close", { preHandler: auth }, async (request) => {
    if (!ctx.config.BROKER_DEMO_TEST_MODE) {
      throw new ValidationError("BROKER_DEMO_TEST_MODE must be true");
    }
    const { brokerPositionId } = request.params as { brokerPositionId: string };
    const adapter = await connectAdapter(ctx);
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

  app.post("/broker-demo/reconcile", { preHandler: auth }, async (request) => {
    const adapter = await connectAdapter(ctx);
    const brokerOpen = await adapter.getOpenPositions();
    const localOpen = await ctx.prisma.position.findMany({
      where: { userId: request.userId, status: { in: ["OPEN", "PENDING"] } }
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
      if (!b) continue;
      const local = localOpen.find((l) => l.brokerPositionId === id);
      if (!local) continue;
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
      await ctx.prisma.position.update({
        where: { id: local.id },
        data: { status: "CLOSED", closeReason: "BROKER_CLOSE", closedAt: new Date() }
      });
      await ctx.prisma.positionEvent.create({
        data: {
          positionId: local.id,
          eventType: "RECONCILED",
          payload: { reason: "Broker position gone — marked CLOSED" } as object
        }
      });
    }

    return { plan, note: "EXTERNAL untracked broker positions are listed but not auto-traded" };
  });
}

async function connectAdapter(ctx: AppContext): Promise<DerivCfdBrokerAdapter> {
  const adapter = new DerivCfdBrokerAdapter({
    route: "ctrader_open_api",
    requireDemoAccount: true,
    ctraderClientId: ctx.config.CTRADER_CLIENT_ID ?? "",
    ctraderClientSecret: ctx.config.CTRADER_CLIENT_SECRET ?? "",
    ctraderAccountId: ctx.config.CTRADER_ACCOUNT_ID ?? "",
    accessToken: ctx.config.CTRADER_ACCESS_TOKEN ?? "",
    environment: ctx.config.CTRADER_ENVIRONMENT ?? "demo",
    host: ctx.config.CTRADER_HOST,
    port: ctx.config.CTRADER_PORT,
    maxQuoteAgeMs: ctx.config.MAX_EXECUTION_QUOTE_AGE_MS,
    maxVolumeLots: ctx.config.BROKER_DEMO_MAX_VOLUME,
    maxRiskPercent: ctx.config.BROKER_DEMO_MAX_RISK_PERCENT,
    moneyScale: ctx.config.CTRADER_MONEY_SCALE
  });
  await adapter.connect();
  return adapter;
}
