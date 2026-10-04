import { afterEach, describe, expect, it, vi } from "vitest";
const saga = vi.hoisted(() => ({ create: vi.fn(), persist: vi.fn() }));
vi.mock("./mt5ExecutionIntegrity.js", async original => ({ ...await original<object>(),
  countMt5ConsumedCapacitySlots: vi.fn().mockResolvedValue(0), findExecutionIntentBySignal: vi.fn().mockResolvedValue(null),
  createPendingPositionWithExecutionIntent: saga.create, markExecutionIntentSubmitted: vi.fn(),
  refreshPendingExecutionParams: vi.fn(), persistPositionOpenFromBrokerResult: saga.persist }));
vi.mock("./paperPersistence.js", () => ({ recordPositionEvent: vi.fn() }));
vi.mock("@regimex/trading-engine", async original => ({ ...await original<object>(),
  proposeCfdStopTarget: () => ({ direction: "BUY", entryPrice: 100, stopLoss: 95, takeProfit: 110,
    stopDistance: 5, targetDistance: 10, riskRewardRatio: 2, initialRiskReward: 2,
    stopMethod: "structure", targetMethod: "fixed_r", reasons: [] }) }));
import { type OpenMarketPositionResult } from "@regimex/shared";
import { loadConfig, resetConfigCache } from "@regimex/config";
import { mergePositionMetadataForOpen } from "@regimex/trading-engine";
import { Mt5CfdRuntime, type Mt5CfdRuntimeDeps } from "./mt5CfdRuntime.js";
const now = 1800000000000;
const instrument = { symbol: "Volatility 10 Index", enabled: true, verified: true, contractSize: 1, volumeStep: .01,
  minVolume: .5, maxVolume: 400, tickSize: .001, tickValue: .001, marginRate: .01, spreadBps: 0,
  slippageBps: 0, pricePrecision: 3, currency: "USD", source: "mt5_live_discovery" };
function fixture(enabled: boolean, loggerFails = false, lifecycle = "EXPERIMENTAL", emergencyStop = false) {
  resetConfigCache();
  const config = loadConfig({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32), CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32), EXECUTION_MODE: "broker_demo_mt5",
    MT5_BRIDGE_SECRET: "s".repeat(32), MT5_BRIDGE_URL: "http://fixture", MT5_ENGINE_ENABLED: "true", DEMO_TRADING_ENABLED: "true", MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10",
    MT5_ENGINE_STRATEGY_ALLOWLIST: "squeeze-breakout-v1", MT5_ENGINE_MAX_VOLUME: ".5",
    MT5_DEMO_R10_SPREAD_SHADOW_ENABLED: String(enabled) });
  const logger = { child: vi.fn(), warn: vi.fn(), info: vi.fn((record: { event?: string }) => {
    if (loggerFails && record.event === "DEMO_R10_SPREAD_SHADOW") throw Error("log sink offline");
  }) }; logger.child.mockReturnValue(logger);
  const adapter = { getQuote: vi.fn().mockResolvedValue({ symbol: instrument.symbol, bid: 98, ask: 100, timestamp: now }),
    getLiveSymbol: vi.fn().mockResolvedValue({ point: .001, tickSize: .001, digits: 3, stopsLevel: 0, freezeLevel: 0 }),
    getInstrumentMetadata: vi.fn().mockResolvedValue(instrument),
    tryAdoptOpenByIdempotency: vi.fn().mockResolvedValue(null),
    getAccount: vi.fn().mockResolvedValue({ equity: 10000, balance: 10000, freeMargin: 10000 }),
    openMarketPosition: vi.fn(async (request: Record<string, unknown>) => ({ accepted: true, brokerPositionId: "42", entryPrice: 100,
      position: { ...request, volume: request.volume, brokerPositionId: "42", metadata: request.metadata } } as unknown as OpenMarketPositionResult)) };
  const prisma = { riskProfile: { findFirst: vi.fn().mockResolvedValue(null) },
    strategyEvidenceState: { findUnique: vi.fn().mockResolvedValue({ lifecycle }) },
    position: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    signal: { findUnique: vi.fn().mockResolvedValue({ entryReason: [] }), update: vi.fn() },
    liveEngine: { findUnique: vi.fn().mockResolvedValue({ emergencyStop, liveTradingArmed: false }) } };
  saga.create.mockResolvedValue({ ok: true, position: { id: "p1", status: "PENDING" }, intent: { id: "i1", state: "CREATED" }, consumedSlotsBefore: 0 });
  const runtime = new Mt5CfdRuntime("u1", { config, prisma, logger, publish: vi.fn(),
    telegram: { notifyRejected: vi.fn(), notifyOpened: vi.fn() } } as unknown as Mt5CfdRuntimeDeps);
  Object.assign(runtime, { adapter, lastReconcileOkAt: now, loadMapping: vi.fn().mockResolvedValue({ internalSymbol: "R_10",
    brokerSymbol: instrument.symbol, verified: true, minVolume: .5, volumeStep: .01, maxVolume: 400 }) });
  type Input = Parameters<Mt5CfdRuntime["executeCfdSignal"]>[0];
  const input = { signalId: "s1", correlationId: "c1", sessionMode: "DEMO_TRADING", symbol: "R_10", interval: "1m",
    strategyId: "squeeze-breakout-v1", strategyVersion: "1", regime: "BREAKOUT_EXPANSION",
    decision: { action: "BUY", confidence: .8, entryReason: [], invalidationReason: [] },
    candle: { timestamp: now, open: 99, high: 101, low: 98, close: 100, volume: 1 }, features: { close: 100, atr: 1 }, candles: [] } as unknown as Input;
  return { runtime, input, adapter, logger, config };
}
afterEach(() => { vi.restoreAllMocks(); resetConfigCache(); saga.create.mockClear(); saga.persist.mockClear(); });
describe("spread shadow cannot change production submission", () => {
  it("still submits identical risk, volume, stops and targets when every shadow threshold rejects", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const on = fixture(true); const onResult = await on.runtime.executeCfdSignal(on.input);
    expect(onResult, JSON.stringify(onResult)).toMatchObject({ opened: true });
    const request = on.adapter.openMarketPosition.mock.calls[0]![0];
    const metadata = request.metadata as { demoR10SpreadShadow: { initial: { spreadToStopRatio: number }; submission: { comparisons: { wouldPassSpreadFilter: boolean }[] } } };
    expect(metadata.demoR10SpreadShadow.initial.spreadToStopRatio).toBe(.4);
    expect(metadata.demoR10SpreadShadow.submission.comparisons.every(x => x.wouldPassSpreadFilter === false)).toBe(true);
    const off = fixture(false); expect(await off.runtime.executeCfdSignal(off.input)).toMatchObject({ opened: true });
    const withoutTelemetry = ({ metadata: _, ...rest }: Record<string, unknown>) => rest;
    expect(withoutTelemetry(request)).toEqual(withoutTelemetry(off.adapter.openMarketPosition.mock.calls[0]![0]));
    expect(off.adapter.openMarketPosition.mock.calls[0]![0].metadata).not.toHaveProperty("demoR10SpreadShadow");
    const merged = mergePositionMetadataForOpen({ existingMetadata: { executionModel: "broker_demo_mt5", demoR10SpreadShadow: { initial: {} } },
      symbolAudit: { internalSymbol: "R_10", brokerSymbol: instrument.symbol }, brokerPositionMetadata: request.metadata as Record<string, unknown>, executionTelemetry: (request.metadata as { executionTelemetry: Parameters<typeof mergePositionMetadataForOpen>[0]["executionTelemetry"] }).executionTelemetry });
    expect(merged.demoR10SpreadShadow).toEqual(metadata.demoR10SpreadShadow);
  });
  it("does not interrupt orders when only the shadow log sink fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(true, true); expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: true });
    expect(f.adapter.openMarketPosition).toHaveBeenCalledOnce();
  });
  it("observes a retry using refreshed quote and stop geometry without introducing an extra attempt", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(true);
    f.adapter.openMarketPosition.mockResolvedValueOnce({ accepted: false, brokerPositionId: null, entryPrice: null,
      appliedSpreadBps: 0, appliedSlippageBps: 0, position: null, rejectionReasons: ["ORDER_SEND_FAILED", "10016"] });
    f.adapter.getQuote.mockResolvedValueOnce({ symbol: instrument.symbol, bid: 98, ask: 100, timestamp: now })
      .mockResolvedValueOnce({ symbol: instrument.symbol, bid: 98, ask: 100, timestamp: now })
      .mockResolvedValueOnce({ symbol: instrument.symbol, bid: 97, ask: 101, timestamp: now });
    const result = await f.runtime.executeCfdSignal(f.input);
    expect(result, JSON.stringify(result)).toMatchObject({ opened: true });
    expect(f.adapter.openMarketPosition).toHaveBeenCalledTimes(2);
    const requests = f.adapter.openMarketPosition.mock.calls.map(call => call[0]);
    const submission = (requests[1]!.metadata as { demoR10SpreadShadow: { submission: {
      phase: string; spreadToStopRatio: number; entryPrice: number; adjustedStopLoss: number } } }).demoR10SpreadShadow.submission;
    expect(submission).toMatchObject({ phase: "invalid_stops_retry", entryPrice: 101, adjustedStopLoss: 95 });
    expect(submission.spreadToStopRatio).toBeCloseTo(4 / 6);
    expect(requests[1]!.volume).toBe(.5);
  });
  it.each(["SUSPENDED", "REJECTED"])("retains existing lifecycle blocking: %s", async lifecycle => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(true, false, lifecycle); expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false, decisionCode: "LIFECYCLE_BLOCKED" });
    expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
  });
  it("retains the emergency-stop risk gate", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const f = fixture(true, false, "EXPERIMENTAL", true); expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false, reasons: ["Emergency stop is active"] });
    expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
  });
});
