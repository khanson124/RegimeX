import { type FastifyInstance } from "fastify";
import {
  cursorPaginationSchema,
  NotFoundError,
  optimizationCreateSchema,
  ValidationError
} from "@regimex/shared";
import { countCombinations } from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerOptimizationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, config } = ctx;
  const auth = requireAuth(ctx);

  app.post("/optimizations", { preHandler: auth }, async (request, reply) => {
    const body = optimizationCreateSchema.parse(request.body);

    const total = countCombinations(body.parameters);
    if (total === 0) throw new ValidationError("Parameter space is empty");
    if (total > config.OPTIMIZER_MAX_COMBINATIONS && !body.confirmLargeRun) {
      // Safety guard against combinatorial explosions: require confirmation.
      return reply.status(409).send({
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: `${total} combinations exceed the safety threshold (${config.OPTIMIZER_MAX_COMBINATIONS}). Re-submit with confirmLargeRun=true to proceed.`,
          details: { totalCombinations: total, threshold: config.OPTIMIZER_MAX_COMBINATIONS }
        }
      });
    }
    if (total > config.OPTIMIZER_MAX_COMBINATIONS * 10) {
      throw new ValidationError(
        `${total} combinations exceed the hard limit (${config.OPTIMIZER_MAX_COMBINATIONS * 10}). Reduce the parameter space.`
      );
    }

    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: body.symbol } });
    if (!symbol) throw new NotFoundError("Symbol");

    const run = await prisma.optimizationRun.create({
      data: {
        userId: request.userId,
        strategyKind: body.strategyKind,
        symbol: body.symbol,
        interval: body.interval,
        fromDate: body.from,
        toDate: body.to,
        parameterSpace: body.parameters,
        totalCombinations: total,
        testSplit: body.testSplit,
        status: "QUEUED"
      }
    });

    await ctx.queues.optimization.add(
      "run",
      { runId: run.id, userId: request.userId },
      { removeOnComplete: 50, removeOnFail: 50 }
    );

    return reply.status(201).send({ optimization: run, totalCombinations: total });
  });

  app.get("/optimizations", { preHandler: auth }, async (request) => {
    const { cursor, limit } = cursorPaginationSchema.parse(request.query);
    const items = await prisma.optimizationRun.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const nextCursor = items.length > limit ? items.pop()!.id : null;
    return { items, nextCursor };
  });

  async function ownedRun(id: string, userId: string) {
    const run = await prisma.optimizationRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundError("Optimization run");
    return run;
  }

  app.get("/optimizations/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    return { optimization: await ownedRun(id, request.userId) };
  });

  app.post("/optimizations/:id/cancel", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const run = await ownedRun(id, request.userId);
    if (!["QUEUED", "RUNNING"].includes(run.status)) {
      throw new ValidationError(`Cannot cancel a run in status ${run.status}`);
    }
    await ctx.redis.set(`optimization:cancel:${id}`, "1", "EX", 7200);
    await prisma.optimizationRun.update({ where: { id }, data: { status: "CANCELLED" } });
    return { success: true };
  });

  app.get("/optimizations/:id/candidates", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    await ownedRun(id, request.userId);
    const candidates = await prisma.optimizationCandidate.findMany({
      where: { runId: id },
      orderBy: { score: "desc" },
      take: 50
    });
    return { candidates };
  });
}
