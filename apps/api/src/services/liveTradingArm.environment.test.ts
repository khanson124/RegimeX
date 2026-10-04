import { describe, expect, it, vi } from "vitest";
import { type PrismaClient } from "@regimex/database";
import { type AppConfig } from "@regimex/config";
const adapters = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("@regimex/trading-engine", async (original) => ({ ...await original<object>(), DerivMT5BrokerAdapter: class {
  constructor(options: Record<string, unknown>) { adapters.options.push(options); }
  async connect() {}
  async disconnect() {}
  getStatus() { return { connected: true, eaConnected: true, isDemo: false, tradeMode: "REAL", marginMode: "HEDGING",
    login: "123456", company: "Deriv", server: "Real", account: { balance: 100, equity: 100, usedMargin: 0, freeMargin: 100, floatingPnl: 0 } }; }
} }));
import { getSharedMt5BridgeCircuit, type HttpMt5BridgeClient } from "@regimex/trading-engine";
import { armLiveTrading, getLiveTradingStatus } from "./liveTradingArm.js";
const config = { EXECUTION_MODE: "broker_demo_mt5", REAL_MONEY_ENABLED: true, LIVE_MT5_ENABLED: true,
  MT5_BRIDGE_SECRET: "test", MT5_BRIDGE_URL: "http://demo", MT5_LIVE_BRIDGE_URL: "http://live", MT5_EXPECTED_ENVIRONMENT: "demo",
  MT5_EXPECTED_SERVER: "Demo", MT5_EXPECTED_LOGIN: "demo-login", MT5_LIVE_EXPECTED_SERVER: "Real", MT5_LIVE_EXPECTED_LOGIN: "123456",
  LIVE_ALLOWED_SYMBOLS: "R_10", LIVE_MAX_LOT_SIZE: .01, LIVE_MAX_RISK_PER_TRADE_PERCENT: .1 } as AppConfig;
describe("LIVE status and arm venue routing", () => {
  it("probes the dedicated LIVE account while keeping process defaults and persisted arm state unchanged", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "engine", liveTradingArmed: false, emergencyStop: false });
    const prisma = { liveEngine: { upsert } } as unknown as PrismaClient;
    const status = await getLiveTradingStatus(prisma, config, "u1");
    expect(status).toMatchObject({ liveTradingSupported: true, liveTradingArmed: false, accountEnvironmentValid: true,
      executionMode: "broker_real_mt5", mt5: { server: "Real", loginMasked: "***456" } });
    expect(adapters.options.at(-1)).toMatchObject({ bridgeUrl: "http://live", expectedEnvironment: "live",
      expectedServer: "Real", expectedLogin: "123456", requireDemoAccount: false });
    expect(config.EXECUTION_MODE).toBe("broker_demo_mt5");expect(config.MT5_EXPECTED_LOGIN).toBe("demo-login");
  });
  it("keeps failed LIVE status probes out of the shared DEMO circuit", async () => {
    const prisma = { liveEngine: { upsert: vi.fn().mockResolvedValue({ id: "engine", liveTradingArmed: false }) } } as unknown as PrismaClient;
    await getLiveTradingStatus(prisma, config, "u1");
    const transport = adapters.options.at(-1)?.transport as HttpMt5BridgeClient;
    const before = getSharedMt5BridgeCircuit().snapshot();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Error("offline")));
    try {
      for (let i = 0; i < 3; i++) await transport.request("ping", {}, { requestId: String(i), idempotencyKey: String(i) });
      expect(getSharedMt5BridgeCircuit().snapshot()).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([{ activeEnvironment: "DEMO" }, { activeEnvironment: "LIVE", submissionsBlocked: true },
    { activeEnvironment: "LIVE", switchState: "SWITCHING" }])("rejects arm before account probe or state writes: %s", async (state) => {
    const update = vi.fn();const upsert = vi.fn();const before = adapters.options.length;
    const prisma = { tradingEnvironmentState: { findUnique: vi.fn().mockResolvedValue(state) }, liveEngine: { update, upsert } } as unknown as PrismaClient;
    await expect(armLiveTrading(prisma, config, "u1")).rejects.toThrow("Select a verified LIVE environment");
    expect(update).not.toHaveBeenCalled();expect(upsert).not.toHaveBeenCalled();expect(adapters.options.length).toBe(before);
  });
});
