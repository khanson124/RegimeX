import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import {
  CHANNELS,
  NotFoundError,
  ValidationError,
  type EngineControlMessage
} from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerPositionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get("/paper-account", { preHandler: auth }, async (request) => {
    const account = await ctx.prisma.paperAccount.findUnique({
      where: { userId: request.userId }
    });
    return { account };
  });

  app.get("/positions", { preHandler: auth }, async (request) => {
    const { status } = request.query as { status?: string };
    const items = await ctx.prisma.position.findMany({
      where: {
        userId: request.userId,
        ...(status ? { status } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    return { items };
  });

  app.get("/positions/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const position = await ctx.prisma.position.findFirst({
      where: { id, userId: request.userId },
      include: { events: { orderBy: { createdAt: "desc" }, take: 50 } }
    });
    if (!position) throw new NotFoundError("Position");
    return { position };
  });

  /**
   * Request worker-owned paper CFD close.
   * Durable CLOSE_REQUESTED event + Redis control message; API never touches the broker.
   */
  app.post("/positions/:id/close", { preHandler: auth }, async (request) => {
    if (ctx.config.EXECUTION_MODE !== "paper_cfd" && ctx.config.EXECUTION_MODE !== "broker_demo_mt5") {
      throw new ValidationError("Manual CFD close requires EXECUTION_MODE=paper_cfd or broker_demo_mt5");
    }
    const { id } = request.params as { id: string };
    const position = await ctx.prisma.position.findFirst({
      where: { id, userId: request.userId }
    });
    if (!position) throw new NotFoundError("Position");

    if (position.status === "CLOSED") {
      return {
        success: true,
        idempotent: true,
        positionId: position.id,
        status: "CLOSED",
        message: "Position already closed"
      };
    }
    if (position.status !== "OPEN") {
      throw new ValidationError(`Cannot close position in status ${position.status}`);
    }

    const prior = await ctx.prisma.positionEvent.findFirst({
      where: { positionId: id, eventType: "CLOSE_REQUESTED" },
      orderBy: { createdAt: "desc" }
    });
    const priorReason = (prior?.payload as { closeReason?: string } | null)?.closeReason;
    if (priorReason === "MANUAL" && position.status === "OPEN") {
      // Duplicate request — re-publish control so worker retries, but do not duplicate event.
      const correlationId = randomUUID();
      const message: EngineControlMessage = {
        command: "CLOSE_POSITION",
        userId: request.userId,
        correlationId,
        positionId: id
      };
      await ctx.redis.publish(CHANNELS.engineControl, JSON.stringify(message));
      return {
        success: true,
        idempotent: true,
        correlationId,
        positionId: id,
        status: "OPEN",
        message: "Close already requested; re-notified worker"
      };
    }

    await ctx.prisma.positionEvent.create({
      data: {
        positionId: id,
        eventType: "CLOSE_REQUESTED",
        payload: { closeReason: "MANUAL", source: "api", requestedAt: new Date().toISOString() }
      }
    });

    const correlationId = randomUUID();
    const message: EngineControlMessage = {
      command: "CLOSE_POSITION",
      userId: request.userId,
      correlationId,
      positionId: id
    };
    await ctx.redis.publish(CHANNELS.engineControl, JSON.stringify(message));

    return {
      success: true,
      idempotent: false,
      correlationId,
      positionId: id,
      status: "OPEN",
      message: "Close requested; worker will execute"
    };
  });
}
