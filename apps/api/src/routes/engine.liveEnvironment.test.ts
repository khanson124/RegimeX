import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEngineRoutes } from "./engine.js";
import { registerErrorHandler } from "../plugins/errorHandler.js";
import { type AppContext } from "../context.js";
const apps: ReturnType<typeof Fastify>[] = [];
function fixture(environment = "LIVE", flags = true) {
  const prisma = {
    tradingEnvironmentState: { findUnique: vi.fn().mockResolvedValue({ activeEnvironment: environment }) },
    symbol: { findUnique: vi.fn().mockResolvedValue({ id: "symbol", enabled: true }) },
    liveEngine: { upsert: vi.fn().mockResolvedValue({ id: "engine" }), findUnique: vi.fn().mockResolvedValue({ id: "engine", liveTradingArmed: true, configurations: [] }) },
    liveEngineConfiguration: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(async ({ data }: { data: object }) => data), updateMany: vi.fn() }
  };
  const config = { EXECUTION_MODE: "broker_demo_mt5", DEMO_TRADING_ENABLED: true, REAL_MONEY_ENABLED: flags,
    LIVE_MT5_ENABLED: flags, MT5_BRIDGE_SECRET: "test", MT5_BRIDGE_URL: "http://demo", MT5_LIVE_BRIDGE_URL: "http://live",
    MT5_EXPECTED_ENVIRONMENT: "demo", MT5_EXPECTED_SERVER: "Demo", MT5_LIVE_EXPECTED_SERVER: "Real", LIVE_ALLOWED_SYMBOLS: "R_10", ENGINE_VERSION: "test" };
  const redis = { publish: vi.fn().mockResolvedValue(0) };
  const app = Fastify(); apps.push(app); registerErrorHandler(app);
  registerEngineRoutes(app, { prisma, config, redis, tokens: { verifyAccessToken: () => ({ sub: "u1" }) } } as unknown as AppContext);
  const request = () => app.inject({ method: "PUT", url: "/engine/configuration", headers: { authorization: "Bearer test" },
    payload: { symbol: "R_10", interval: "1m", mode: "LIVE_TRADING", resumeTradingAfterRestart: true } });
  return { app, request, prisma, config, redis };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(x => x.close())); });
describe("engine selected LIVE environment", () => {
  it("configures LIVE with DEMO process defaults only after LIVE selection and existing capability gates", async () => {
    const f = fixture(); const r = await f.request(); expect(r.statusCode).toBe(200);
    expect(r.json().configuration).toMatchObject({ mode: "LIVE_TRADING", resumeTradingAfterRestart: false });
    expect(f.config.EXECUTION_MODE).toBe("broker_demo_mt5");expect(f.config.MT5_EXPECTED_ENVIRONMENT).toBe("demo");
  });
  it.each([["DEMO", true], ["LIVE", false]])("rejects without selected LIVE and enabled server flags: %s %s", async (environment, flags) => {
    const f = fixture(environment, flags);expect((await f.request()).statusCode).toBe(400);
    expect(f.prisma.liveEngineConfiguration.create).not.toHaveBeenCalled();expect(f.redis.publish).not.toHaveBeenCalled();
  });
  it("reports the same selected venue capability on GET /engine", async () => {
    const f = fixture();const r = await f.app.inject({ method: "GET", url: "/engine", headers: { authorization: "Bearer test" } });
    expect(r.json().engine).toMatchObject({ liveTradingSupported: true, liveTradingArmed: true });
  });
});
