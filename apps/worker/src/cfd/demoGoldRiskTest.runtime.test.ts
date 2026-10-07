import { afterEach, describe, expect, it, vi } from "vitest";
const saga = vi.hoisted(() => ({ create: vi.fn(), persist: vi.fn() }));
vi.mock("./mt5ExecutionIntegrity.js", async original => ({ ...await original<object>(),
  countMt5ConsumedCapacitySlots: vi.fn().mockResolvedValue(0), findExecutionIntentBySignal: vi.fn().mockResolvedValue(null),
  createPendingPositionWithExecutionIntent: saga.create, markExecutionIntentSubmitted: vi.fn(),
  refreshPendingExecutionParams: vi.fn(), persistPositionOpenFromBrokerResult: saga.persist, failClosedPendingExecution: vi.fn() }));
vi.mock("./paperPersistence.js", () => ({ recordPositionEvent: vi.fn() }));
vi.mock("@regimex/trading-engine", async original => ({ ...await original<object>(),
  proposeCfdStopTarget: () => ({ direction: "BUY", entryPrice: 100, stopLoss: 95, takeProfit: 110,
    stopDistance: 5, targetDistance: 10, riskRewardRatio: 2, initialRiskReward: 2,
    stopMethod: "structure", targetMethod: "fixed_r", reasons: [] }) }));
import { type OpenMarketPositionResult } from "@regimex/shared";
import { loadConfig, resetConfigCache } from "@regimex/config";
import { Mt5CfdRuntime, type Mt5CfdRuntimeDeps } from "./mt5CfdRuntime.js";
const now = Date.parse("2026-10-06T20:00:00Z");
const instrument = { symbol: "XAUUSD", enabled: true, verified: true, contractSize: 100, volumeStep: .01,
  minVolume: .01, maxVolume: 400, tickSize: .01, tickValue: 1, marginRate: .01, spreadBps: 0,
  slippageBps: 0, pricePrecision: 3, currency: "USD", source: "mt5_live_discovery" };
function fixture(enabled: boolean, lifecycle = "EXPERIMENTAL", emergencyStop = false) {
  resetConfigCache();
  const config = loadConfig({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32), CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32), EXECUTION_MODE: "broker_demo_mt5",
    MT5_BRIDGE_SECRET: "s".repeat(32), MT5_BRIDGE_URL: "http://fixture", MT5_ENGINE_ENABLED: "true", DEMO_TRADING_ENABLED: "true", MT5_ENGINE_SYMBOL_ALLOWLIST: "XAUUSD",
    MT5_ENGINE_STRATEGY_ALLOWLIST: "xau-trend-pullback-v1", MT5_ENGINE_MAX_VOLUME: ".5",
    MT5_DEMO_XAUUSD_RISK_TEST_UNTIL: enabled ? "2026-10-08T20:00:00Z" : undefined });
  const logger = { child: vi.fn(), warn: vi.fn(), info: vi.fn() }; logger.child.mockReturnValue(logger);
  const adapter = { getStatus: vi.fn().mockReturnValue({ isDemo: true }), getQuote: vi.fn().mockResolvedValue({ symbol: instrument.symbol, bid: 98, ask: 100, timestamp: now }),
    getLiveSymbol: vi.fn().mockResolvedValue({ point: .001, tickSize: .001, digits: 3, stopsLevel: 0, freezeLevel: 0 }),
    getInstrumentMetadata: vi.fn().mockResolvedValue(instrument),
    tryAdoptOpenByIdempotency: vi.fn().mockResolvedValue(null),
    getAccount: vi.fn().mockResolvedValue({ equity: 1000, balance: 1000, freeMargin: 1000 }),
    openMarketPosition: vi.fn(async (request: Record<string, unknown>) => ({ accepted: true, brokerPositionId: "42", entryPrice: 100,
      position: { ...request, volume: request.volume, brokerPositionId: "42", metadata: request.metadata } } as unknown as OpenMarketPositionResult)) };
  const prisma = { riskProfile: { findFirst: vi.fn().mockResolvedValue({ maxDailyLoss: 5, riskPerTradePercent: .25, minCooldownSeconds: 0, maxDailyTrades: 10, maxConsecutiveLosses: 3, volumeOverrideLots: .5 }) },
    strategyEvidenceState: { findUnique: vi.fn().mockResolvedValue({ lifecycle }) },
    position: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockImplementation(async (args: { where: { status?: string } }) => args.where.status === "CLOSED" ? Array.from({ length: 12 }, () => ({ realizedPnl: -1, closedAt: new Date(now - 1000) })) : []), findFirst: vi.fn().mockResolvedValue(null) },
    signal: { findUnique: vi.fn().mockResolvedValue({ entryReason: [] }), update: vi.fn() },
    liveEngine: { findUnique: vi.fn().mockResolvedValue({ emergencyStop, liveTradingArmed: false }) } };
  saga.create.mockResolvedValue({ ok: true, position: { id: "p1", status: "PENDING" }, intent: { id: "i1", state: "CREATED" }, consumedSlotsBefore: 0 });
  const runtime = new Mt5CfdRuntime("u1", { config, prisma, logger, publish: vi.fn(),
    telegram: { notifyRejected: vi.fn(), notifyOpened: vi.fn() } } as unknown as Mt5CfdRuntimeDeps);
  Object.assign(runtime, { adapter, lastReconcileOkAt: now, loadMapping: vi.fn().mockResolvedValue({ internalSymbol: "XAUUSD",
    brokerSymbol: instrument.symbol, verified: true, minVolume: .01, volumeStep: .01, maxVolume: 400 }) });
  type Input = Parameters<Mt5CfdRuntime["executeCfdSignal"]>[0];
  const input = { signalId: "s1", correlationId: "c1", sessionMode: "DEMO_TRADING", symbol: "XAUUSD", interval: "15m",
    strategyId: "xau-trend-pullback-v1", strategyVersion: "1", regime: "BREAKOUT_EXPANSION",
    decision: { action: "BUY", confidence: .8, entryReason: [], invalidationReason: [] },
    candle: { timestamp: now, open: 99, high: 101, low: 98, close: 100, volume: 1 }, features: { close: 100, atr: 1 }, candles: [] } as unknown as Input;
  return { runtime, input, adapter, logger, config, prisma };
}
afterEach(() => { vi.restoreAllMocks(); resetConfigCache(); saga.create.mockClear(); saga.persist.mockClear(); });
describe("Gold DEMO full submission", () => {
 it("uses minimum lot through refreshed quote sizing, ignores shared losses, and records actual risk", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(true);
  const result = await f.runtime.executeCfdSignal(f.input); expect(result, JSON.stringify(result)).toMatchObject({ opened: true });
  const request = f.adapter.openMarketPosition.mock.calls[0]![0];
  expect(request.volume).toBe(.01); expect(request.riskAmount).toBe(5); expect(request.riskPercent).toBe(.5);
  expect(request.metadata).toHaveProperty("demoGoldRiskTest.sizing", "broker_minimum_lot");
 });
 it("keeps normal percentage sizing with flag OFF", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(false);
  // Remove the ordinary user volume override, which is independent of the experiment.
  f.prisma.riskProfile.findFirst.mockResolvedValue({ riskPerTradePercent: .25, maxDailyLoss: 5 });
  expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false }); expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
 });
 it("rechecks account verification before submitting", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(true);
  f.adapter.getStatus.mockReturnValueOnce({ isDemo: true }).mockReturnValue({ isDemo: false });
  expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false, reasons: ["DEMO_XAU_RISK_TEST_EXPIRED"] });
  expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
 });
 it("fails closed if the deadline is reached before submit", async () => {
  let clock = now; vi.spyOn(Date, "now").mockImplementation(() => clock); const f = fixture(true);
  f.adapter.getStatus.mockReturnValueOnce({ isDemo: true }).mockImplementation(() => {
    clock = Date.parse(f.config.MT5_DEMO_XAUUSD_RISK_TEST_UNTIL!); return { isDemo: true };
  });
  expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false, reasons: ["DEMO_XAU_RISK_TEST_EXPIRED"] });
  expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
 });
 it("uses minimum lot and actual risk after the existing invalid-stops retry", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(true);
  f.adapter.openMarketPosition.mockResolvedValueOnce({ accepted: false, brokerPositionId: null, entryPrice: null,
    appliedSpreadBps: 0, appliedSlippageBps: 0, position: null, rejectionReasons: ["ORDER_SEND_FAILED", "10016"] });
  f.adapter.getQuote.mockResolvedValueOnce({ symbol: instrument.symbol, bid: 98, ask: 100, timestamp: now })
    .mockResolvedValueOnce({ symbol: instrument.symbol, bid: 98, ask: 100, timestamp: now })
    .mockResolvedValueOnce({ symbol: instrument.symbol, bid: 99, ask: 101, timestamp: now });
  const result = await f.runtime.executeCfdSignal(f.input); expect(result, JSON.stringify(result)).toMatchObject({ opened: true });
  expect(f.adapter.openMarketPosition).toHaveBeenCalledTimes(2);
  const request = f.adapter.openMarketPosition.mock.calls[1]![0];
  expect(request.volume).toBe(.01); expect(request.riskAmount).toBe(6); expect(request.riskPercent).toBe(.6);
 });
 it.each(["SUSPENDED", "REJECTED"])("keeps lifecycle gate: %s", async lifecycle => {
  vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(true, lifecycle);
  expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false, decisionCode: "LIFECYCLE_BLOCKED" });
  expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
 });
 it("keeps emergency stop", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(true, "EXPERIMENTAL", true);
  expect(await f.runtime.executeCfdSignal(f.input)).toMatchObject({ opened: false }); expect(f.adapter.openMarketPosition).not.toHaveBeenCalled();
 });
});
