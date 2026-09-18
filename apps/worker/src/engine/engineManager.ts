import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
import { CHANNELS, type EngineControlMessage } from "@regimex/shared";
import {
  engineSessionKey,
  listSessionKeysForUser,
  parseEngineSessionKey
} from "@regimex/trading-engine";
import { type Redis } from "ioredis";
import { type Logger } from "pino";
import { type EventPublisher } from "../lib/events.js";
import { LiveEngineSession, type SessionDeps } from "./liveEngineSession.js";

/**
 * Owns all live-engine sessions in the worker process, reacts to control
 * messages from the API (via Redis pub/sub), and performs safe restart
 * recovery: engines that were running are restored in ANALYSIS-ONLY mode
 * unless their configuration explicitly opted into trading resume.
 *
 * Sessions are keyed by `userId::symbol` so R_10 and XAUUSD can run in parallel
 * on the same DEMO account. Account-wide capacity/risk remains user-scoped.
 */
export class EngineManager {
  private readonly sessions = new Map<string, LiveEngineSession>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly sub: Redis,
    private readonly publish: EventPublisher,
    private readonly logger: Logger,
    private readonly credentialDecrypt: (ciphertext: string) => string,
    private readonly enqueueCounterfactual?: (candidateId: string) => Promise<void>
  ) {}

  private sessionDeps(): SessionDeps {
    return {
      prisma: this.prisma,
      config: this.config,
      publish: this.publish,
      logger: this.logger,
      credentialDecrypt: this.credentialDecrypt,
      enqueueCounterfactual: this.enqueueCounterfactual
    };
  }

  private sessionsForUser(userId: string): Array<{ key: string; session: LiveEngineSession }> {
    const keys = listSessionKeysForUser(this.sessions.keys(), userId);
    // Legacy single-key sessions (pre multi-symbol) used bare userId.
    if (this.sessions.has(userId) && !keys.includes(userId)) {
      keys.push(userId);
    }
    return keys
      .map((key) => {
        const session = this.sessions.get(key);
        return session ? { key, session } : null;
      })
      .filter((row): row is { key: string; session: LiveEngineSession } => row != null);
  }

  private async stopSessionsForUser(userId: string, reason?: string): Promise<void> {
    for (const { key, session } of this.sessionsForUser(userId)) {
      try {
        await session.stop(reason);
      } catch (err) {
        this.logger.warn({ err, userId, key }, "Session stop failed");
      }
      this.sessions.delete(key);
    }
  }

  async init(): Promise<void> {
    await this.sub.subscribe(CHANNELS.engineControl);
    this.sub.on("message", (channel, raw) => {
      if (channel !== CHANNELS.engineControl) return;
      let message: EngineControlMessage;
      try {
        message = JSON.parse(raw) as EngineControlMessage;
      } catch {
        return;
      }
      void this.handleControl(message).catch((err) =>
        this.logger.error({ err, message }, "Engine control failed")
      );
    });

    await this.recoverAfterRestart();
  }

  /** Restart recovery: reconnect engines that were running, analysis-only by default. */
  private async recoverAfterRestart(): Promise<void> {
    const runningStates = [
      "STARTING",
      "CONNECTING",
      "AUTHENTICATING",
      "SYNCING_DATA",
      "RUNNING_ANALYSIS_ONLY",
      "RUNNING_DEMO_TRADING",
      "RUNNING_LIVE_TRADING",
      "DEGRADED"
    ];
    const engines = await this.prisma.liveEngine.findMany({
      where: { state: { in: runningStates }, emergencyStop: false }
    });
    for (const engine of engines) {
      this.logger.info({ userId: engine.userId }, "Recovering engine after restart");
      await this.prisma.decisionLog.create({
        data: {
          userId: engine.userId,
          eventType: "ENGINE_RESTARTED",
          reasons: ["Worker restarted; engine recovered in analysis-only mode unless resume was configured"],
          correlationId: `restart_${Date.now()}`,
          engineVersion: this.config.ENGINE_VERSION
        }
      });
      try {
        await this.startSessions(engine.userId, { allowTradingResume: false });
      } catch (err) {
        this.logger.error({ err, userId: engine.userId }, "Engine recovery failed");
        await this.prisma.liveEngine.update({
          where: { id: engine.id },
          data: { state: "ERROR", stateReason: `Recovery failed: ${err instanceof Error ? err.message : "unknown"}` }
        });
      }
    }
  }

  private async handleControl(message: EngineControlMessage): Promise<void> {
    const { command, userId } = message;
    this.logger.info({ command, userId }, "Engine control received");
    const userSessions = this.sessionsForUser(userId);

    switch (command) {
      case "START":
        await this.stopSessionsForUser(userId, "Restarting");
        await this.startSessions(userId, { allowTradingResume: true });
        break;
      case "PAUSE":
        for (const { session } of userSessions) await session.pause();
        break;
      case "RESUME":
        for (const { session } of userSessions) await session.resume();
        break;
      case "STOP":
        if (userSessions.length > 0) {
          await this.stopSessionsForUser(userId);
        } else {
          await this.prisma.liveEngine.updateMany({
            where: { userId },
            data: { state: "STOPPED", stateReason: "Stopped by user" }
          });
        }
        break;
      case "EMERGENCY_STOP":
        if (userSessions.length > 0) {
          for (const { key, session } of userSessions) {
            await session.emergencyStop();
            this.sessions.delete(key);
          }
        } else if (this.config.EXECUTION_MODE === "paper_cfd") {
          // No live session — still attempt paper liquidation via ephemeral runtime.
          const runtime = new (await import("../cfd/paperCfdRuntime.js")).PaperCfdRuntime(userId, {
            prisma: this.prisma,
            config: this.config,
            publish: this.publish,
            logger: this.logger
          });
          const open = await this.prisma.position.findFirst({
            where: { userId, status: "OPEN" },
            select: { symbol: true }
          });
          await runtime.init(open?.symbol ?? "R_10");
          const result = await runtime.liquidateAllOpen("RISK_SHUTDOWN");
          this.logger.info({ userId, result }, "Emergency liquidation without live session");
        } else if (
          this.config.EXECUTION_MODE === "broker_demo_mt5" ||
          this.config.EXECUTION_MODE === "broker_real_mt5"
        ) {
          const { emergencyCloseOwnedMt5Positions } = await import("../cfd/mt5CloseRuntime.js");
          const result = await emergencyCloseOwnedMt5Positions({
            prisma: this.prisma,
            config: this.config,
            userId,
            logger: this.logger
          });
          this.logger.info({ userId, result }, "MT5 emergency close without live session");
        }
        break;
      case "CLOSE_POSITION": {
        const positionId = message.positionId;
        if (!positionId) {
          this.logger.warn({ message }, "CLOSE_POSITION missing positionId");
          break;
        }
        const pos = await this.prisma.position.findFirst({
          where: { id: positionId, userId },
          select: { symbol: true }
        });
        const keyed = pos?.symbol ? this.sessions.get(engineSessionKey(userId, pos.symbol)) : undefined;
        const session = keyed ?? userSessions[0]?.session;
        if (session) {
          const result = await session.closePaperPosition(positionId);
          this.logger.info({ userId, positionId, symbol: pos?.symbol, result }, "Manual close via session");
        } else if (
          this.config.EXECUTION_MODE === "broker_demo_mt5" ||
          this.config.EXECUTION_MODE === "broker_real_mt5"
        ) {
          const { closeMt5LocalPosition } = await import("../cfd/mt5CloseRuntime.js");
          const result = await closeMt5LocalPosition({
            prisma: this.prisma,
            config: this.config,
            userId,
            positionId,
            logger: this.logger
          });
          this.logger.info({ userId, positionId, result }, "MT5 manual close without live session");
        } else {
          const runtime = new (await import("../cfd/paperCfdRuntime.js")).PaperCfdRuntime(userId, {
            prisma: this.prisma,
            config: this.config,
            publish: this.publish,
            logger: this.logger
          });
          await runtime.init(pos?.symbol ?? "R_10");
          const result = await runtime.manualClose(positionId);
          this.logger.info({ userId, positionId, result }, "Manual close via ephemeral runtime");
        }
        break;
      }
      case "MODIFY_POSITION": {
        const positionId = message.positionId;
        const stopLoss = message.stopLoss;
        if (!positionId || stopLoss == null || !Number.isFinite(stopLoss)) {
          this.logger.warn({ message }, "MODIFY_POSITION missing positionId/stopLoss");
          break;
        }
        if (
          this.config.EXECUTION_MODE === "broker_demo_mt5" ||
          this.config.EXECUTION_MODE === "broker_real_mt5"
        ) {
          const { modifyMt5LocalPosition } = await import("../cfd/mt5ModifyRuntime.js");
          const result = await modifyMt5LocalPosition({
            prisma: this.prisma,
            config: this.config,
            userId,
            positionId,
            stopLoss,
            takeProfit: message.takeProfit,
            logger: this.logger
          });
          this.logger.info({ userId, positionId, result }, "MT5 manual modify");
        } else {
          const { modifyPaperLocalPosition } = await import("../cfd/paperModifyRuntime.js");
          const result = await modifyPaperLocalPosition({
            prisma: this.prisma,
            config: this.config,
            userId,
            positionId,
            stopLoss,
            takeProfit: message.takeProfit,
            logger: this.logger
          });
          this.logger.info({ userId, positionId, result }, "Paper manual modify");
        }
        break;
      }
      case "RELOAD_CONFIG":
        // Applied on next START; a running session keeps its config for determinism.
        break;
    }
  }

  /**
   * Starts one LiveEngineSession per active LiveEngineConfiguration.
   * Account-wide MT5 capacity/risk is shared across those sessions.
   */
  private async startSessions(userId: string, options: { allowTradingResume: boolean }): Promise<void> {
    const engine = await this.prisma.liveEngine.findUnique({
      where: { userId },
      include: { configurations: { where: { isActive: true }, orderBy: { createdAt: "asc" } } }
    });
    const configurations = engine?.configurations ?? [];
    if (configurations.length === 0) {
      throw new Error("Engine has no active configuration");
    }

    const startedKeys: string[] = [];
    try {
      for (const configuration of configurations) {
        const key = engineSessionKey(userId, configuration.symbol);
        const session = new LiveEngineSession(userId, this.sessionDeps());
        this.sessions.set(key, session);
        startedKeys.push(key);
        await session.start({
          allowTradingResume: options.allowTradingResume,
          configurationId: configuration.id,
          symbol: configuration.symbol
        });
        this.logger.info(
          { userId, symbol: configuration.symbol, sessionKey: key, parsed: parseEngineSessionKey(key) },
          "Live engine session started for symbol track"
        );
      }
    } catch (err) {
      for (const key of startedKeys) {
        const session = this.sessions.get(key);
        if (session) {
          try {
            await session.stop("Sibling session start failed");
          } catch {
            /* ignore */
          }
          this.sessions.delete(key);
        }
      }
      await this.prisma.liveEngine.updateMany({
        where: { userId },
        data: { state: "ERROR", stateReason: err instanceof Error ? err.message : "Start failed" }
      });
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    for (const [key, session] of this.sessions) {
      try {
        await session.stop("Worker shutting down");
      } catch (err) {
        this.logger.warn({ err, key }, "Session stop failed during shutdown");
      }
    }
    this.sessions.clear();
  }
}
