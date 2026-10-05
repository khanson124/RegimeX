import { describe, expect, it } from "vitest";
import { buildDemoR10SqueezeEntryAudit } from "./demoR10SqueezeEntryAudit.js";
import type { ReviewTrade } from "./demoR10TradeReview.js";
const time = Date.UTC(2026, 9, 4, 10);
function trade(i = 0): ReviewTrade {
  return { id: String(i).padStart(3, "0"), symbol: "R_10", interval: "1m", origin: "ENGINE", status: "CLOSED",
    strategyId: "squeeze-breakout-v1", strategyVersion: "1", direction: "BUY", closeReason: "STOP_LOSS", realizedPnl: -1,
    initialRiskAmount: 2, closedAt: new Date(time + i * 60000), openedAt: new Date(time - 1000), correlationId: null,
    metadata: { executionModel: "broker_demo_mt5", entryFeatureTelemetry: { telemetryVersion: 1, symbol: "R_10", interval: "1m",
      strategyId: "squeeze-breakout-v1", direction: "BUY", timestamp: time - 60000, adx: 25, candleBodySizeAtr: 1.5,
      priceDistanceFromFastEmaAtr: -2.5, emaStackBullish: true, emaStackBearish: false },
      finalExecution: { side: "BUY", bid: 100, ask: 101, finalEntry: 101, finalAdaptedStopLoss: 91, brokerQuoteTimestampMs: time - 2000 } } };
}
const snapshot = (t: ReviewTrade) => (t.metadata as Record<string, Record<string, unknown>>).entryFeatureTelemetry!;
const execution = (t: ReviewTrade) => (t.metadata as Record<string, Record<string, unknown>>).finalExecution!;
const dim = (t: ReviewTrade, key: string) => buildDemoR10SqueezeEntryAudit([t]).versions[0]!.dimensions.find(d => d.key === key)!;
const selected = (t: ReviewTrade, key: string) => dim(t, key).buckets.find(b => b.recent.trades > 0)!.key;
describe("observational R_10 squeeze entry audit", () => {
  it.each([{ symbol: "XAUUSD" }, { interval: "5m" }, { origin: "MANUAL" }, { status: "OPEN" },
    { strategyId: "ema-pullback-v1" }, { metadata: { executionModel: "broker_real_mt5" } }, { metadata: {} }])("excludes non-target positions %s", changes => {
    expect(buildDemoR10SqueezeEntryAudit([{ ...trade(), ...changes }]).targetClosedTrades).toBe(0);
  });
  it("separates manual/safety/unknown exits and never uses them to explain automatic losses", () => {
    const r = buildDemoR10SqueezeEntryAudit([trade(), { ...trade(1), closeReason: "MANUAL", realizedPnl: 100 },
      { ...trade(2), closeReason: "RISK_SHUTDOWN" }, { ...trade(3), closeReason: "BROKER_CLOSE" }]);
    expect(r).toMatchObject({ targetClosedTrades: 4, automaticClosedTrades: 1, excludedManualTrades: 1, excludedSafetyOrUnknownTrades: 2 });
    expect(r.versions[0]!.recent.netPnl).toBe(-1);
  });
  it("selects the latest 20 closes deterministically with disjoint earlier history", () => {
    const input = Array.from({ length: 25 }, (_, i) => trade(i)).reverse();
    const r = buildDemoR10SqueezeEntryAudit(input).versions[0]!;
    expect(r.recent).toMatchObject({ trades: 20, netPnl: -20, firstCloseAt: trade(5).closedAt!.toISOString(), lastCloseAt: trade(24).closedAt!.toISOString() });
    expect(r.earlier).toMatchObject({ trades: 5, netPnl: -5 });
    expect(r.dimensions.every(d => d.buckets.reduce((sum, b) => sum + b.recent.trades, 0) === 20)).toBe(true);
  });
  it("keeps versions separate and does not assign chronology to undated closes", () => {
    const r = buildDemoR10SqueezeEntryAudit([trade(), { ...trade(1), strategyVersion: "2" },
      { ...trade(2), strategyVersion: null }, { ...trade(3), closedAt: null }], true);
    expect(r.versions).toHaveLength(3); expect(r.hasMore).toBe(true);
    const v = r.versions.find(v => v.strategyVersion === "1")!;
    expect(v.automatic.trades).toBe(2); expect(v.recent.trades).toBe(1); expect(v.undatedTrades).toBe(1);
  });
  it.each([[19.9,"<20"],[20,"20–<30"],[29.9,"20–<30"],[30,"≥30"],[100,"≥30"],[-1,"UNKNOWN"],[101,"UNKNOWN"],[null,"UNKNOWN"],["25","UNKNOWN"]])("ADX boundary %s is %s", (value, expected) => {
    const t=trade(); snapshot(t).adx=value; expect(selected(t,"ADX")).toBe(expected);
  });
  it.each([[0,"<1"],[1,"1–<2"],[2,"≥2"],[-1,"UNKNOWN"],[NaN,"UNKNOWN"]])("body/ATR boundary %s is %s", (value, expected) => {
    const t=trade(); snapshot(t).candleBodySizeAtr=value; expect(selected(t,"BODY_ATR")).toBe(expected);
  });
  it("uses absolute EMA distance and validates directional stacks for BUY and SELL", () => {
    const t=trade(); expect(selected(t,"FAST_EMA_DISTANCE_ATR")).toBe("≥2");
    expect(selected(t,"EMA_STACK")).toBe("ALIGNED");
    t.direction="SELL"; snapshot(t).direction="SELL";
    expect(selected(t,"EMA_STACK")).toBe("OPPOSED");
    snapshot(t).emaStackBullish=false; expect(selected(t,"EMA_STACK")).toBe("MIXED");
    snapshot(t).emaStackBullish=true; snapshot(t).emaStackBearish=true;
    expect(selected(t,"EMA_STACK")).toBe("UNKNOWN");
  });
  it.each(["missing", "version", "symbol", "interval", "strategy", "direction", "future", "no_open_time"])("keeps %s snapshot unknown rather than reconstructing it", kind => {
    const t=trade(); const f=snapshot(t);
    if(kind==="missing") delete (t.metadata as Record<string,unknown>).entryFeatureTelemetry;
    if(kind==="version") f.telemetryVersion=2;
    if(kind==="symbol") f.symbol="R_25";
    if(kind==="interval") f.interval="15m";
    if(kind==="strategy") f.strategyId="ema-pullback-v1";
    if(kind==="direction") f.direction="SELL";
    if(kind==="future") f.timestamp=time+1000;
    if(kind==="no_open_time") t.openedAt=null;
    expect(selected(t,"ADX")).toBe("UNKNOWN"); expect(dim(t,"ADX").recentCovered).toBe(0);
    // Submission telemetry is a separate source and may still be valid.
    if(kind!=="no_open_time") expect(dim(t,"SUBMISSION_SPREAD_STOP").recentCovered).toBe(1);
  });
  it.each([[10,"≤0.10"],[5,"0.10<x≤0.20"],[4,"0.20<x≤0.30"],[2,">0.30"]])("submission stop distance %s selects %s", (distance, expected) => {
    const t=trade(); execution(t).finalAdaptedStopLoss=101-Number(distance);
    expect(selected(t,"SUBMISSION_SPREAD_STOP")).toBe(expected);
  });
  it.each(["missing","crossed","zero_stop","wrong_side","future_quote","missing_quote_time"])("invalid %s execution stays unknown", kind=>{
    const t=trade(); const e=execution(t);
    if(kind==="missing") delete (t.metadata as Record<string,unknown>).finalExecution;
    if(kind==="crossed") e.bid=102;
    if(kind==="zero_stop") e.finalAdaptedStopLoss=101;
    if(kind==="wrong_side") e.side="SELL";
    if(kind==="future_quote") e.brokerQuoteTimestampMs=time+1000;
    if(kind==="missing_quote_time") delete e.brokerQuoteTimestampMs;
    expect(selected(t,"SUBMISSION_SPREAD_STOP")).toBe("UNKNOWN");
  });
  it("uses outcome P&L, including profitable stop exits, and excludes missing values", () => {
    const r=buildDemoR10SqueezeEntryAudit([trade(),{...trade(1),realizedPnl:2},{...trade(2),realizedPnl:null}]).versions[0]!;
    expect(r.recent).toMatchObject({ trades:3,valuedTrades:2,missingPnl:1,wins:1,losses:1,netPnl:1,expectancyR:.25 });
    expect(r.dimensions[0]!.buckets.find(b=>b.key==="20–<30")!.recent.netPnl).toBe(1);
  });
  it("retains inputs and model boundaries regardless of outcomes", ()=>{
    const t=trade();const original=structuredClone(t);
    const a=buildDemoR10SqueezeEntryAudit([t]);const b=buildDemoR10SqueezeEntryAudit([{...t,realizedPnl:1000}]);
    expect(t).toEqual(original);expect(a.model).toBe("R10_SQUEEZE_ENTRY_BINS_V1");
    expect(a.versions[0]!.dimensions.map(d=>d.buckets.map(b=>[b.key,b.recent.trades])))
      .toEqual(b.versions[0]!.dimensions.map(d=>d.buckets.map(b=>[b.key,b.recent.trades])));
  });
});
