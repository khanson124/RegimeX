import { describe, expect, it } from "vitest";
import { buildDemoR10TradeReview, type ReviewTrade, type ReviewSelection } from "./demoR10TradeReview.js";
const trade: ReviewTrade = { id: "1", symbol: "R_10", interval: "1m", origin: "ENGINE", status: "CLOSED",
  strategyId: "squeeze-breakout-v1", strategyVersion: "1", closeReason: "MANUAL", realizedPnl: 2,
  initialRiskAmount: 1, closedAt: new Date("2026-10-04T12:00:00Z"), metadata: { executionModel: "broker_demo_mt5" }, correlationId: "c" };
const selection: ReviewSelection = { correlationId: "c", strategyId: trade.strategyId,
  featureSummary: { symbol: "R_10", interval: "1m", engineSelectionMode: "AUTO" } };
const bucket = (rows: { key: string; trades: number }[], key: string) => rows.find(r => r.key === key)!;
describe("R_10 DEMO recorded-exit review", () => {
  it.each([{ symbol: "XAUUSD" }, { interval: "15m" }, { origin: "MANUAL" }, { status: "OPEN" }, { status: "REJECTED" },
    { status: "PENDING" }, { metadata: { executionModel: "broker_real_mt5" } }, { metadata: {} }, { metadata: null }])("excludes non-target scope %s", override => {
    expect(buildDemoR10TradeReview([{ ...trade, ...override }]).sampledClosedTrades).toBe(0);
  });
  it("separates manual, strategy-driven, safety and unknown exits without guessing from P&L", () => {
    const trades = [trade, { ...trade, id: "2", closeReason: "TAKE_PROFIT", realizedPnl: 4 },
      { ...trade, id: "3", closeReason: "STOP_LOSS", realizedPnl: -1 },
      { ...trade, id: "4", closeReason: "RISK_SHUTDOWN", realizedPnl: -2 },
      { ...trade, id: "5", closeReason: "BROKER_CLOSE", realizedPnl: 3 }];
    const r = buildDemoR10TradeReview(trades);
    expect(r.exits.find(e => e.key === "MANUAL")).toMatchObject({ trades: 1, netPnl: 2 });
    expect(r.exits.find(e => e.key === "AUTOMATIC")).toMatchObject({ trades: 2, netPnl: 3, profitFactor: 4 });
    expect(r.exits.find(e => e.key === "SAFETY")).toMatchObject({ trades: 1, netPnl: -2 });
    expect(r.exits.find(e => e.key === "UNKNOWN")).toMatchObject({ trades: 1, netPnl: 3 });
  });
  it("uses actual recorded reason even if a manual close was requested or stop edited", () => {
    const r = buildDemoR10TradeReview([{ ...trade, closeReason: "STOP_LOSS",
      metadata: { executionModel: "broker_demo_mt5", closeRequested: "MANUAL", manuallyModified: true } }]);
    expect(bucket(r.exits, "AUTOMATIC").trades).toBe(1); expect(bucket(r.exits, "MANUAL").trades).toBe(0);
  });
  it("does not zero-fill missing P&L or use missing/zero risk for R", () => {
    const r = buildDemoR10TradeReview([trade, { ...trade, id: "2", realizedPnl: -1, initialRiskAmount: 2 },
      { ...trade, id: "3", realizedPnl: null }, { ...trade, id: "4", realizedPnl: NaN },
      { ...trade, id: "5", realizedPnl: 0, initialRiskAmount: 0 }]);
    expect(r.overall).toMatchObject({ trades: 5, valuedTrades: 3, missingPnl: 2, wins: 1, losses: 1, pushes: 1,
      netPnl: 1, profitFactor: 2, expectancy: 1 / 3, winRate: 1 / 3, riskValuedTrades: 2, expectancyR: .75 });
    expect(buildDemoR10TradeReview([{ ...trade, realizedPnl: null }]).overall.netPnl).toBeNull();
  });
  it("shows no invented infinite PF for all-winning or empty cohorts", () => {
    expect(buildDemoR10TradeReview([trade]).overall.profitFactor).toBeNull();
    expect(buildDemoR10TradeReview([]).overall).toMatchObject({ trades: 0, netPnl: null, winRate: null, expectancyR: null });
  });
  it("preserves strategy versions and separates exits within each strategy", () => {
    const r = buildDemoR10TradeReview([trade, { ...trade, id: "2", strategyVersion: "2", closeReason: "STOP_LOSS" },
      { ...trade, id: "3", strategyId: "ema-pullback-v1", strategyVersion: null }]);
    expect(r.strategies).toHaveLength(3);
    expect(r.strategies.find(g => g.strategyVersion === "2")?.exits.find(e => e.key === "AUTOMATIC")?.trades).toBe(1);
  });
  it("does not treat absent or malformed experiment tags as baseline/OFF", () => {
    const r = buildDemoR10TradeReview([trade, { ...trade, id: "2", metadata: { ...trade.metadata as object,
      demoLossBypass: { enabled: true }, demoTradeExperiment: { active: false } } },
      { ...trade, id: "3", metadata: { ...trade.metadata as object, demoLossBypass: { enabled: "true" } } }]);
    expect(bucket(r.lossBypass, "ENABLED").trades).toBe(1);
    expect(bucket(r.lossBypass, "DISABLED").trades).toBe(0);
    expect(bucket(r.lossBypass, "UNRECORDED").trades).toBe(2);
    expect(bucket(r.tradeExperiment, "DISABLED").trades).toBe(1);
  });
  it("joins the original selector to the effective strategy only with exact AUTO context", () => {
    expect(bucket(buildDemoR10TradeReview([trade], [selection]).selection, "AUTO_ORIGINAL").trades).toBe(1);
    expect(bucket(buildDemoR10TradeReview([trade], [{ ...selection, strategyId: "ema-pullback-v1" }]).selection, "AUTO_FALLBACK").trades).toBe(1);
    for (const rows of [[], [selection, selection], [{ ...selection, featureSummary: {} }],
      [{ ...selection, featureSummary: { symbol: "XAUUSD", interval: "1m", engineSelectionMode: "AUTO" } }]]) {
      expect(bucket(buildDemoR10TradeReview([trade], rows).selection, "UNKNOWN").trades).toBe(1);
    }
    expect(bucket(buildDemoR10TradeReview([trade], [{ ...selection, featureSummary: { symbol: "R_10", interval: "1m", engineSelectionMode: "SINGLE" } }]).selection, "SINGLE").trades).toBe(1);
  });
  it("reports actual date span and truncation and leaves evidence unchanged", () => {
    const original = structuredClone(trade);
    const r = buildDemoR10TradeReview([trade, { ...trade, closedAt: null }], [selection], true);
    expect(r.firstCloseAt).toBe(trade.closedAt!.toISOString()); expect(r.lastCloseAt).toBe(r.firstCloseAt);
    expect(r.hasMore).toBe(true); expect(trade).toEqual(original);
  });
});
