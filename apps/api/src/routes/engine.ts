import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import {
  CHANNELS,
  engineConfigurationSchema,
  NotFoundError,
  resolveEngineConfigurationScope,
  selectEngineConfigsToDeactivate,
  ValidationError,
  type EngineControlMessage
} from "@regimex/shared";
import { resolveLiveTradingArmState, resolveLiveTradingCapability } from "@regimex/trading-engine";
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
      include: { configurations: { where: { isActive: true }, orderBy: { createdAt: "asc" } } }
    });
  }

  app.get("/engine", { preHandler: auth }, async (request) => {
    const engine = await engineWithConfig(request.userId);
    const persistedArmed = engine?.liveTradingArmed === true;
    const liveArm = resolveLiveTradingArmState(config, persistedArmed);
    if (!engine) {
      return {
        engine: null,
        demoTradingGloballyEnabled: config.DEMO_TRADING_ENABLED,
        liveTradingGloballyEnabled: liveArm.liveTradingArmed,
        liveTradingSupported: liveArm.liveTradingSupported,
        liveTradingArmed: false,
        realMoneyEnabled: liveArm.realMoneyEnabled
      };
    }
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
        /** Primary/legacy single-config view (first active by createdAt). */
        configuration: engine.configurations[0] ?? null,
        /** All active symbol tracks (multi-symbol DEMO prep). */
        configurations: engine.configurations,
        demoTradingGloballyEnabled: config.DEMO_TRADING_ENABLED,
        liveTradingGloballyEnabled: liveArm.liveTradingArmed,
        liveTradingSupported: liveArm.liveTradingSupported,
        liveTradingArmed: liveArm.liveTradingArmed,
        realMoneyEnabled: liveArm.realMoneyEnabled
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

    if (body.mode === "LIVE_TRADING") {
      const liveCap = resolveLiveTradingCapability(config);
      if (!liveCap.liveTradingSupported) {
        throw new ValidationError(
          `Live trading is not supported on this server (${liveCap.reasons.join("; ") || "LIVE_TRADING_DISABLED"}).`,
          { reasons: liveCap.reasons },
          "LIVE_TRADING_DISABLED"
        );
      }
      if (config.EXECUTION_MODE !== "broker_real_mt5") {
        throw new ValidationError(
          "LIVE_TRADING requires EXECUTION_MODE=broker_real_mt5 on the server. Refusing to silently downgrade to demo.",
          { executionMode: config.EXECUTION_MODE },
          "LIVE_TRADING_DISABLED"
        );
      }
    }

    /** Live never auto-resumes after restart — force false regardless of client. */
    const resumeTradingAfterRestart =
      body.mode === "LIVE_TRADING"
        ? false
        : (body.resumeTradingAfterRestart ?? undefined);

    const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: body.symbol } });
    if (!symbol || !symbol.enabled) throw new NotFoundError("Enabled symbol");

    const engine = await prisma.liveEngine.upsert({
      where: { userId: request.userId },
      create: { userId: request.userId, engineVersion: config.ENGINE_VERSION },
      update: {}
    });

    const activeRows = await prisma.liveEngineConfiguration.findMany({
      where: { liveEngineId: engine.id, isActive: true },
      select: { id: true, symbol: true, isActive: true, selectionMode: true, fixedStrategyId: true, riskProfileId: true, resumeTradingAfterRestart: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });

    /** Same-symbol prior only — never inherit XAUUSD settings into an R_10 update (or vice versa). */
    const priorSameSymbol = [...activeRows].reverse().find((r) => r.symbol === body.symbol) ?? null;

    const scope = resolveEngineConfigurationScope({
      retainOtherActiveConfigurations: body.retainOtherActiveConfigurations,
      deactivateOtherActiveConfigurations: body.deactivateOtherActiveConfigurations
    });
    const deactivateIds = selectEngineConfigsToDeactivate(
      activeRows.map((r) => ({ id: r.id, symbol: r.symbol, isActive: r.isActive })),
      body.symbol,
      scope
    );
    if (deactivateIds.length > 0) {
      await prisma.liveEngineConfiguration.updateMany({
        where: { id: { in: deactivateIds } },
        data: { isActive: false }
      });
    }

    const configuration = await prisma.liveEngineConfiguration.create({
      data: {
        liveEngineId: engine.id,
        symbol: body.symbol,
        interval: body.interval,
        mode: body.mode,
        selectionMode: body.selectionMode ?? priorSameSymbol?.selectionMode ?? "AUTO",
        fixedStrategyId:
          body.fixedStrategyId !== undefined
            ? body.fixedStrategyId
            : (priorSameSymbol?.fixedStrategyId ?? null),
        riskProfileId:
          body.riskProfileId !== undefined
            ? body.riskProfileId
            : (priorSameSymbol?.riskProfileId ?? null),
        resumeTradingAfterRestart:
          resumeTradingAfterRestart ?? priorSameSymbol?.resumeTradingAfterRestart ?? false,
        isActive: true
      }
    });

    await publishControl("RELOAD_CONFIG", request.userId);
    return { configuration, scope };
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
