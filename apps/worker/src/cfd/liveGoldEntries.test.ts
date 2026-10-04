import { describe, expect, it, vi } from "vitest";
import { liveGoldEntriesAllowed } from "./liveGoldEntries.js";
import { Mt5CfdRuntime, type Mt5CfdRuntimeDeps } from "./mt5CfdRuntime.js";
const input = { userId: "u1", executionMode: "broker_real_mt5", symbol: "XAUUSD" };
describe("LIVE Gold entry gate", () => {
  it.each([undefined, null, "", "disabled", "true", "enabled "])("blocks missing/disabled/malformed permission: %s", async (raw) => {
    expect(await liveGoldEntriesAllowed(input, raw === undefined ? undefined : async () => raw)).toBe(false);
  });
  it("allows explicit permission, and re-reads OFF for an in-flight retry", async () => {
    const read = vi.fn().mockResolvedValueOnce("enabled").mockResolvedValueOnce("disabled");
    expect(await liveGoldEntriesAllowed(input, read)).toBe(true);
    expect(await liveGoldEntriesAllowed(input, read)).toBe(false);
    expect(read).toHaveBeenCalledWith("u1");
  });
  it("fails closed if storage is unavailable", async () => {
    const warn = vi.fn();
    expect(await liveGoldEntriesAllowed(input, async () => { throw Error("Redis down"); }, warn)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
  it.each([{ symbol: "R_10" }, { symbol: "OTHER" }, { executionMode: "broker_demo_mt5" },
    { executionMode: "paper_cfd" }])("never reads or affects other scopes: %s", async (override) => {
    const read = vi.fn().mockRejectedValue(Error("Must not read"));
    expect(await liveGoldEntriesAllowed({ ...input, ...override }, read)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it("continues reconciling protective stops for an open Gold position while entry permission is OFF", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), info: vi.fn() }; logger.child.mockReturnValue(logger);
    const read = vi.fn().mockResolvedValue("disabled");
    const adapter = { getOpenPositions: vi.fn().mockResolvedValue([{ brokerPositionId: "42", symbol: "XAUUSD",
      stopLoss: 1995, takeProfit: 2020, currentPrice: 2010 }]) };
    const prisma = { position: { findMany: vi.fn().mockResolvedValue([{ id: "gold1", symbol: "XAUUSD", status: "OPEN",
      brokerPositionId: "42", stopLoss: 1990, takeProfit: 2020, metadata: { executionModel: "broker_real_mt5" } }]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const runtime = new Mt5CfdRuntime("u1", { config: { EXECUTION_MODE: "broker_real_mt5" }, prisma, logger,
      readLiveGoldEntryPermission: read, telegram: {} } as unknown as Mt5CfdRuntimeDeps);
    const state = runtime as unknown as { adapter: unknown; lastCreatedExpirySweepAt: number };
    state.adapter = adapter; state.lastCreatedExpirySweepAt = Date.now();
    await runtime.reconcileOpen();
    expect(adapter.getOpenPositions).toHaveBeenCalledOnce();
    expect(prisma.position.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "u1", brokerPositionId: "42" }),
      data: { stopLoss: 1995, takeProfit: 2020, currentPrice: 2010 }
    }));
    expect(read).not.toHaveBeenCalled();
  });
  it("does not reconcile a DEMO record against the LIVE account even if broker ticket IDs overlap", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), info: vi.fn() }; logger.child.mockReturnValue(logger);
    const adapter = { getOpenPositions: vi.fn().mockResolvedValue([{ brokerPositionId: "42", symbol: "R_10",
      stopLoss: 95, takeProfit: 120, currentPrice: 110 }]), reconstructClosedPosition: vi.fn() };
    const prisma = { position: { findMany: vi.fn().mockResolvedValue([{ id: "demo1", symbol: "R_10", status: "OPEN",
      brokerPositionId: "42", stopLoss: 90, takeProfit: 120, metadata: { executionModel: "broker_demo_mt5" } }]),
      updateMany: vi.fn(), update: vi.fn() } };
    const runtime = new Mt5CfdRuntime("u1", { config: { EXECUTION_MODE: "broker_real_mt5" }, prisma, logger,
      telegram: {} } as unknown as Mt5CfdRuntimeDeps);
    const state = runtime as unknown as { adapter: unknown; lastCreatedExpirySweepAt: number };
    state.adapter = adapter; state.lastCreatedExpirySweepAt = Date.now();
    await runtime.reconcileOpen();
    expect(prisma.position.updateMany).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
    expect(adapter.reconstructClosedPosition).not.toHaveBeenCalled();
  });
  it("blocks actual runtime entry before broker or database work, while ON retains existing gates", async () => {
    const logger = { child: vi.fn(), warn: vi.fn(), info: vi.fn() }; logger.child.mockReturnValue(logger);
    const prisma = { position: { findMany: vi.fn() }, riskProfile: { findFirst: vi.fn() } };
    const read = vi.fn().mockResolvedValue("disabled");
    const runtime = new Mt5CfdRuntime("u1", { config: { EXECUTION_MODE: "broker_real_mt5", REAL_MONEY_ENABLED: true,
      LIVE_MT5_ENABLED: true, MT5_BRIDGE_SECRET: "test", MT5_BRIDGE_URL: "http://test", MT5_EXPECTED_ENVIRONMENT: "live", LIVE_ALLOWED_SYMBOLS: "R_10,XAUUSD" },
      prisma, logger, readLiveGoldEntryPermission: read, telegram: {} } as unknown as Mt5CfdRuntimeDeps);
    type Inner = { executeCfdSignalInner: (signal: { symbol: string; strategyId: string; decision: { action: string }; correlationId: string }) => Promise<{ opened: boolean; reasons: string[] }> };
    const signal = { symbol: "XAUUSD", strategyId: "xau-trend-pullback-v1", decision: { action: "BUY" }, correlationId: "test" };
    const inner = runtime as unknown as Inner;
    expect(await inner.executeCfdSignalInner(signal)).toMatchObject({ opened: false, reasons: ["LIVE_GOLD_ENTRIES_DISABLED"] });
    expect(prisma.position.findMany).not.toHaveBeenCalled(); expect(prisma.riskProfile.findFirst).not.toHaveBeenCalled();
    read.mockResolvedValue("enabled");
    // No adapter/init/reconciliation: permitting Gold must still fail existing runtime health checks.
    expect((await inner.executeCfdSignalInner(signal)).opened).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "test" }), "LIVE_GOLD_ENTRIES_DISABLED");
  });
});
