import { type FastifyInstance } from "fastify";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";
import { armLiveTrading, disarmLiveTrading, getLiveTradingStatus } from "../services/liveTradingArm.js";

/**
 * Runtime live-trading arm/disarm.
 * Does NOT rewrite .env / Docker / process env. Hard gates stay server-side.
 */
export function registerLiveTradingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get("/live-trading/status", { preHandler: auth }, async (request) => {
    const status = await getLiveTradingStatus(ctx.prisma, ctx.config, request.userId);
    return { status };
  });

  app.post("/live-trading/arm", { preHandler: auth }, async (request) => {
    const status = await armLiveTrading(ctx.prisma, ctx.config, request.userId);
    return { status };
  });

  app.post("/live-trading/disarm", { preHandler: auth }, async (request) => {
    const status = await disarmLiveTrading(ctx.prisma, ctx.config, request.userId);
    return { status };
  });
}
