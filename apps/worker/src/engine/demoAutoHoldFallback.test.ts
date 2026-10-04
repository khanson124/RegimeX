import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigCache } from "@regimex/config";
import {
  createStrategy, recordMt5QuotePollSuccess, resetSharedMt5BridgeCircuit,
  type ExecutionBackend, type StrategyContext, type StrategyPerformanceRecord,
  type AutoShadowEvaluationReport
} from "@regimex/trading-engine";
import { type Candle, type CandleInterval, type RegimeResult, type StrategyDecision } from "@regimex/shared";
import { LiveEngineSession, type SessionDeps } from "./liveEngineSession.js";

const originalId = "ema-pullback-v1";
const fallbackId = "squeeze-breakout-v1";
const thirdId = "breakout-momentum-v1";
const regime: RegimeResult = {
  regime: "STRONG_UPTREND", confidence: 0.8, reasons: ["test"], timestamp: 1000,
  classifierVersion: "test", scores: { trend: 80, momentum: 70, volatility: 40, range: 20, breakout: 50 }
};
function decision(id: string, action: StrategyDecision["action"], timestamp: number): StrategyDecision {
  return {
    strategyId: id, strategyVersion: "1", action, confidence: 0.8, signalTimestamp: timestamp,
    entryReason: action === "HOLD" ? [] : [id], invalidationReason: action === "HOLD" ? ["hold"] : [],
    proposedStake: null, expiryDuration: null, expiryUnit: null, metadata: {}
  };
}
function strategy(id: string, action: (ctx: StrategyContext) => StrategyDecision["action"]) {
  const evaluate = vi.fn((ctx: StrategyContext) => decision(id, action(ctx), ctx.candles.at(-1)!.closeTime));
  return {
    definitionId: id, enabled: true, parameters: { marker: id, cooldownCandles: 5 },
    strategy: { ...createStrategy("squeeze-breakout"), id, version: "1", evaluate }
  };
}
function performance(id: string, trades: number): StrategyPerformanceRecord {
  return { strategyId: id, regime: "STRONG_UPTREND", trades, profitFactor: 1.4, expectancy: 0.1,
    outOfSampleExpectancy: null, winRate: 0.6, maxDrawdownPercent: 1, recentExpectancy: null,
    sharpeLike: null, stabilityScore: null, expectancyR: 0.3 };
}
// Access only analysis state and replace external I/O. The real analyze/shadow methods run.
type Internals = {
  analyze(candle: Candle): Promise<void>;
  executionBackend: ExecutionBackend;
  mode: "ANALYSIS_ONLY" | "DEMO_TRADING" | "LIVE_TRADING";
  engineSelectionMode: "AUTO" | "SINGLE" | "ENSEMBLE";
  fixedStrategyId: string | null;
  symbol: string;
  interval: CandleInterval;
  candles: Candle[];
  candleIndex: number;
  strategies: ReturnType<typeof strategy>[];
  classifier: { classify: ReturnType<typeof vi.fn> };
  selection: { select: ReturnType<typeof vi.fn> };
  mt5MtfReadyOrNull: ReturnType<typeof vi.fn>;
  buildCandidateEligibilityAudit: ReturnType<typeof vi.fn>;
  loadCfdSelectionPerformance: ReturnType<typeof vi.fn>;
  loadMt5ForwardSnapshot: ReturnType<typeof vi.fn>;
  logDecision: ReturnType<typeof vi.fn>;
  logAutonomousDecision: ReturnType<typeof vi.fn>;
  recordCandidate: ReturnType<typeof vi.fn>;
  mt5Cfd: { executeCfdSignal: ReturnType<typeof vi.fn>; getHealthSnapshot: ReturnType<typeof vi.fn> };
  lastSignalCandle: Map<string, number>;
  shadowLastSignalCandle: Map<string, number>;
  mt5QuoteHealth: Parameters<typeof recordMt5QuotePollSuccess>[0];
  lastTickAt: number;
  mt5ContextCandles: Map<string, Candle[]>;
  runAutoShadowEval: (...args: unknown[]) => Promise<AutoShadowEvaluationReport>;
};
function fixture(options: {
  backend?: ExecutionBackend; mode?: Internals["mode"]; selectionMode?: Internals["engineSelectionMode"];
  symbol?: string; interval?: CandleInterval; originalAction?: StrategyDecision["action"];
  fallbackAction?: (ctx: StrategyContext) => StrategyDecision["action"]; shadowEnabled?: boolean;
  resultCode?: string; opened?: boolean; htfShadowEnabled?: boolean;
} = {}) {
  resetConfigCache(); resetSharedMt5BridgeCircuit();
  const config = loadConfig({
    DATABASE_URL: "postgresql://test:test@localhost/test", JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32), CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32),
    EXECUTION_MODE: "broker_demo_mt5", DEMO_TRADING_ENABLED: "true",
    MT5_DEMO_R10_HTF_SHADOW_ENABLED: String(options.htfShadowEnabled ?? false),
    MT5_BRIDGE_SECRET: "test-secret-at-least-16", MT5_BRIDGE_URL: "http://localhost:8765",
    FEATURE_AUTO_SHADOW_EVAL: String(options.shadowEnabled ?? true), MT5_ENGINE_ENABLED: "true",
    MT5_ENGINE_SYMBOL_ALLOWLIST: "R_10", MT5_ENGINE_STRATEGY_ALLOWLIST: `${originalId},${fallbackId},${thirdId}`
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const signal = { create: vi.fn().mockResolvedValue({ id: "signal" }), update: vi.fn() };
  const candleRead = vi.fn().mockResolvedValue([]);
  const publish = vi.fn();
  const session = new LiveEngineSession("user", { config, logger, publish,
    prisma: { signal, candle: { findMany: candleRead } }, credentialDecrypt: (value: string) => value } as unknown as SessionDeps) as unknown as Internals;
  const original = strategy(originalId, () => options.originalAction ?? "HOLD");
  const fallback = strategy(fallbackId, options.fallbackAction ?? (() => "BUY"));
  const third = strategy(thirdId, () => "SELL");
  const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    symbol: options.symbol ?? "R_10", interval: options.interval ?? "1m", openTime: i * 60000,
    closeTime: (i + 1) * 60000, open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i,
    tickCount: 10, isComplete: true, source: "MT5_HISTORY"
  }));
  Object.assign(session, {
    executionBackend: options.backend ?? "broker_demo_mt5", mode: options.mode ?? "DEMO_TRADING",
    engineSelectionMode: options.selectionMode ?? "AUTO", fixedStrategyId: originalId,
    symbol: options.symbol ?? "R_10", interval: options.interval ?? "1m", candleIndex: 100, candles,
    // Deliberately rank-3 before rank-2 in the eligible/shadow iteration order.
    strategies: [original, third, fallback], classifier: { classify: vi.fn().mockReturnValue(regime) },
    selection: { select: vi.fn().mockReturnValue({ selectedStrategyId: originalId,
      regime: regime.regime, selectionMode: "BOOTSTRAP", selectionScore: 10,
      alternatives: [{ strategyId: fallbackId, score: 9 }, { strategyId: thirdId, score: 8 }], reasons: ["rank 1"] }) },
    mt5MtfReadyOrNull: vi.fn().mockReturnValue({ ready: true }),
    buildCandidateEligibilityAudit: vi.fn().mockReturnValue({ rows: [], eligible: [original, third, fallback] }),
    loadCfdSelectionPerformance: vi.fn().mockResolvedValue(new Map([
      [originalId, performance(originalId, 11)], [fallbackId, performance(fallbackId, 22)]
    ])),
    loadMt5ForwardSnapshot: vi.fn(async (id: string) => ({ trades: id === fallbackId ? 22 : 11,
      expectancyR: 0.3, profitFactor: 1.4, maxDrawdownPercent: 1, winRate: 0.6, netRealizedPnl: 1,
      lifecycle: id === fallbackId ? "SUSPENDED" : "EXPERIMENTAL" })),
    logDecision: vi.fn(), logAutonomousDecision: vi.fn(), recordCandidate: vi.fn(),
    mt5Cfd: { executeCfdSignal: vi.fn().mockResolvedValue({ opened: options.opened ?? true,
      decisionCode: options.resultCode ?? "TRADE_OPENED", reasons: ["test"] }),
      getHealthSnapshot: vi.fn().mockReturnValue({}) },
    lastSignalCandle: new Map([[originalId, 70], [fallbackId, 80]]),
    shadowLastSignalCandle: new Map([[fallbackId, 10]]), mt5ContextCandles: new Map([["4h", candles]]),
    lastTickAt: Date.now()
  });
  recordMt5QuotePollSuccess(session.mt5QuoteHealth, Date.now(), Date.now());
  return { session, original, fallback, third, signal, publish, logger, candleRead,
    run: () => session.analyze(candles.at(-1)!) };
}
afterEach(() => { resetConfigCache(); resetSharedMt5BridgeCircuit(); });

describe("R_10 DEMO AUTO HOLD fallback", () => {
  it.each([
    { backend: "broker_real_mt5", mode: "LIVE_TRADING" },
    { backend: "broker_real_mt5", mode: "DEMO_TRADING" },
    { backend: "broker_demo_mt5", mode: "LIVE_TRADING" },
    { backend: "broker_demo_mt5", mode: "ANALYSIS_ONLY" },
    { backend: "paper_cfd", mode: "DEMO_TRADING" }
  ] as const)("never activates outside DEMO backend/mode: %s", async (options) => {
    const f = fixture(options); await f.run();
    expect(f.signal.create).not.toHaveBeenCalled();
    expect(f.session.mt5Cfd.executeCfdSignal).not.toHaveBeenCalled();
    expect(f.fallback.strategy.evaluate).toHaveBeenCalledTimes(1); // observational shadow only
    expect(f.logger.info.mock.calls.some(([data]) => data.event === "DEMO_AUTO_HOLD_FALLBACK_ACTIVATED")).toBe(false);
  });
  it.each(["SINGLE", "ENSEMBLE"] as const)("leaves %s behavior unchanged", async (selectionMode) => {
    const f = fixture({ selectionMode }); await f.run();
    expect(f.fallback.strategy.evaluate).not.toHaveBeenCalled();
    expect(f.signal.create).not.toHaveBeenCalled();
  });
  it("does not activate for another symbol or when shadow is disabled", async () => {
    for (const options of [{ symbol: "R_25" }, { shadowEnabled: false }]) {
      const f = fixture(options); await f.run(); expect(f.signal.create).not.toHaveBeenCalled();
    }
  });
  it("uses the lowest rank and re-evaluates production state, preserving the original selection event", async () => {
    const f = fixture({ fallbackAction: (ctx) => ctx.candlesSinceLastSignal === 20 ? "SELL" : "BUY" });
    await f.run();
    expect(f.fallback.strategy.evaluate.mock.calls.map(([ctx]) => ctx.candlesSinceLastSignal)).toEqual([90, 20]);
    const [shadowCtx, prodCtx] = f.fallback.strategy.evaluate.mock.calls.map(([ctx]) => ctx);
    expect(prodCtx).toMatchObject({ candles: shadowCtx!.candles, features: shadowCtx!.features,
      regime: shadowCtx!.regime, contextCandles: shadowCtx!.contextCandles, parameters: f.fallback.parameters });
    expect(f.signal.create).toHaveBeenCalledWith({ data: expect.objectContaining({ strategyId: fallbackId, action: "SELL" }) });
    expect(f.session.mt5Cfd.executeCfdSignal).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: fallbackId, decision: expect.objectContaining({ strategyId: fallbackId, action: "SELL" })
    }));
    expect(f.session.recordCandidate).toHaveBeenCalledWith(expect.anything(), expect.any(String),
      expect.objectContaining({ strategyId: fallbackId, direction: "SELL" }));
    expect(f.session.logAutonomousDecision).toHaveBeenCalledWith("TRADE_OPENED", expect.anything(),
      expect.objectContaining({ strategyId: fallbackId, action: "SELL", featureSummary: expect.objectContaining({
        evidence: expect.objectContaining({ tradeCount: 22, lifecycle: "SUSPENDED",
          mt5Forward: expect.objectContaining({ trades: 22, lifecycle: "SUSPENDED" }) }) }) }));
    expect(f.session.loadMt5ForwardSnapshot.mock.calls.map(([id]) => id)).toEqual([originalId, fallbackId]);
    expect(f.session.logDecision).toHaveBeenCalledWith("STRATEGY_SELECTED", expect.anything(),
      expect.objectContaining({ strategyId: originalId, featureSummary: expect.objectContaining({
        evidence: expect.objectContaining({ tradeCount: 11 }) }) }));
    expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      originalStrategyId: originalId, fallbackStrategyId: fallbackId, fallbackRank: 2,
      originalAction: "HOLD", fallbackAction: "SELL", correlationId: expect.any(String)
    }), "DEMO_AUTO_HOLD_FALLBACK_ACTIVATED");
    expect(f.session.lastSignalCandle.get(originalId)).toBe(70);
    expect(f.session.lastSignalCandle.get(fallbackId)).toBe(100);
    expect(f.third.strategy.evaluate).toHaveBeenCalledTimes(1); // rank-3 only shadow evaluated
  });
  it("production cooldown HOLD keeps the original HOLD and never tries the next rank", async () => {
    const f = fixture({ fallbackAction: (ctx) => ctx.candlesSinceLastSignal < 5 ? "HOLD" : "BUY" });
    f.session.lastSignalCandle.set(fallbackId, 98); await f.run();
    expect(f.fallback.strategy.evaluate.mock.calls.map(([ctx]) => ctx.candlesSinceLastSignal)).toEqual([90, 2]);
    expect(f.signal.create).not.toHaveBeenCalled();
    expect(f.session.recordCandidate).toHaveBeenCalledWith(expect.anything(), expect.any(String),
      expect.objectContaining({ strategyId: originalId, rejectionCode: "STRATEGY_HOLD" }));
    expect(f.session.lastSignalCandle).toEqual(new Map([[originalId, 70], [fallbackId, 98]]));
    expect(f.third.strategy.evaluate).toHaveBeenCalledTimes(1);
    expect(f.session.loadMt5ForwardSnapshot).toHaveBeenCalledTimes(1);
  });
  it("does not fall back when the original production strategy already signals", async () => {
    const f = fixture({ originalAction: "BUY" }); await f.run();
    expect(f.fallback.strategy.evaluate).toHaveBeenCalledTimes(1);
    expect(f.session.mt5Cfd.executeCfdSignal).toHaveBeenCalledWith(expect.objectContaining({ strategyId: originalId }));
  });
  it("ignores unranked or ineligible alternatives without changing shadow ordering", async () => {
    const f = fixture();
    const runShadow = f.session.runAutoShadowEval.bind(f.session);
    f.session.runAutoShadowEval = async (...args) => {
      const report = await runShadow(...args);
      report.candidates.find((c) => c.strategyId === fallbackId)!.shadowSignalEligible = false;
      report.candidates.find((c) => c.strategyId === thirdId)!.rank = null;
      return report;
    };
    await f.run(); expect(f.signal.create).not.toHaveBeenCalled();
  });
  it.each(["RISK_BLOCKED", "LIFECYCLE_BLOCKED", "EXECUTION_REJECTED"])(
    "retains downstream rejection and cooldown behavior for %s", async (resultCode) => {
      const f = fixture({ opened: false, resultCode }); await f.run();
      expect(f.session.mt5Cfd.executeCfdSignal).toHaveBeenCalledWith(expect.objectContaining({ strategyId: fallbackId }));
      expect(f.signal.update).toHaveBeenCalled();
      expect(f.session.logAutonomousDecision).toHaveBeenCalledWith(resultCode, expect.anything(),
        expect.objectContaining({ strategyId: fallbackId, featureSummary: expect.objectContaining({ lifecycle: "SUSPENDED" }) }));
      expect(f.session.lastSignalCandle.get(fallbackId)).toBe(resultCode === "EXECUTION_REJECTED" ? 100 : 80);
    });
  it("retains the forward-trial interval guard even if a report identifies a blocked candidate", async () => {
    const f = fixture({ interval: "5m" });
    const runShadow = f.session.runAutoShadowEval.bind(f.session);
    f.session.runAutoShadowEval = async (...args) => {
      const report = await runShadow(...args);
      report.candidates.find((c) => c.strategyId === fallbackId)!.shadowSignalEligible = true;
      return report;
    };
    await f.run(); expect(f.session.mt5Cfd.executeCfdSignal).not.toHaveBeenCalled();
    expect(f.session.recordCandidate).toHaveBeenCalledWith(expect.anything(), expect.any(String),
      expect.objectContaining({ strategyId: fallbackId, rejectionCode: "R10_SQUEEZE_FORWARD_TRIAL_1M_ONLY" }));
    expect(f.session.lastSignalCandle.get(fallbackId)).toBe(80);
  });
});

describe("HTF observation in the real session analysis path", () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  it("uses the effective fallback ID and candle close; indeterminate research never blocks a trade", async () => {
    const f = fixture({ htfShadowEnabled: true }); await f.run(); await flush();
    expect(f.candleRead).toHaveBeenCalledTimes(1);
    expect(f.candleRead).toHaveBeenCalledWith(expect.objectContaining({ take: 6000,
      where: expect.objectContaining({ symbol: { derivSymbol: "R_10" }, interval: "1m", isComplete: true,
        source: { in: ["MT5_HISTORY", "MT5_LIVE_TICKS"] }, closeTime: { lte: new Date(6000000) } }) }));
    const observation = f.logger.info.mock.calls.find(([data]) => data.event === "DEMO_R10_HTF_SHADOW")![0];
    expect(observation).toMatchObject({ strategyId: fallbackId, signalId: "signal", decisionCloseTimeMs: 6000000,
      action: "BUY", observationalOnly: true, correlationId: expect.any(String) });
    expect(observation.comparisons.every((c: { wouldPassTrendFilter: unknown }) => c.wouldPassTrendFilter === null)).toBe(true);
    expect(f.session.mt5Cfd.executeCfdSignal).toHaveBeenCalledWith(expect.objectContaining({ strategyId: fallbackId }));
  });
  it.each([{ htfShadowEnabled: false }, { htfShadowEnabled: true, backend: "broker_real_mt5", mode: "LIVE_TRADING", originalAction: "BUY" },
    { htfShadowEnabled: true, symbol: "XAUUSD", originalAction: "BUY" },
    { htfShadowEnabled: true, selectionMode: "SINGLE" } ] as const)("does not read research history for excluded cases: %s", async options => {
    const f = fixture(options); await f.run(); await flush(); expect(f.candleRead).not.toHaveBeenCalled();
  });
  it.each(["unresolved", "reject", "logging"])("research %s cannot delay execution or change cooldown", async kind => {
    const f = fixture({ htfShadowEnabled: true });
    if (kind === "unresolved") f.candleRead.mockImplementation(() => new Promise(() => {}));
    if (kind === "reject") f.candleRead.mockRejectedValue(Error("research unavailable"));
    if (kind === "logging") f.logger.info.mockImplementation(data => { if (data.event === "DEMO_R10_HTF_SHADOW") throw Error("research logger"); });
    await f.run(); await flush();
    expect(f.session.mt5Cfd.executeCfdSignal).toHaveBeenCalledTimes(1);
    expect(f.session.lastSignalCandle.get(fallbackId)).toBe(100);
  });
  it("enabled/disabled observation submits identical execution inputs apart from generated correlation ID", async () => {
    const off = fixture(); await off.run();
    const on = fixture({ htfShadowEnabled: true }); await on.run(); await flush();
    const normalize = (value: Record<string, unknown>) => ({ ...value, correlationId: "same" });
    expect(normalize(on.session.mt5Cfd.executeCfdSignal.mock.calls[0]![0]))
      .toEqual(normalize(off.session.mt5Cfd.executeCfdSignal.mock.calls[0]![0]));
    expect(on.session.lastSignalCandle).toEqual(off.session.lastSignalCandle);
    expect(on.session.shadowLastSignalCandle).toEqual(off.session.shadowLastSignalCandle);
  });
  it("even a determinate trend disagreement remains observational", async () => {
    const f = fixture({ htfShadowEnabled: true, fallbackAction: () => "SELL" });
    // End at the fixture decision's last completed H4 boundary (epoch zero).
    f.candleRead.mockResolvedValue(Array.from({ length: 5040 }, (_, i) => ({
      openTime: new Date((i - 5040) * 60000), closeTime: new Date((i - 5039) * 60000),
      open: 100 + i / 10000, close: 100 + (i + 1) / 10000,
      high: 101 + i / 10000, low: 99 + i / 10000, tickCount: 10,
      source: "MT5_HISTORY", isComplete: true
    })));
    await f.run(); await flush();
    const observation = f.logger.info.mock.calls.find(([data]) => data.event === "DEMO_R10_HTF_SHADOW")![0];
    expect(observation.comparisons[1]).toMatchObject({ interval: "4h", bias: "BULLISH", wouldPassTrendFilter: false });
    expect(f.session.mt5Cfd.executeCfdSignal).toHaveBeenCalledWith(expect.objectContaining({ strategyId: fallbackId,
      decision: expect.objectContaining({ action: "SELL" }) }));
  });
});
