import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import { CHANNELS, type EngineControlMessage } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";
import {
  getTradingEnvironmentStatus,
  switchTradingEnvironment
} from "../services/tradingEnvironment.js";

/**
 * Operator DEMO/LIVE environment selector.
 * Does not store passwords. Switch always disarms live trading.
 */
export function registerTradingEnvironmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  async function requestEngineStop(userId: string): Promise<void> {
    const message: EngineControlMessage = {
      command: "STOP",
      userId,
      correlationId: randomUUID()
    };
    await ctx.redis.publish(CHANNELS.engineControl, JSON.stringify(message));
  }

  app.get("/trading-environment/status", { preHandler: auth }, async (request) => {
    const status = await getTradingEnvironmentStatus(ctx.prisma, ctx.config, request.userId);
    return { status };
  });

  app.post<{ Body: { environment?: string } }>(
    "/trading-environment/switch",
    { preHandler: auth },
    async (request) => {
      const status = await switchTradingEnvironment(
        ctx.prisma,
        ctx.config,
        request.userId,
        String(request.body?.environment ?? ""),
        { requestEngineStop }
      );
      return { status };
    }
  );
}
