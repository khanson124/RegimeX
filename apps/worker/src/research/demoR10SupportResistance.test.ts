import { describe, expect, it } from "vitest";
import type { Candle } from "@regimex/shared";
import type { HtfShadowSignal } from "../engine/demoR10HtfShadow.js";
import type { StudyTrade } from "./demoR10HtfStudy.js";
import { assessDemoR10SupportResistance as assess, summarizeR10SupportResistance as summarize } from "./demoR10SupportResistance.js";
const M = 60_000, start = Date.UTC(2026,9,1), end = start + 48*15*M;
const signal: HtfShadowSignal = { enabled:true, executionBackend:"broker_demo_mt5", mode:"DEMO_TRADING",
  symbol:"R_10", interval:"1m", action:"BUY", decisionCloseTimeMs:end, signalId:"s", strategyId:"squeeze-breakout-v1", correlationId:"c" };
const entry = {entryPrice:100, initialStopLoss:99};
function history(): Candle[] {
 return Array.from({length:720},(_,i)=>{
  const wave=[0,1,2,3,2,1,0,1][Math.floor(i/15)%8]!;
  return {symbol:"R_10",interval:"1m",openTime:start+i*M,closeTime:start+(i+1)*M,
   open:100,close:100,high:102+wave,low:98-wave,tickCount:1,isComplete:true,source:"MT5_HISTORY"};
 });
}
function extra(i:number,close:number,low:number):Candle {
 return {...history()[0]!,openTime:end+i*M,closeTime:end+(i+1)*M,open:close,close,high:Math.max(108,close),low};
}
const trade:StudyTrade={id:"p",symbol:"R_10",interval:"1m",origin:"ENGINE",direction:"BUY",strategyId:signal.strategyId,
 strategyVersion:"1",signalId:"s",status:"CLOSED",realizedPnl:2,closeReason:"TAKE_PROFIT",metadata:{executionModel:"broker_demo_mt5"}};
describe("observational R_10 support/resistance",()=>{
 it.each([{enabled:false},{executionBackend:"broker_real_mt5"},{executionBackend:"paper_cfd"},{mode:"LIVE_TRADING"},
  {mode:"ANALYSIS_ONLY"},{symbol:"XAUUSD"},{interval:"15m"},{action:"HOLD"}])("rejects non-DEMO/non-R_10 scope %s",change=>{
  expect(assess({...signal,...change},history(),entry)).toBeNull();
 });
 it("builds completed M15 zones, records confirmation times and preserves all input",()=>{
  const h=history(), original=structuredClone(h);
  const a=assess(signal,h,entry)!;
  expect(a.historyCovered).toBe(true);expect(a.qualityFlags).toEqual([]);
  expect(a.confirmedLevels.length).toBeGreaterThan(0);
  expect(a.confirmedLevels.every(l=>l.confirmedAtMs===l.pivotCloseMs+3*15*M&&l.confirmedAtMs<=end)).toBe(true);
  expect(a.nearestSupport!.high).toBeLessThan(100);expect(a.nearestResistance!.low).toBeGreaterThan(100);
  expect(a.availableRoomR).toBeGreaterThan(2);expect(a.roomBucket).toBe("≥2R");
  expect(a.observationalOnly).toBe(true);expect(a).not.toHaveProperty("decision");
  expect(h).toEqual(original);expect(entry).toEqual({entryPrice:100,initialStopLoss:99});
  expect(assess(signal,[...h].reverse(),entry)).toEqual(a);
 });
 it("excludes future minutes and partial M15 highs, even if upstream marks them complete",()=>{
  const h=history(), base=assess(signal,h,entry)!;
  expect(assess(signal,[...h,extra(0,999,1)],entry)).toEqual(base);
  const partial=assess({...signal,decisionCloseTimeMs:end+M},[...h,extra(0,999,1)],entry)!;
  expect(partial.confirmedLevels).toEqual(base.confirmedLevels);
  expect(partial.lastCompletedM15CloseMs).toBe(end);
 });
 it.each(["gap","duplicate","incomplete","source","symbol","time","ohlc","stale"])("keeps %s history unknown without forward filling",kind=>{
  const h=history();
  if(kind==="gap")h.splice(10,1);
  if(kind==="duplicate")h.push({...h[0]!});
  if(kind==="incomplete")h[0]!.isComplete=false;
  if(kind==="source")h[0]!.source="HISTORY_API";
  if(kind==="symbol")h[0]!.symbol="XAUUSD";
  if(kind==="time")h[0]!.closeTime--;
  if(kind==="ohlc")h[0]!.high=99;
  if(kind==="stale")h.pop();
  const a=assess(signal,h,entry)!;
  expect(a.historyCovered).toBe(false);expect(a.roomBucket).toBe("MISSING_HISTORY");
  expect(a.availableRoomR).toBeNull();expect(a.signalBreaksConfirmedZone).toBeNull();expect(a.signalRetestsPriorBreak).toBeNull();
 });
 it.each([NaN,Infinity,-1,end+1])("rejects invalid decision time %s",cutoff=>{
  expect(assess({...signal,decisionCloseTimeMs:cutoff},history(),entry)!.qualityFlags).toContain("INVALID_DECISION_TIME");
 });
 it.each([{entryPrice:null,initialStopLoss:99},{entryPrice:NaN,initialStopLoss:99},{entryPrice:100,initialStopLoss:null},
  {entryPrice:100,initialStopLoss:100},{entryPrice:100,initialStopLoss:101}])("does not invent room from invalid BUY entry/stop %s",e=>{
  const a=assess(signal,history(),e)!;expect(a.roomBucket).toBe("INVALID_ENTRY_OR_INITIAL_STOP");expect(a.availableRoomR).toBeNull();
 });
 it("uses adverse support for SELL and the original directional stop",()=>{
  const a=assess({...signal,action:"SELL"},history(),{entryPrice:100,initialStopLoss:101})!;
  expect(a.adverseZoneDistance).toBe(100-a.nearestSupport!.high);
  expect(a.initialStopDistance).toBe(1);
  expect(assess({...signal,action:"SELL"},history(),entry)!.roomBucket).toBe("INVALID_ENTRY_OR_INITIAL_STOP");
 });
 it("separates no adverse level from being inside a zone and from limited room",()=>{
  const base=assess(signal,history(),entry)!, zone=base.nearestResistance!;
  expect(assess(signal,history(),{entryPrice:200,initialStopLoss:199})!.roomBucket).toBe("NO_ADVERSE_LEVEL");
  expect(assess(signal,history(),{entryPrice:zone.price,initialStopLoss:zone.price-1})!.roomBucket).toBe("INSIDE_ZONE");
  expect(assess(signal,history(),{entryPrice:zone.low-.5,initialStopLoss:zone.low-1.5})!.roomBucket).toBe("<1R");
  expect(assess(signal,history(),{entryPrice:zone.low-1.5,initialStopLoss:zone.low-2.5})!.roomBucket).toBe("1–<2R");
 });
 it("requires a crossing after confirmation and an earlier break for the current retest",()=>{
  const h=history(); const breakBar=extra(0,107,100);
  const b=assess({...signal,decisionCloseTimeMs:end+M},[...h,breakBar],entry)!;
  expect(b.signalBreaksConfirmedZone).toBe(true);expect(b.signalRetestsPriorBreak).toBe(false);
  const r=assess({...signal,decisionCloseTimeMs:end+2*M},[...h,breakBar,extra(1,107,105)],entry)!;
  expect(r.signalBreaksConfirmedZone).toBe(false);expect(r.signalRetestsPriorBreak).toBe(true);
  const s=assess({...signal,action:"SELL",decisionCloseTimeMs:end+M},[...h,extra(0,93,92)],{entryPrice:100,initialStopLoss:101})!;
  expect(s.signalBreaksConfirmedZone).toBe(true);
 });
 it("freezes zone widths at confirmation despite later volatility",()=>{
  const h=history(); const baseline=assess(signal,h,entry)!;
  for(let i=47*15;i<h.length;i++){ h[i]!.high=500; h[i]!.low=1; }
  const altered=assess(signal,h,entry)!;
  for(const level of baseline.confirmedLevels){
   expect(altered.confirmedLevels.find(l=>l.kind===level.kind&&l.pivotCloseMs===level.pivotCloseMs)).toEqual(level);
  }
 });
 it("withholds an unconfirmed high even when a later minute crosses it",()=>{
  const h=history();
  for(let i=47*15;i<h.length;i++)h[i]!.high=200;
  const a=assess({...signal,decisionCloseTimeMs:end+M},[...h,extra(0,201,100)],entry)!;
  expect(a.historyCovered).toBe(true);
  expect(a.confirmedLevels.some(l=>l.price===200)).toBe(false);
 });
 it("reports fixed automatic cohorts, separating manual/unknown, open, missing PnL, version and REAL",()=>{
  const a=assess(signal,history(),entry)!;
  const trades=[trade,{...trade,id:"loss",realizedPnl:-1,strategyVersion:"2"},{...trade,id:"manual",closeReason:"MANUAL",realizedPnl:100},
   {...trade,id:"unknown",closeReason:"OTHER"},{...trade,id:"open",status:"OPEN"},{...trade,id:"missing",realizedPnl:null},
   {...trade,id:"real",metadata:{executionModel:"broker_real_mt5"}},{...trade,id:"unobserved"}];
  const observations=trades.filter(t=>t.id!=="unobserved").map(t=>({positionId:t.id,supportResistance:a}));
  const s=summarize(trades,observations);
  expect(s.automaticBaseline).toMatchObject({trades:3,missingPnl:1,netPnl:1,profitFactor:2});
  expect(s.excludedManualCloses).toBe(1);expect(s.excludedSafetyOrUnknownCloses).toBe(1);
  expect(s.byStrategyVersion).toHaveLength(2);expect(s.room[0]).toMatchObject({bucket:"≥2R",trades:3});
  expect(summarize([trade],[{positionId:trade.id,supportResistance:{...a,signalId:"different"}}]).room[0]!.bucket).toBe("UNOBSERVED");
  expect(summarize([trade],[{positionId:trade.id}]).room[0]!.bucket).toBe("UNOBSERVED");
  const unknown={...a,roomBucket:"MISSING_HISTORY",signalBreaksConfirmedZone:null,signalRetestsPriorBreak:null};
  expect(summarize([trade],[{positionId:trade.id,supportResistance:unknown}]).breakout[0]!.bucket).toBe("UNKNOWN");
  expect(summarize([],[]).automaticBaseline).toMatchObject({trades:0,netPnl:null,profitFactor:null});
 });
});
