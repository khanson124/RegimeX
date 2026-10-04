import { resolveMt5EnvironmentConfig } from "@regimex/config";
import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import { z } from "zod";
import { liveGoldEntryPermissionKey, isLiveGoldEntryPermissionEnabled, ValidationError } from "@regimex/shared";
import { parseLiveAllowedSymbols, resolveLiveTradingCapability } from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerLiveGoldEntryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);
  async function status(userId: string) {
    let enabled = false;
    let storageAvailable = true;
    try { enabled = isLiveGoldEntryPermissionEnabled(await ctx.redis.get(liveGoldEntryPermissionKey(userId))); }
    catch { storageAvailable = false; }
    const environment = await ctx.prisma.tradingEnvironmentState.findUnique({ where: { userId } });
    const venueConfig = resolveMt5EnvironmentConfig(ctx.config, environment?.activeEnvironment === "LIVE" ? "LIVE" :
      environment?.activeEnvironment === "DEMO" ? "DEMO" : null);
    const supported = venueConfig.EXECUTION_MODE === "broker_real_mt5" &&
      resolveLiveTradingCapability(venueConfig).liveTradingSupported &&
      parseLiveAllowedSymbols(ctx.config.LIVE_ALLOWED_SYMBOLS).includes("XAUUSD") &&
      (!environment || environment.activeEnvironment === "LIVE");
    return { supported, enabled, storageAvailable, symbol: "XAUUSD", executionMode: venueConfig.EXECUTION_MODE };
  }
  app.get("/engine/live-gold-entries", { preHandler: auth }, async (request) => status(request.userId));
  app.put("/engine/live-gold-entries", { preHandler: auth }, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const key = liveGoldEntryPermissionKey(request.userId);
    const audit = () => ctx.prisma.decisionLog.create({ data: {
      userId: request.userId, eventType: "LIVE_GOLD_ENTRY_PERMISSION_CHANGED", symbol: "XAUUSD",
      reasons: [enabled ? "Operator requested new LIVE Gold entries ON; all LIVE gates still apply" : "New LIVE Gold entries disabled; existing position management continues"],
      correlationId: randomUUID(), engineVersion: ctx.config.ENGINE_VERSION
    } });
    if (enabled) {
      const state = await status(request.userId);
      if (!state.supported || !state.storageAvailable) throw new ValidationError("Enabling Gold entries requires an available LIVE MT5 environment and Gold in the LIVE allowlist.");
      const engine = await ctx.prisma.liveEngine.findUnique({ where: { userId: request.userId },
        include: { configurations: { where: { isActive: true, symbol: "XAUUSD", mode: "LIVE_TRADING" } } } });
      if (!engine?.configurations.length) throw new ValidationError("Configure XAUUSD in LIVE_TRADING before enabling new LIVE Gold entries.");
      // Audit authorization before permission can become active. Audit failure leaves permission unchanged.
      await audit();
      await ctx.redis.set(key, "enabled");
    } else {
      // Disabling takes priority over audit availability and is allowed even in DEMO.
      await ctx.redis.set(key, "disabled");
      await audit();
    }
    return status(request.userId);
  });
}
