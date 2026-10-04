import { describe, expect, it } from "vitest";
import { assessDemoR10HtfShadow } from "../engine/demoR10HtfShadow.js";
import { isDemoR10StudyTrade, summarizeHtfStudy, type StudyObservation, type StudyTrade } from "./demoR10HtfStudy.js";
const trade: StudyTrade = { id: "1", symbol: "R_10", interval: "1m", origin: "ENGINE", direction: "BUY",
  strategyId: "squeeze-breakout-v1", strategyVersion: "1", signalId: "s", status: "CLOSED", realizedPnl: 2,
  closeReason: "TP", metadata: { executionModel: "broker_demo_mt5" } };
function observation(id: string, pass: boolean | null): StudyObservation {
  const assessment = assessDemoR10HtfShadow({ enabled: true, executionBackend: "broker_demo_mt5", mode: "DEMO_TRADING",
    symbol: "R_10", interval: "1m", action: "BUY", decisionCloseTimeMs: 1000000, signalId: "s", strategyId: trade.strategyId, correlationId: "c" }, [])!;
  assessment.comparisons.forEach(c => { c.wouldPassTrendFilter = pass; });
  return { positionId: id, strategyVersion: "1", assessedAt: "2026-10-04", demoLossBypass: null, demoTradeExperiment: null, assessment };
}
describe("isolated DEMO HTF forward study", () => {
  it.each([{ metadata: { executionModel: "broker_real_mt5" } }, { metadata: {} }, { metadata: null },
    { metadata: { executionModel: "paper_cfd" } }, { symbol: "XAUUSD" }, { interval: "15m" },
    { origin: "MANUAL" }, { signalId: null }, { status: "PENDING" }, { status: "REJECTED" }, { direction: "HOLD" }])("excludes unsafe/non-trading scope %s", changes => {
    const t = { ...trade, ...changes }; expect(isDemoR10StudyTrade(t)).toBe(false);
    expect(summarizeHtfStudy([t], [observation(t.id, true)]).baseline.closedTrades).toBe(0);
  });
  it("compares the same covered baseline and reports missing history separately", () => {
    const trades = [trade, { ...trade, id: "2", realizedPnl: -1 }, { ...trade, id: "3", realizedPnl: 100 }];
    const summary = summarizeHtfStudy(trades, [observation("1", true), observation("2", false), observation("3", null)]);
    expect(summary.baseline).toMatchObject({ closedTrades: 3, netPnl: 101, profitFactor: 102 });
    for (const c of summary.comparisons) {
      expect(c.coveredClosedTrades).toBe(2); expect(c.indeterminateClosedTrades).toBe(1);
      expect(c.coveredBaseline).toMatchObject({ netPnl: 1, closedTrades: 2 });
      expect(c.aligned).toMatchObject({ netPnl: 2, closedTrades: 1 });
      expect(c.opposedOrNeutral).toMatchObject({ netPnl: -1, closedTrades: 1 });
    }
  });
  it("excludes open, missing PnL and unobserved trades from closed results", () => {
    const trades = [trade, { ...trade, id: "2", status: "OPEN" }, { ...trade, id: "3", realizedPnl: null }, { ...trade, id: "4" }];
    const s = summarizeHtfStudy(trades, [observation("1", true), observation("2", true), observation("3", true)]);
    expect(s).toMatchObject({ assessedPositions: 3, openPositions: 1, closedPositions: 1, closedWithoutPnl: 1 });
    expect(s.baseline.closedTrades).toBe(1);
  });
  it("keeps strategy/version and exit-reason cohorts distinct and never invents infinite PF", () => {
    const trades = [trade, { ...trade, id: "2", realizedPnl: -2, strategyVersion: "2", closeReason: "MANUAL" }];
    const s = summarizeHtfStudy(trades, [observation("1", true), observation("2", true)]);
    expect(s.byStrategyVersion.map(c => c.key)).toEqual(["squeeze-breakout-v1@1", "squeeze-breakout-v1@2"]);
    expect(s.closeReasons.map(c => c.reason)).toEqual(["TP", "MANUAL"]);
    expect(s.baseline).toMatchObject({ closedTrades: 2, netPnl: 0, profitFactor: 1 });
    expect(s.byStrategyVersion[0]!.baseline.profitFactor).toBeNull();
    expect(summarizeHtfStudy([], []).baseline).toMatchObject({ closedTrades: 0, expectancy: null, profitFactor: null, winRate: null });
  });
});
