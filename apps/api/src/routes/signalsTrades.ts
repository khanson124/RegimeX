import { type FastifyInstance } from "fastify";
import { cursorPaginationSchema, NotFoundError } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerSignalTradeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
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
    const { status } = request.query as { status?: string };
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
