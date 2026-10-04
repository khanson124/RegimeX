import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveGoldEntryPermissionKey } from "@regimex/shared";
import { registerLiveGoldEntryRoutes } from "./liveGoldEntries.js";
import { registerErrorHandler } from "../plugins/errorHandler.js";
import { type AppContext } from "../context.js";
const apps: ReturnType<typeof Fastify>[] = [];
function fixture(options: { mode?: string; environment?: string; hasConfig?: boolean; realMoney?: boolean; allowedSymbols?: string } = {}) {
  const store = new Map<string, string>();
  const redis = { get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK"; }) };
  const prisma = {
    tradingEnvironmentState: { findUnique: vi.fn(async () => ({ activeEnvironment: options.environment ?? "LIVE" })) },
    liveEngine: { findUnique: vi.fn(async () => ({ configurations: options.hasConfig === false ? [] : [{ symbol: "XAUUSD", mode: "LIVE_TRADING" }] })) },
    decisionLog: { create: vi.fn(async () => ({})) }
  };
  const app = Fastify(); apps.push(app); registerErrorHandler(app);
  registerLiveGoldEntryRoutes(app, { redis, prisma, tokens: { verifyAccessToken: (token: string) => ({ sub: token }) },
    config: { EXECUTION_MODE: options.mode ?? "broker_real_mt5", REAL_MONEY_ENABLED: options.realMoney ?? true,
      LIVE_MT5_ENABLED: true, MT5_BRIDGE_SECRET: "test", MT5_BRIDGE_URL: "http://test", MT5_EXPECTED_ENVIRONMENT: "live",
      LIVE_ALLOWED_SYMBOLS: options.allowedSymbols ?? "R_10,XAUUSD", ENGINE_VERSION: "test" }
  } as unknown as AppContext);
  const request = (enabled?: boolean, user = "u1") => app.inject({
    method: enabled === undefined ? "GET" : "PUT", url: "/engine/live-gold-entries",
    headers: { authorization: `Bearer ${user}` }, ...(enabled !== undefined ? { payload: { enabled } } : {})
  });
  return { app, request, redis, prisma, store };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
describe("LIVE Gold entry control", () => {
  it("defaults OFF, permits explicit ON without expiry, isolates users, and disables without engine control", async () => {
    const f = fixture(); expect((await f.request()).json()).toMatchObject({ enabled: false, supported: true, symbol: "XAUUSD" });
    expect((await f.request(true)).json().enabled).toBe(true);
    expect(f.redis.set).toHaveBeenCalledWith(liveGoldEntryPermissionKey("u1"), "enabled");
    expect(f.prisma.decisionLog.create.mock.invocationCallOrder[0]!).toBeLessThan(f.redis.set.mock.invocationCallOrder[0]!);
    expect(f.prisma.liveEngine.findUnique).toHaveBeenCalledWith({ where: { userId: "u1" }, include: {
      configurations: { where: { isActive: true, symbol: "XAUUSD", mode: "LIVE_TRADING" } } } });
    expect((await f.request(undefined, "u2")).json().enabled).toBe(false);
    expect((await f.request(false)).json().enabled).toBe(false);
    expect(f.redis.set).toHaveBeenLastCalledWith(liveGoldEntryPermissionKey("u1"), "disabled");
  });
  it.each([{ mode: "broker_demo_mt5", environment: "DEMO" }, { mode: "paper_cfd" }, { environment: "DEMO" },
    { hasConfig: false }, { realMoney: false }, { allowedSymbols: "R_10" }])("rejects enabling outside configured/allowed LIVE Gold: %s", async (options) => {
    const f = fixture(options); expect((await f.request(true)).statusCode).toBe(400);
    expect(f.redis.set).not.toHaveBeenCalled();
  });
  it("uses the selected LIVE venue even when the base process defaults to DEMO", async () => {
    const f = fixture({ mode: "broker_demo_mt5", environment: "LIVE" });
    expect((await f.request(true)).json()).toMatchObject({ enabled: true, supported: true, executionMode: "broker_real_mt5" });
  });
  it("permits disabling in DEMO even without a LIVE configuration", async () => {
    const f = fixture({ mode: "broker_demo_mt5", environment: "DEMO", hasConfig: false });
    f.store.set(liveGoldEntryPermissionKey("u1"), "enabled");
    expect((await f.request(false)).json()).toMatchObject({ enabled: false, supported: false });
  });
  it("reports malformed or missing storage OFF, and fails closed on storage errors", async () => {
    const f = fixture(); f.store.set(liveGoldEntryPermissionKey("u1"), "true");
    expect((await f.request()).json().enabled).toBe(false);
    f.redis.get.mockRejectedValueOnce(Error("Redis down"));
    expect((await f.request()).json()).toMatchObject({ enabled: false, storageAvailable: false });
    f.redis.get.mockRejectedValueOnce(Error("Redis down"));
    expect((await f.request(true)).statusCode).toBe(400);expect(f.redis.set).not.toHaveBeenCalled();
  });
  it("audit failure prevents enabling and does not undo an OFF request", async () => {
    const f = fixture(); f.prisma.decisionLog.create.mockRejectedValueOnce(Error("audit unavailable"));
    expect((await f.request(true)).statusCode).toBe(500);
    expect(f.redis.set).not.toHaveBeenCalled();expect((await f.request()).json().enabled).toBe(false);
    f.store.set(liveGoldEntryPermissionKey("u1"), "enabled");
    f.prisma.decisionLog.create.mockRejectedValueOnce(Error("audit unavailable"));
    expect((await f.request(false)).statusCode).toBe(500);
    expect((await f.request()).json().enabled).toBe(false);
  });
  it("requires authentication and forbids arbitrary symbols or other users in the payload", async () => {
    const f = fixture();
    expect((await f.app.inject({ method: "PUT", url: "/engine/live-gold-entries", payload: { enabled: false } })).statusCode).toBe(401);
    for (const payload of [{ enabled: "false" }, { enabled: false, symbol: "R_10" }, { enabled: true, userId: "u2" }]) {
      expect((await f.app.inject({ method: "PUT", url: "/engine/live-gold-entries", headers: { authorization: "Bearer u1" }, payload })).statusCode).toBe(400);
    }
    expect(f.redis.set).not.toHaveBeenCalled();
  });
});
