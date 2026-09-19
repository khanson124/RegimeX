/**
 * Integration-style tests for DEMO↔LIVE environment switching.
 * Uses an in-memory prisma stub + injected account probes (no real MT5).
 */
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@regimex/shared";
import {
  assertMt5ModeBackendConsistency,
  resolveMt5BridgeUrlForEnvironment,
  tradingEnvironmentToBackend
} from "@regimex/trading-engine";
import { switchTradingEnvironment } from "./tradingEnvironment.js";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    REAL_MONEY_ENABLED: true,
    LIVE_MT5_ENABLED: true,
    MT5_BRIDGE_URL: "http://mt5-bridge:8765",
    MT5_DEMO_BRIDGE_URL: "http://mt5-bridge:8765",
    MT5_LIVE_BRIDGE_URL: "http://mt5-bridge-live:8765",
    MT5_BRIDGE_SECRET: "test-secret-value-32chars!!!!",
    MT5_COMMAND_TIMEOUT_MS: 5_000,
    MAX_EXECUTION_QUOTE_AGE_MS: 30_000,
    MT5_MAX_TEST_VOLUME: 0.01,
    MT5_MAX_TEST_RISK_PERCENT: 0.1,
    LIVE_MAX_LOT_SIZE: 0.01,
    LIVE_MAX_RISK_PER_TRADE_PERCENT: 0.05,
    MT5_MAGIC_NUMBER: 26082301,
    MT5_EXPECTED_BROKER: "Deriv",
    MT5_ENGINE_STRATEGY_ALLOWLIST: "squeeze-reclaim-v1",
    MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10,XAUUSD",
    LIVE_ALLOWED_SYMBOLS: "",
    ...overrides
  } as never;
}

function buildPrisma(initial: {
  activeEnvironment?: "DEMO" | "LIVE";
  liveTradingArmed?: boolean;
  intents?: Array<{ state: string }>;
}) {
  const state = {
    userId: "u1",
    activeEnvironment: initial.activeEnvironment ?? "DEMO",
    submissionsBlocked: false,
    switchState: "IDLE",
    lastSwitchAt: null as Date | null,
    lastSwitchError: null as string | null,
    lastVerifiedAccountKind: null as string | null,
    lastVerifiedLoginMasked: null as string | null
  };
  const engine = {
    id: "eng-1",
    userId: "u1",
    liveTradingArmed: initial.liveTradingArmed ?? false,
    liveTradingArmedAt: null as Date | null,
    liveTradingArmedByUserId: null as string | null
  };
  const policies = new Map<string, Record<string, unknown>>();
  const intents = initial.intents ?? [];
  const configUpdates: Array<Record<string, unknown>> = [];

  const prisma = {
    tradingEnvironmentState: {
      upsert: vi.fn(async () => ({ ...state })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data);
        return { ...state };
      }),
      findUnique: vi.fn(async () => ({ ...state }))
    },
    tradingEnvironmentPolicy: {
      upsert: vi.fn(async ({ where, create }: { where: { userId_environment: { environment: string } }; create: Record<string, unknown> }) => {
        const env = where.userId_environment.environment;
        if (!policies.has(env)) {
          policies.set(env, {
            ...create,
            maxVolume: null,
            maxRiskPercent: null,
            maxConcurrent: null,
            bridgeUrlOverride: null
          });
        }
        return policies.get(env)!;
      })
    },
    executionIntent: {
      findMany: vi.fn(async () => intents)
    },
    liveEngine: {
      findUnique: vi.fn(async () => ({ ...engine })),
      findMany: vi.fn(async () => [{ id: engine.id }]),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(engine, data);
        return { count: 1 };
      })
    },
    liveEngineConfiguration: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        configUpdates.push(data);
        return { count: 1 };
      })
    },
    _state: state,
    _engine: engine,
    _configUpdates: configUpdates
  };

  return prisma as never as typeof prisma & {
    _state: typeof state;
    _engine: typeof engine;
    _configUpdates: typeof configUpdates;
  };
}

const demoProbe = {
  connected: true,
  isDemo: true,
  tradeMode: "DEMO",
  login: "12345678"
};

const liveProbe = {
  connected: true,
  isDemo: false,
  tradeMode: "REAL",
  login: "87654321"
};

describe("tradingEnvironment switch integration", () => {
  it("DEMO→LIVE: disarms, stops resume, switches backend, never inherits arm", async () => {
    const prisma = buildPrisma({ activeEnvironment: "DEMO", liveTradingArmed: true });
    const stop = vi.fn(async () => undefined);
    const status = await switchTradingEnvironment(prisma as never, baseConfig(), "u1", "LIVE", {
      probeAccount: async (_c, env) => (env === "LIVE" ? liveProbe : demoProbe),
      requestEngineStop: stop
    });

    expect(stop).toHaveBeenCalledWith("u1");
    expect(prisma._state.activeEnvironment).toBe("LIVE");
    expect(prisma._engine.liveTradingArmed).toBe(false);
    expect(status.liveTradingArmed).toBe(false);
    expect(status.targetBackend).toBe("broker_real_mt5");
    expect(status.executionReadiness.live).toBe(false); // must re-arm deliberately
    expect(prisma._configUpdates.some((u) => u.resumeTradingAfterRestart === false)).toBe(true);
  });

  it("LIVE→DEMO: clears arm and targets broker_demo_mt5", async () => {
    const prisma = buildPrisma({ activeEnvironment: "LIVE", liveTradingArmed: true });
    const status = await switchTradingEnvironment(prisma as never, baseConfig(), "u1", "DEMO", {
      probeAccount: async (_c, env) => (env === "DEMO" ? demoProbe : liveProbe)
    });
    expect(prisma._state.activeEnvironment).toBe("DEMO");
    expect(prisma._engine.liveTradingArmed).toBe(false);
    expect(status.targetBackend).toBe("broker_demo_mt5");
    expect(status.connectedAccountKind).toBe("demo");
  });

  it("blocks account mismatch (LIVE target with DEMO account)", async () => {
    const prisma = buildPrisma({ activeEnvironment: "DEMO" });
    await expect(
      switchTradingEnvironment(prisma as never, baseConfig(), "u1", "LIVE", {
        probeAccount: async () => demoProbe
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma._state.activeEnvironment).toBe("DEMO");
    expect(prisma._state.switchState).toBe("IDLE");
    expect(String(prisma._state.lastSwitchError)).toMatch(/ACCOUNT_MISMATCH|demo/i);
  });

  it("blocks ambiguous execution intents (fail closed)", async () => {
    const prisma = buildPrisma({
      activeEnvironment: "DEMO",
      intents: [{ state: "AMBIGUOUS" }, { state: "SUBMITTED" }]
    });
    await expect(
      switchTradingEnvironment(prisma as never, baseConfig(), "u1", "LIVE", {
        probeAccount: async () => liveProbe
      })
    ).rejects.toThrow(/AMBIGUOUS/);
    expect(prisma._state.activeEnvironment).toBe("DEMO");
  });

  it("blocks unavailable target environment", async () => {
    const prisma = buildPrisma({ activeEnvironment: "DEMO" });
    await expect(
      switchTradingEnvironment(prisma as never, baseConfig(), "u1", "LIVE", {
        probeAccount: async () => ({
          connected: false,
          isDemo: null,
          tradeMode: null,
          login: null
        })
      })
    ).rejects.toThrow(/UNAVAILABLE|TARGET/i);
  });

  it("restart recovery: same-env idle switch is a no-op that does not re-arm", async () => {
    const prisma = buildPrisma({ activeEnvironment: "DEMO", liveTradingArmed: false });
    const status = await switchTradingEnvironment(prisma as never, baseConfig(), "u1", "DEMO", {
      probeAccount: async () => demoProbe
    });
    expect(status.activeEnvironment).toBe("DEMO");
    expect(status.liveTradingArmed).toBe(false);
  });

  it("position isolation: DEMO and LIVE resolve to distinct bridge URLs", () => {
    const config = baseConfig();
    expect(resolveMt5BridgeUrlForEnvironment(config, "DEMO")).toBe("http://mt5-bridge:8765");
    expect(resolveMt5BridgeUrlForEnvironment(config, "LIVE")).toBe("http://mt5-bridge-live:8765");
  });

  it("signal routing: DEMO_TRADING never pairs with broker_real_mt5", () => {
    const bad = assertMt5ModeBackendConsistency({
      sessionMode: "DEMO_TRADING",
      executionBackend: "broker_real_mt5"
    });
    expect(bad.ok).toBe(false);
    expect(tradingEnvironmentToBackend("DEMO")).toBe("broker_demo_mt5");
  });

  it("prevents real-money path when LIVE capability gates are off", async () => {
    const prisma = buildPrisma({ activeEnvironment: "DEMO" });
    await expect(
      switchTradingEnvironment(
        prisma as never,
        baseConfig({ REAL_MONEY_ENABLED: false, LIVE_MT5_ENABLED: false }),
        "u1",
        "LIVE",
        { probeAccount: async () => liveProbe }
      )
    ).rejects.toThrow(/not supported/i);
  });

  it("status DTOs never include raw expectedLogin (only masked)", async () => {
    const prisma = buildPrisma({ activeEnvironment: "DEMO" });
    const status = await switchTradingEnvironment(prisma as never, baseConfig(), "u1", "LIVE", {
      probeAccount: async () => liveProbe
    });
    const json = JSON.stringify(status);
    expect(json).not.toMatch(/87654321/);
    expect(status.connectedLoginMasked).toMatch(/\*\*\*|321/);
    expect(status.policies.DEMO).not.toHaveProperty("expectedLogin");
    expect(status.policies.LIVE).toHaveProperty("expectedLoginMasked");
  });
});
