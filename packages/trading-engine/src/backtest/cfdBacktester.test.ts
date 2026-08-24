import { describe, expect, it } from "vitest";
import { CFD_SIMULATOR_VERSION, type InstrumentMetadata } from "@regimex/shared";
import {
  applyExecutableFill,
  applyExitFill,
  assertPaperAccountInvariants,
  derivePaperAccountNumbers,
  floatingPnl,
  isQuoteFresh
} from "../execution/cfdMath.js";
import { DefaultPositionSizingService } from "../execution/positionSizing.js";
import { InstrumentMetadataRegistry } from "../broker/instrumentRegistry.js";
import { PaperCFDBrokerAdapter } from "../broker/paperCFDBroker.js";
import { BarCfdPositionSimulator } from "./cfdSimulator.js";
import { CfdBacktester } from "./cfdBacktester.js";
import { BreakoutMomentumStrategy } from "../strategies/breakoutMomentum.js";
import { proposeBreakoutMomentumStopTarget } from "../strategies/breakoutMomentumCfd.js";
import { type Candle } from "@regimex/shared";

const instrument: InstrumentMetadata = {
  symbol: "R_10",
  enabled: true,
  verified: true,
  contractSize: 1,
  volumeStep: 0.01,
  minVolume: 0.01,
  maxVolume: 5,
  tickSize: 0.001,
  tickValue: 0.1,
  marginRate: 0.01,
  spreadBps: 0,
  slippageBps: 0,
  pricePrecision: 3,
  currency: "USD"
};

describe("CFD numerical P&L example (exact)", () => {
  it("SL = -$50 gross, TP = +$100 gross before transaction costs", () => {
    const equity = 10_000;
    const riskPct = 0.5;
    const entry = 1000;
    const stop = 998;
    const tp = 1004;

    const sizing = new DefaultPositionSizingService().calculate({
      equity,
      direction: "BUY",
      entryPrice: entry,
      stopLoss: stop,
      riskPerTradePercent: riskPct,
      instrument
    });

    expect(sizing.success).toBe(true);
    expect(sizing.riskAmount).toBe(50);
    expect(sizing.volume).toBe(0.25);
    expect(sizing.lossAtStop).toBe(50);

    // Explicit tick math: |1004-1000|/0.001 * 0.10 * 0.25 = $100 (not $150)
    const tpGross = floatingPnl("BUY", entry, tp, 0.25, instrument);
    const slGross = floatingPnl("BUY", entry, stop, 0.25, instrument);
    expect(tpGross).toBe(100);
    expect(slGross).toBe(-50);

    const tpSim = new BarCfdPositionSimulator().simulate({
      direction: "BUY",
      entryPrice: entry,
      stopLoss: stop,
      takeProfit: tp,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: 1005, low: 999, close: 1004 }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(tpSim.closeReason).toBe("TAKE_PROFIT");
    expect(tpSim.grossPnl).toBe(100);
    expect(tpSim.netPnl).toBe(100);
    expect(tpSim.grossR).toBe(2);
    expect(tpSim.netR).toBe(2);

    const slSim = new BarCfdPositionSimulator().simulate({
      direction: "BUY",
      entryPrice: entry,
      stopLoss: stop,
      takeProfit: tp,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: 1001, low: 997, close: 997.5 }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(slSim.closeReason).toBe("STOP_LOSS");
    expect(slSim.grossPnl).toBe(-50);
    expect(slSim.netPnl).toBe(-50);
    expect(slSim.grossR).toBe(-1);
    expect(slSim.netR).toBe(-1);
  });

  it("STOP_LOSS_FIRST on same-bar SL+TP", () => {
    const sim = new BarCfdPositionSimulator().simulate({
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: 995,
      takeProfit: 1010,
      volume: 0.25,
      instrument,
      bars: [{ open: 1000, high: 1012, low: 994, close: 1001 }],
      spreadBps: 0,
      slippageBps: 0
    });
    expect(sim.closeReason).toBe("STOP_LOSS");
  });

  it("rejects when instrument metadata is missing/disabled", () => {
    const sizing = new DefaultPositionSizingService().calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: 998,
      riskPerTradePercent: 0.5,
      instrument: { ...instrument, enabled: false, verified: false }
    });
    expect(sizing.success).toBe(false);
  });

  it("rejects when normalized volume is below minVolume", () => {
    const sizing = new DefaultPositionSizingService().calculate({
      equity: 10,
      direction: "BUY",
      entryPrice: 1000,
      stopLoss: 900,
      riskPerTradePercent: 0.5,
      instrument
    });
    expect(sizing.success).toBe(false);
  });
});

describe("unified fill model + live/backtest parity", () => {
  const costly: InstrumentMetadata = {
    ...instrument,
    spreadBps: 20, // full spread = 20 bps
    slippageBps: 5
  };

  it("documents full-spread half-per-side convention", () => {
    const mid = 1000;
    const buy = applyExecutableFill("BUY", mid, 20, 5);
    const sell = applyExecutableFill("SELL", mid, 20, 5);
    // half spread = 1.0, slip = 0.5 → BUY 1001.5, SELL 998.5
    expect(buy.fillPrice).toBe(1001.5);
    expect(sell.fillPrice).toBe(998.5);
    const exitBuyPos = applyExitFill("BUY", mid, 20, 5);
    expect(exitBuyPos.fillPrice).toBe(998.5);
  });

  it("paper broker and bar simulator agree on net P&L for same fills", async () => {
    const mid = 1000;
    const stop = 998;
    const tp = 1004;
    const now = Date.now();
    const entryFill = applyExecutableFill("BUY", mid, costly.spreadBps, costly.slippageBps);
    const sizing = new DefaultPositionSizingService().calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: entryFill.fillPrice,
      stopLoss: stop,
      riskPerTradePercent: 0.5,
      instrument: costly
    });
    expect(sizing.success).toBe(true);
    const volume = sizing.volume!;

    const registry = new InstrumentMetadataRegistry();
    registry.register(costly);
    const broker = new PaperCFDBrokerAdapter(registry, {
      currency: "USD",
      initialBalance: 10_000,
      fallbackSpreadBps: 20,
      fallbackSlippageBps: 5,
      maxQuoteAgeMs: 30_000
    });
    await broker.connect();
    broker.setQuote({ symbol: "R_10", bid: mid, ask: mid, mid, timestamp: now });

    const opened = await broker.openMarketPosition({
      idempotencyKey: "parity-1",
      symbol: "R_10",
      direction: "BUY",
      volume,
      stopLoss: stop,
      takeProfit: tp,
      quote: { symbol: "R_10", bid: mid, ask: mid, mid, timestamp: now },
      instrument: costly,
      riskAmount: sizing.riskAmount!,
      riskPercent: 0.5,
      initialRiskReward: 2,
      marginRequired: 1
    });
    expect(opened.accepted).toBe(true);
    expect(opened.entryPrice).toBe(entryFill.fillPrice);

    // TP trigger at 1004 mid
    const exitMid = 1004;
    const closed = await broker.closePosition({
      brokerPositionId: opened.brokerPositionId!,
      reason: "TAKE_PROFIT",
      quote: { symbol: "R_10", bid: exitMid, ask: exitMid, mid: exitMid, timestamp: now }
    });

    const sim = new BarCfdPositionSimulator().simulate({
      direction: "BUY",
      entryPrice: entryFill.fillPrice,
      stopLoss: stop,
      takeProfit: tp,
      volume,
      instrument: costly,
      bars: [{ open: mid, high: 1005, low: 999, close: 1004 }],
      spreadBps: costly.spreadBps,
      slippageBps: costly.slippageBps
    });

    expect(sim.closeReason).toBe("TAKE_PROFIT");
    expect(Math.abs(closed.realizedPnl - sim.netPnl)).toBeLessThan(0.02);
    expect(Math.abs(closed.closePrice - sim.exitPrice)).toBeLessThan(1e-6);
    // netR preferred; grossR is diagnostic (no exit fill)
    expect(sim.netR).not.toBeNull();
    expect(sim.grossR).not.toBeNull();
    expect(sim.grossPnl).toBeGreaterThan(sim.netPnl);
  });

  it("sizes so actual loss at stop from filled entry ≤ risk", () => {
    const mid = 1000;
    const stop = 998;
    const fill = applyExecutableFill("BUY", mid, 20, 5);
    const sizing = new DefaultPositionSizingService().calculate({
      equity: 10_000,
      direction: "BUY",
      entryPrice: fill.fillPrice,
      stopLoss: stop,
      riskPerTradePercent: 0.5,
      instrument: costly
    });
    expect(sizing.success).toBe(true);
    expect(sizing.lossAtStop!).toBeLessThanOrEqual(sizing.riskAmount! + 0.01);
  });
});

describe("quote freshness", () => {
  it("isQuoteFresh respects MAX_EXECUTION_QUOTE_AGE_MS", () => {
    const now = 1_000_000;
    expect(isQuoteFresh(now - 29_000, now, 30_000)).toBe(true);
    expect(isQuoteFresh(now - 30_001, now, 30_000)).toBe(false);
    expect(isQuoteFresh(null, now, 30_000)).toBe(false);
  });

  it("paper broker rejects stale open quotes", async () => {
    const registry = new InstrumentMetadataRegistry();
    registry.register(instrument);
    const broker = new PaperCFDBrokerAdapter(registry, {
      currency: "USD",
      initialBalance: 10_000,
      fallbackSpreadBps: 10,
      fallbackSlippageBps: 5,
      maxQuoteAgeMs: 1_000
    });
    await broker.connect();
    const open = await broker.openMarketPosition({
      idempotencyKey: "stale",
      symbol: "R_10",
      direction: "BUY",
      volume: 0.1,
      stopLoss: 990,
      takeProfit: 1020,
      quote: {
        symbol: "R_10",
        bid: 1000,
        ask: 1000,
        mid: 1000,
        timestamp: Date.now() - 5_000
      },
      instrument,
      riskAmount: 50,
      riskPercent: 0.5,
      initialRiskReward: 2,
      marginRequired: 1
    });
    expect(open.accepted).toBe(false);
    expect(open.rejectionReasons.some((r) => r.toLowerCase().includes("stale"))).toBe(true);
  });
});

describe("paper account invariants", () => {
  it("equity = balance + floating; freeMargin = equity - usedMargin", () => {
    const snap = derivePaperAccountNumbers({
      balance: 10_000,
      floatingPnl: -25.5,
      usedMargin: 100,
      realizedPnl: 12
    });
    expect(snap.equity).toBe(9974.5);
    expect(snap.freeMargin).toBe(9874.5);
    expect(assertPaperAccountInvariants(snap)).toEqual([]);
  });

  it("holds after open → mark → close lifecycle", async () => {
    const registry = new InstrumentMetadataRegistry();
    registry.register(instrument);
    const broker = new PaperCFDBrokerAdapter(registry, {
      currency: "USD",
      initialBalance: 10_000,
      fallbackSpreadBps: 0,
      fallbackSlippageBps: 0,
      maxQuoteAgeMs: 60_000
    });
    await broker.connect();
    const now = Date.now();
    broker.setQuote({ symbol: "R_10", bid: 1000, ask: 1000, mid: 1000, timestamp: now });

    const open = await broker.openMarketPosition({
      idempotencyKey: "acct-1",
      symbol: "R_10",
      direction: "BUY",
      volume: 0.25,
      stopLoss: 998,
      takeProfit: 1004,
      quote: { symbol: "R_10", bid: 1000, ask: 1000, mid: 1000, timestamp: now },
      instrument,
      riskAmount: 50,
      riskPercent: 0.5,
      initialRiskReward: 2,
      marginRequired: 1
    });
    expect(open.accepted).toBe(true);

    let acct = await broker.getAccount();
    expect(assertPaperAccountInvariants(acct)).toEqual([]);
    expect(acct.balance).toBe(10_000);
    expect(acct.usedMargin).toBeGreaterThan(0);

    broker.setQuote({ symbol: "R_10", bid: 1002, ask: 1002, mid: 1002, timestamp: now });
    acct = await broker.getAccount();
    expect(assertPaperAccountInvariants(acct)).toEqual([]);
    expect(acct.floatingPnl).toBe(50); // +2 price * volume math
    expect(acct.equity).toBe(10_050);

    const closed = await broker.closePosition({
      brokerPositionId: open.brokerPositionId!,
      reason: "TAKE_PROFIT",
      quote: { symbol: "R_10", bid: 1004, ask: 1004, mid: 1004, timestamp: now }
    });
    expect(closed.realizedPnl).toBe(100);
    acct = await broker.getAccount();
    expect(assertPaperAccountInvariants(acct)).toEqual([]);
    expect(acct.balance).toBe(10_100);
    expect(acct.floatingPnl).toBe(0);
    expect(acct.usedMargin).toBe(0);
    expect(acct.equity).toBe(10_100);
    expect(acct.realizedPnl).toBe(100);
  });
});

describe("proposeBreakoutMomentumStopTarget structure stop", () => {
  it("produces 2R target from Donchian structure", () => {
    const p = proposeBreakoutMomentumStopTarget({
      direction: "BUY",
      entryPrice: 1000,
      features: { close: 1000, donchianLow: 990, donchianHigh: 999, atr: 2 } as never,
      candles: [],
      params: { tickSize: 0.001, targetRMultiple: 2, structureBufferTicks: 0 }
    });
    expect(p).not.toBeNull();
    expect(p!.stopLoss).toBe(990);
    expect(p!.takeProfit).toBe(1020);
    expect(p!.riskRewardRatio).toBe(2);
  });
});

function synthCandles(n: number, start = 1000): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + (i % 17 === 0 ? 3 : i % 13 === 0 ? -2 : 0.2);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    out.push({
      symbol: "R_10",
      interval: "1m",
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000,
      open,
      high,
      low,
      close,
      tickCount: 10,
      isComplete: true,
      source: "SEED"
    });
    price = close;
  }
  return out;
}

describe("CfdBacktester integration", () => {
  it("runs breakout-momentum through cfd_v1 without throwing", async () => {
    const strategy = new BreakoutMomentumStrategy();
    const bt = new CfdBacktester({
      startingBalance: 10_000,
      riskPerTradePercent: 0.5,
      minRiskRewardRatio: 1.5,
      maxHoldBars: 30,
      instrument,
      strategies: [{ strategy, parameters: strategy.validateParameters({}) }],
      testSplit: 0.2
    });
    const result = await bt.run(synthCandles(250));
    expect(result.simulatorVersion).toBe("cfd_v1");
    expect(result.summary.simulatorVersion).toBe("cfd_v1");
    expect(result.summary.rMetric).toBe("netR");
    expect(result.cancelled).toBe(false);
    for (const t of result.trades) {
      expect(t.volume).toBeGreaterThan(0);
      expect(t.initialRiskAmount).toBeGreaterThan(0);
      expect(["STOP_LOSS", "TAKE_PROFIT", "STRATEGY_EXIT", "MAX_HOLD_TIME"]).toContain(t.closeReason);
      if (t.netR !== null && t.initialRiskAmount > 0) {
        expect(Math.abs(t.netR - t.netPnl / t.initialRiskAmount)).toBeLessThan(0.02);
      }
    }
  });
});
