import { describe, expect, it } from "vitest";
import type { Candle } from "@regimex/shared";
import { assessDemoEntryRoom, demoEntryQualityApplies } from "./demoEntryQuality.js";
const end = Date.UTC(2026,9,15,23,30), step=900000;
function bars(): Candle[] { return Array.from({length:48},(_,i)=>{
  const close=100+5*Math.sin(i*Math.PI/4);
  return {symbol:"R_10",interval:"15m",openTime:end+(i-48)*step,closeTime:end+(i-47)*step,
    open:close,close,high:close+1,low:close-1,isComplete:true,tickCount:10,source:"MT5_HISTORY"};
}); }
const entry={symbol:"R_10",action:"BUY",entry:110,stop:105,decisionCloseMs:end};
describe("DEMO native M15 structure candidate",()=>{
 it.each([{executionMode:"broker_real_mt5"},{sessionMode:"LIVE_TRADING"},{enabled:false},
  {symbol:"R_25"},{interval:"5m"},{symbol:"XAUUSD",interval:"15m",strategyId:"another"}])("excludes scope %j",patch=>{
  expect(demoEntryQualityApplies({enabled:true,executionMode:"broker_demo_mt5",sessionMode:"DEMO_TRADING",
    symbol:"R_10",interval:"1m",strategyId:"breakout-momentum-v1",...patch})).toBe(false);
 });
 it("includes Gold's exact strategy and R_10 DEMO",()=>{
  for(const scope of [{symbol:"R_10",interval:"1m",strategyId:"breakout-momentum-v1"},
    {symbol:"XAUUSD",interval:"15m",strategyId:"xau-trend-pullback-v1"}])expect(demoEntryQualityApplies({
      enabled:true,executionMode:"broker_demo_mt5",sessionMode:"DEMO_TRADING",...scope})).toBe(true);
 });
 it("labels absence of an opposing zone as unknown room",()=>{
  expect(assessDemoEntryRoom(entry,bars())).toEqual({allowed:true,reason:"DEMO_STRUCTURE_NO_KNOWN_OPPOSING_ZONE",roomR:null});
 });
 it("blocks entries inside confirmed zones",()=>{
  expect(assessDemoEntryRoom({...entry,entry:106,stop:101},bars())).toMatchObject({allowed:false,reason:"DEMO_STRUCTURE_INSIDE_ZONE"});
 });
 it("blocks short room and permits room >=1R symmetrically",()=>{
  for(const action of ["BUY","SELL"]){
   const price=action==="BUY"?105:95, sign=action==="BUY"?1:-1;
   expect(assessDemoEntryRoom({...entry,action,entry:price,stop:price-sign*5},bars())).toMatchObject({allowed:false,reason:"DEMO_STRUCTURE_ROOM_BELOW_1R"});
   expect(assessDemoEntryRoom({...entry,action,entry:price,stop:price-sign*.1},bars())).toMatchObject({allowed:true,reason:"DEMO_STRUCTURE_ROOM_OK"});
  }
 });
 it.each(["missing","duplicate","invalid","forming","wrong-source","stale"])("fails closed on %s history",kind=>{
  const rows=bars();if(kind==="missing")rows.pop();if(kind==="duplicate")rows.push({...rows[0]!});
  if(kind==="invalid")rows[0]!.high=rows[0]!.low-1;if(kind==="forming")rows[0]!.isComplete=false;
  if(kind==="wrong-source")rows[0]!.source="HISTORY_API";if(kind==="stale")rows.forEach(c=>{c.openTime-=step;c.closeTime-=step;});
  expect(assessDemoEntryRoom(entry,rows)).toMatchObject({allowed:false,reason:"DEMO_STRUCTURE_HISTORY_UNAVAILABLE"});
 });
 it("never uses future/forming M15 levels or mutates history",()=>{
  const rows=bars(),before=structuredClone(rows);
  const result=assessDemoEntryRoom(entry,[...rows,{...rows.at(-1)!,openTime:end,closeTime:end+step,high:9999}]);
  expect(result).toEqual(assessDemoEntryRoom(entry,rows));expect(rows).toEqual(before);
 });
});

it("accepts native Gold bars across a scheduled closure without fabricating candles",()=>{
 const rows=bars().map((c,i)=>({...c,symbol:"XAUUSD",openTime:c.openTime-(i<24?3600000:0),closeTime:c.closeTime-(i<24?3600000:0)}));
 expect(assessDemoEntryRoom({...entry,symbol:"XAUUSD"},rows).allowed).toBe(true);
 expect(assessDemoEntryRoom({...entry,symbol:"R_10"},rows.map(c=>({...c,symbol:"R_10"})))).toMatchObject({allowed:false});
});
