import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import {
  CHANNELS,
  NotFoundError,
  ValidationError,
  modifyPositionBodySchema,
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
    if (ctx.config.EXECUTION_MODE !== "paper_cfd" && ctx.config.EXECUTION_MODE !== "broker_demo_mt5" && ctx.config.EXECUTION_MODE !== "broker_real_mt5") {
      throw new ValidationError("Manual CFD close requires EXECUTION_MODE=paper_cfd, broker_demo_mt5, or broker_real_mt5");
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

  /**
   * Request worker-owned SL (and optional TP) modify on an open CFD position.
   * Durable MODIFY_REQUESTED event + Redis control; API never touches the broker.
   */
  app.post("/positions/:id/modify", { preHandler: auth }, async (request) => {
    if (ctx.config.EXECUTION_MODE !== "paper_cfd" && ctx.config.EXECUTION_MODE !== "broker_demo_mt5" && ctx.config.EXECUTION_MODE !== "broker_real_mt5") {
      throw new ValidationError("Manual CFD modify requires EXECUTION_MODE=paper_cfd, broker_demo_mt5, or broker_real_mt5");
    }
    const { id } = request.params as { id: string };
    const body = modifyPositionBodySchema.parse(request.body);
    const position = await ctx.prisma.position.findFirst({
      where: { id, userId: request.userId }
    });
    if (!position) throw new NotFoundError("Position");
    if (position.status !== "OPEN") {
      throw new ValidationError(`Cannot modify position in status ${position.status}`);
    }
    if (!position.brokerPositionId) {
      throw new ValidationError("Position has no broker ticket yet");
    }

    const entry = position.entryPrice != null ? Number(position.entryPrice) : null;
    if (entry != null && Number.isFinite(entry)) {
      if (position.direction === "BUY" && !(body.stopLoss < entry)) {
        throw new ValidationError("BUY stop loss must be below entry");
      }
      if (position.direction === "SELL" && !(body.stopLoss > entry)) {
        throw new ValidationError("SELL stop loss must be above entry");
      }
    }

    await ctx.prisma.positionEvent.create({
      data: {
        positionId: id,
        eventType: "MODIFY_REQUESTED",
        payload: {
          stopLoss: body.stopLoss,
          // Omit takeProfit when undefined so audit trail does not imply a TP clear.
          ...(body.takeProfit !== undefined ? { takeProfit: body.takeProfit } : {}),
          source: "api",
          requestedAt: new Date().toISOString()
        }
      }
    });

    const correlationId = randomUUID();
    const message: EngineControlMessage = {
      command: "MODIFY_POSITION",
      userId: request.userId,
      correlationId,
      positionId: id,
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit
    };
    await ctx.redis.publish(CHANNELS.engineControl, JSON.stringify(message));

    return {
      success: true,
      correlationId,
      positionId: id,
      status: "OPEN",
      message: "Modify requested; worker will update stop / take profit"
    };
  });
}
