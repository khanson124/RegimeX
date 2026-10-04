import { describe, expect, it, vi } from "vitest";
import { LiveEngineSession, type SessionDeps } from "./liveEngineSession.js";
const base = { EXECUTION_MODE: "broker_demo_mt5", STRATEGY_SELECTION_MODE: "bootstrap", MT5_ENGINE_ENABLED: true,
  REAL_MONEY_ENABLED: true, LIVE_MT5_ENABLED: true, MT5_BRIDGE_SECRET: "test", MT5_BRIDGE_URL: "http://demo",
  MT5_DEMO_BRIDGE_URL: "http://demo", MT5_LIVE_BRIDGE_URL: "http://live", MT5_EXPECTED_ENVIRONMENT: "demo",
  MT5_EXPECTED_LOGIN: "demo-login", MT5_LIVE_EXPECTED_LOGIN: "real-login", LIVE_ALLOWED_SYMBOLS: "R_10" };
function fixture() {
  const logger = { child: vi.fn(), warn: vi.fn(), info: vi.fn() };logger.child.mockReturnValue(logger);
  const prisma = { tradingEnvironmentState: { findUnique: vi.fn().mockResolvedValue({ activeEnvironment: "LIVE" }) },
    liveEngine: { upsert: vi.fn().mockRejectedValue(Error("inspection-stop")) } };
  const deps = { prisma, config: { ...base }, logger } as unknown as SessionDeps;
  return { deps, prisma, session: new LiveEngineSession("u1", deps) };
}
describe("session-wide effective MT5 venue configuration", () => {
  it("makes backend and downstream config agree, isolates dependencies, and restores DEMO from the base config", async () => {
    const f = fixture(); await expect(f.session.start({ allowTradingResume: false })).rejects.toThrow("inspection-stop");
    const state = f.session as unknown as { deps: SessionDeps; executionBackend: string };
    expect(state.executionBackend).toBe("broker_real_mt5");
    expect(state.deps.config).toMatchObject({ EXECUTION_MODE: "broker_real_mt5", MT5_EXPECTED_ENVIRONMENT: "live",
      MT5_BRIDGE_URL: "http://live", MT5_EXPECTED_LOGIN: "real-login" });
    expect(f.deps.config.EXECUTION_MODE).toBe("broker_demo_mt5");expect(f.deps.config.MT5_EXPECTED_LOGIN).toBe("demo-login");
    f.prisma.tradingEnvironmentState.findUnique.mockResolvedValue({ activeEnvironment: "DEMO" });
    await expect(f.session.start({ allowTradingResume: false })).rejects.toThrow("inspection-stop");
    expect(state.deps.config).toMatchObject({ EXECUTION_MODE: "broker_demo_mt5", MT5_EXPECTED_ENVIRONMENT: "demo", MT5_EXPECTED_LOGIN: "demo-login" });
  });
  it("does not bypass disabled REAL flags even when the environment label is LIVE", async () => {
    const f = fixture();f.deps.config.REAL_MONEY_ENABLED = false;f.deps.config.LIVE_MT5_ENABLED = false;
    await expect(f.session.start({ allowTradingResume: true })).rejects.toThrow("LIVE_TRADING_DISABLED");
    expect(f.prisma.liveEngine.upsert).not.toHaveBeenCalled();
  });
});
