import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), config: {
  EXECUTION_MODE: "broker_demo_mt5", REAL_MONEY_ENABLED: false, LIVE_MT5_ENABLED: false,
  MT5_BRIDGE_SECRET: "test", MT5_BRIDGE_URL: "http://demo", MT5_LIVE_BRIDGE_URL: "http://live",
  MT5_EXPECTED_ENVIRONMENT: "demo", MT5_LIVE_EXPECTED_SERVER: "Real", MT5_LIVE_EXPECTED_LOGIN: "123456",
  MT5_COMMAND_TIMEOUT_MS: 20000, LIVE_ALLOWED_SYMBOLS: "R_10", LIVE_MAX_LOT_SIZE: .01,
  LIVE_SMOKE_TEST_MODE: false,
  MT5_ENGINE_MAX_VOLUME: .5, MT5_ENGINE_MAX_RISK_PERCENT: .1, LIVE_MAX_RISK_PER_TRADE_PERCENT: .25,
  LIVE_MAX_DAILY_LOSS: 1
}, prisma: { liveEngine: { findUnique: vi.fn() }, tradingEnvironmentState: { findUnique: vi.fn() },
  executionIntent: { findMany: vi.fn() }, $disconnect: vi.fn() } }));
vi.mock("@regimex/config", () => ({ loadConfig: () => mocks.config }));
vi.mock("@regimex/database", () => ({ getPrisma: () => mocks.prisma }));
vi.mock("@regimex/trading-engine", async original => ({ ...await original<object>(),
  HttpMt5BridgeClient: class { request = mocks.request; } }));
import { runLiveReadiness } from "./liveReadiness.js";
const account = { tradeMode: "REAL", marginMode: "HEDGING", login: "123456", server: "Real", company: "Deriv" };
describe("read-only LIVE readiness", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.config.LIVE_MAX_LOT_SIZE = .01;
    mocks.config.LIVE_SMOKE_TEST_MODE = false;
    mocks.prisma.liveEngine.findUnique.mockResolvedValue({ liveTradingArmed: false, emergencyStop: false });
    mocks.prisma.tradingEnvironmentState.findUnique.mockResolvedValue({ activeEnvironment: "DEMO" });
    mocks.prisma.executionIntent.findMany.mockResolvedValue([{ state: "AMBIGUOUS" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ eaRecent: false, eaHealth: "offline" }) }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("probes an idle EA and reports the verified minimum-volume conflict without changing flags or state", async () => {
    mocks.request.mockResolvedValueOnce({ ok: true, result: account }).mockResolvedValueOnce({ ok: true, result: { volumeMin: .5 } });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLiveReadiness("u1");
    const report = JSON.parse(output.mock.calls[0]![0]);
    expect(report).toMatchObject({ connectionReady: false, eaOnline: true, bridgeRecentlyActive: false,
      liveTradingArmed: false, r10MinimumVolume: .5, unresolvedIntents: 1, readOnly: true });
    expect(report.blockers).toContain("R_10 broker minimum 0.5 exceeds configured LIVE/engine volume ceiling");
    expect(report.blockers).toContain("REAL_MONEY_ENABLED=false");
    expect(report.blockers.some((x: string) => x.includes("offline"))).toBe(false);
    expect(mocks.request.mock.calls.map(x => x[0])).toEqual(["getAccount", "getInstrument"]);
    expect(mocks.config.LIVE_MAX_LOT_SIZE).toBe(.01);
    expect(mocks.config.REAL_MONEY_ENABLED).toBe(false);
    expect(mocks.prisma.$disconnect).toHaveBeenCalled();
  });
  it("fails closed when the native account probe times out, without requesting instruments or orders", async () => {
    mocks.request.mockResolvedValueOnce({ ok: false, errorCode: "MT5_BRIDGE_TIMEOUT" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLiveReadiness("u1");
    const report = JSON.parse(output.mock.calls[0]![0]);
    expect(report).toMatchObject({ eaOnline: false, account: null, r10MinimumVolume: null, connectionReady: false });
    expect(report.blockers).toContain("LIVE EA/account unverified: MT5_BRIDGE_TIMEOUT");
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it("does not treat a responding DEMO account as a valid REAL account", async () => {
    mocks.request.mockResolvedValueOnce({ ok: true, result: { ...account, tradeMode: "DEMO" } })
      .mockResolvedValueOnce({ ok: true, result: { volumeMin: .5 } });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLiveReadiness("u1");
    const report = JSON.parse(output.mock.calls[0]![0]);
    expect(report.connectionReady).toBe(false);
    expect(report.blockers).toContain("MT5_ACCOUNT_IS_DEMO: live mode cannot use a DEMO account");
  });
  it("reports the independent smoke-test clamp even with a proposed 0.5-lot ceiling", async () => {
    mocks.config.LIVE_MAX_LOT_SIZE = .5;
    mocks.config.LIVE_SMOKE_TEST_MODE = true;
    mocks.request.mockResolvedValueOnce({ ok: true, result: account })
      .mockResolvedValueOnce({ ok: true, result: { volumeMin: .5 } });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLiveReadiness("u1");
    const report = JSON.parse(output.mock.calls[0]![0]);
    expect(report.limits).toMatchObject({ liveLotCeiling: .5, effectiveLiveLotCeiling: .01, smokeTestMode: true });
    expect(report.blockers).toContain("LIVE_SMOKE_TEST_MODE independently limits LIVE volume to 0.01 lots");
    expect(mocks.config.LIVE_SMOKE_TEST_MODE).toBe(true);
  });
});
