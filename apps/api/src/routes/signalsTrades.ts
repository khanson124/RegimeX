import { type FastifyInstance } from "fastify";
import { cursorPaginationSchema, manualTradeSchema, NotFoundError } from "@regimex/shared";
import { executeManualDemoTrade } from "../services/manualTrade.js";
import { reconcileOpenDemoTrades } from "../services/demoTradeSettlement.js";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerSignalTradeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, config, credentialCrypto } = ctx;
  const auth = requireAuth(ctx);

  app.get("/signals", { preHandler: auth }, async (request) => {
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const items = await prisma.signal.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });

  app.get("/signals/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const signal = await prisma.signal.findFirst({
      where: { id, userId: request.userId },
      include: { demoTrades: true }
    });
    if (!signal) throw new NotFoundError("Signal");
    return { signal };
  });

  app.get("/demo-trades", { preHandler: auth }, async (request) => {
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const { status, reconcile } = request.query as { status?: string; reconcile?: string };
    const shouldReconcile = reconcile !== "0" && reconcile !== "false";
    if (shouldReconcile) {
      await reconcileOpenDemoTrades(
        prisma,
        {
          derivAppId: config.DERIV_APP_ID,
          derivWsUrl: config.DERIV_WS_URL,
          derivRestUrl: config.DERIV_REST_URL,
          engineVersion: config.ENGINE_VERSION
        },
        request.userId,
        (ciphertext) => credentialCrypto.decrypt(ciphertext)
      ).catch(() => undefined);
    }
    const items = await prisma.demoTrade.findMany({
      where: { userId: request.userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: { contracts: true },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });

  app.get("/demo-trades/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const trade = await prisma.demoTrade.findFirst({
      where: { id, userId: request.userId },
      include: { contracts: true, signal: true }
    });
    if (!trade) throw new NotFoundError("Demo trade");
    return { trade };
  });

  /** Sync open demo contracts with Deriv (settlements missed while engine was stopped). */
  app.post("/demo-trades/reconcile", { preHandler: auth }, async (request) => {
    const result = await reconcileOpenDemoTrades(
      prisma,
      {
        derivAppId: config.DERIV_APP_ID,
        derivWsUrl: config.DERIV_WS_URL,
        derivRestUrl: config.DERIV_REST_URL,
        engineVersion: config.ENGINE_VERSION
      },
      request.userId,
      (ciphertext) => credentialCrypto.decrypt(ciphertext),
      { limit: 100 }
    );
    return result;
  });

  /** Place a one-off demo trade (manual test). Still passes through risk rules. */
  app.post(
    "/demo-trades/manual",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = manualTradeSchema.parse(request.body);
      const result = await executeManualDemoTrade(
        prisma,
        {
          demoTradingEnabled: config.DEMO_TRADING_ENABLED,
          derivAppId: config.DERIV_APP_ID,
          derivWsUrl: config.DERIV_WS_URL,
          derivRestUrl: config.DERIV_REST_URL,
          engineVersion: config.ENGINE_VERSION
        },
        request.userId,
        (ciphertext) => credentialCrypto.decrypt(ciphertext),
        body
      );
      return reply.status(201).send({ trade: result });
    }
  );

  /** Decision audit log (chronological, cursor-paginated). */
  app.get("/decisions", { preHandler: auth }, async (request) => {
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const { eventType } = request.query as { eventType?: string };
    const items = await prisma.decisionLog.findMany({
      where: { userId: request.userId, ...(eventType ? { eventType } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });

  app.get("/notifications", { preHandler: auth }, async (request) => {
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const items = await prisma.notification.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });
}
