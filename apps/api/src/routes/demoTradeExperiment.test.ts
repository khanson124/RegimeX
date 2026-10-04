import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoR10TradeExperimentKey, DEMO_R10_TRADE_EXPERIMENT_DURATION_MS } from "@regimex/shared";
import { registerDemoTradeExperimentRoutes } from "./demoTradeExperiment.js";
import { registerErrorHandler } from "../plugins/errorHandler.js";
import { type AppContext } from "../context.js";
const apps: ReturnType<typeof Fastify>[] = [];
function fixture(options: { mode?: string; environment?: string; hasConfig?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = { get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK"; }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }) };
  const prisma = {
    tradingEnvironmentState: { findUnique: vi.fn(async () => ({ activeEnvironment: options.environment ?? "DEMO" })) },
    liveEngine: { findUnique: vi.fn(async () => ({ configurations: options.hasConfig === false ? [] : [{ symbol: "R_10", mode: "DEMO_TRADING" }] })) },
    decisionLog: { create: vi.fn(async () => ({})) }
  };
  const app = Fastify(); apps.push(app); registerErrorHandler(app);
  registerDemoTradeExperimentRoutes(app, { redis, prisma, tokens: { verifyAccessToken: (token: string) => ({ sub: token }) },
    config: { EXECUTION_MODE: options.mode ?? "broker_demo_mt5", DEMO_TRADING_ENABLED: true, ENGINE_VERSION: "test" }
  } as unknown as AppContext);
  const request = (enabled?: boolean, user = "u1") => app.inject({
    method: enabled === undefined ? "GET" : "PUT", url: "/engine/demo-trade-experiment",
    headers: { authorization: `Bearer ${user}` }, ...(enabled !== undefined ? { payload: { enabled } } : {})
  });
  return { app, request, redis, prisma, store };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
describe("temporary R_10 DEMO trade experiment", () => {
  it("defaults OFF, turns ON with expiry, isolates users, and turns OFF without engine control", async () => {
    const f = fixture(); expect((await f.request()).json().enabled).toBe(false);
    const enabled = await f.request(true); expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, supported: true, symbol: "R_10", strategyScope: "all", dailyCap: 30 });
    expect(f.redis.set).toHaveBeenCalledWith(demoR10TradeExperimentKey("u1"), expect.any(String), "PX", DEMO_R10_TRADE_EXPERIMENT_DURATION_MS);
    expect((await f.request(undefined, "u2")).json().enabled).toBe(false);
    expect((await f.request(false)).json().enabled).toBe(false);
    expect(f.prisma.decisionLog.create).toHaveBeenCalledTimes(2);
  });
  it.each([{ mode: "broker_real_mt5" }, { mode: "paper_cfd" }, { environment: "LIVE" }, { hasConfig: false }])(
    "rejects enabling outside configured R_10 DEMO: %s", async (options) => {
      const f = fixture(options); expect((await f.request(true)).statusCode).toBe(400);
      expect(f.redis.set).not.toHaveBeenCalled();
    });
  it("allows disabling after switching environments", async () => {
    const f = fixture({ mode: "broker_real_mt5" });
    f.store.set(demoR10TradeExperimentKey("u1"), String(Date.now() + 1000));
    expect((await f.request(false)).json().enabled).toBe(false);
  });
  it("reports expired values as OFF even if an old key survives", async () => {
    const f = fixture(); f.store.set(demoR10TradeExperimentKey("u1"), String(Date.now() - 1));
    expect((await f.request()).json().enabled).toBe(false);
  });
  it("does not leave the switch ON if enable auditing fails", async () => {
    const f = fixture(); f.prisma.decisionLog.create.mockRejectedValueOnce(new Error("audit unavailable"));
    expect((await f.request(true)).statusCode).toBe(500);
    expect((await f.request()).json().enabled).toBe(false);
  });
  it("requires authentication and strict boolean payload", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "PUT", url: "/engine/demo-trade-experiment", payload: { enabled: true } })).statusCode).toBe(401);
    for (const payload of [{ enabled: "true" }, { enabled: true, userId: "another" }]) {
      expect((await f.app.inject({ method: "PUT", url: "/engine/demo-trade-experiment",
        headers: { authorization: "Bearer u1" }, payload })).statusCode).toBe(400);
    }
    expect(f.redis.set).not.toHaveBeenCalled();
  });
});
