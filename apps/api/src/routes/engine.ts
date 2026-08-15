import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import {
  CHANNELS,
  engineConfigurationSchema,
  NotFoundError,
  ValidationError,
  type EngineControlMessage
} from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerEngineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, redis, config } = ctx;
  const auth = requireAuth(ctx);

  async function publishControl(command: EngineControlMessage["command"], userId: string): Promise<string> {
    const message: EngineControlMessage = { command, userId, correlationId: randomUUID() };
    await redis.publish(CHANNELS.engineControl, JSON.stringify(message));
    return message.correlationId;
  }

  async function engineWithConfig(userId: string) {
    return prisma.liveEngine.findUnique({
      where: { userId },
      include: { configurations: { where: { isActive: true }, take: 1 } }
    });
  }

  app.get("/engine", { preHandler: auth }, async (request) => {
    const engine = await engineWithConfig(request.userId);
    if (!engine) return { engine: null };
    return {
      engine: {
        id: engine.id,
        state: engine.state,
        stateReason: engine.stateReason,
        emergencyStop: engine.emergencyStop,
        lastTickAt: engine.lastTickAt,
        lastCandleAt: engine.lastCandleAt,
        lastHeartbeatAt: engine.lastHeartbeatAt,
        reconnectCount: engine.reconnectCount,
        configuration: engine.configurations[0] ?? null,
        demoTradingGloballyEnabled: config.DEMO_TRADING_ENABLED
      }
    };
  });

  app.put("/engine/configuration", { preHandler: auth }, async (request) => {
    const body = engineConfigurationSchema.parse(request.body);

    if (body.mode === "DEMO_TRADING" && !config.DEMO_TRADING_ENABLED) {
      throw new ValidationError(
        "Demo trade execution is disabled on this server (DEMO_TRADING_ENABLED=false). The engine can run in analysis-only mode."
      );
    }

    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: body.symbol } });
    if (!symbol || !symbol.enabled) throw new NotFoundError("Enabled symbol");

    const engine = await prisma.liveEngine.upsert({
      where: { userId: request.userId },
      create: { userId: request.userId, engineVersion: config.ENGINE_VERSION },
      update: {}
    });

    await prisma.liveEngineConfiguration.updateMany({
      where: { liveEngineId: engine.id, isActive: true },
      data: { isActive: false }
    });
    const configuration = await prisma.liveEngineConfiguration.create({
      data: {
        liveEngineId: engine.id,
        symbol: body.symbol,
        interval: body.interval,
        mode: body.mode,
        selectionMode: body.selectionMode,
        fixedStrategyId: body.fixedStrategyId,
        riskProfileId: body.riskProfileId,
        resumeTradingAfterRestart: body.resumeTradingAfterRestart,
        isActive: true
      }
    });

    await publishControl("RELOAD_CONFIG", request.userId);
    return { configuration };
  });

  app.post("/engine/start", { preHandler: auth }, async (request) => {
    const engine = await engineWithConfig(request.userId);
    if (!engine?.configurations[0]) {
      throw new ValidationError("Configure the engine before starting it");
    }
    if (engine.emergencyStop) {
      throw new ValidationError(
        "Emergency stop is active. Clear it via POST /engine/stop before restarting."
      );
    }
    await prisma.liveEngine.update({
      where: { id: engine.id },
      data: { state: "STARTING", stateReason: "Start requested" }
    });
    const correlationId = await publishControl("START", request.userId);
    return { success: true, correlationId };
  });

  app.post("/engine/pause", { preHandler: auth }, async (request) => {
    const correlationId = await publishControl("PAUSE", request.userId);
    return { success: true, correlationId };
  });

  app.post("/engine/resume", { preHandler: auth }, async (request) => {
    const correlationId = await publishControl("RESUME", request.userId);
    return { success: true, correlationId };
  });

  app.post("/engine/stop", { preHandler: auth }, async (request) => {
    // Stop also clears the emergency latch (explicit user action).
    await prisma.liveEngine.updateMany({
      where: { userId: request.userId },
      data: { emergencyStop: false }
    });
    const correlationId = await publishControl("STOP", request.userId);
    return { success: true, correlationId };
  });

  /**
   * Emergency stop: latched in the database immediately (so the risk manager
   * rejects everything even if the worker is briefly unreachable), then
   * broadcast to the worker for immediate enforcement.
   */
  app.post("/engine/emergency-stop", { preHandler: auth }, async (request) => {
    await prisma.liveEngine.upsert({
      where: { userId: request.userId },
      create: {
        userId: request.userId,
        state: "EMERGENCY_STOPPED",
        stateReason: "Emergency stop triggered by user",
        emergencyStop: true
      },
      update: {
        state: "EMERGENCY_STOPPED",
        stateReason: "Emergency stop triggered by user",
        emergencyStop: true
      }
    });
    await prisma.decisionLog.create({
      data: {
        userId: request.userId,
        eventType: "EMERGENCY_STOP",
        reasons: ["Emergency stop triggered by user via API"],
        correlationId: randomUUID(),
        engineVersion: config.ENGINE_VERSION
      }
    });
    const correlationId = await publishControl("EMERGENCY_STOP", request.userId);
    return { success: true, correlationId };
  });
}
