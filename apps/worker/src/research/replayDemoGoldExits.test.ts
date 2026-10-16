import { expect,it } from "vitest";
import {replayDemoGoldExits}from"./replayDemoGoldExits.js";
const t={id:"test",direction:"BUY"as const,entry:100,initialStop:90,takeProfit:120,openedAtMs:1000,endMs:100000,
 volume:1,tickSize:1,tickValue:1,point:.01,stopsLevel:0,freezeLevel:0};
it("keeps an R-based runner beyond the fixed $10 exit and tightens only after observing each quote",()=>{
 const q=[105,110,116,120].map((bid,i)=>({bid,ask:bid+.1,timestamp:1000+i*1000}));
 const r=replayDemoGoldExits(t,q);expect(r.fixed.grossPnl).toBe(10);expect(r.riskBased.grossPnl).toBe(20);
 expect(r.riskBased.reason).toBe("SAMPLED_NATIVE_TP");expect(r.estimatedNetPnl).toBeNull();
});
it("records the cost of allowing a reversal instead of claiming the sampled peak",()=>{
 const r=replayDemoGoldExits(t,[{bid:105,ask:105.1,timestamp:1000},{bid:110,ask:110.1,timestamp:2000},{bid:104,ask:104.1,timestamp:3000}]);
 expect(r.fixed.grossPnl).toBe(10);expect(r.riskBased.grossPnl).toBe(4);
});
it("uses executable ask for SELL and ignores future samples",()=>{
 const r=replayDemoGoldExits({...t,direction:"SELL",initialStop:110,takeProfit:80},
  [{bid:79,ask:81,timestamp:1000},{bid:70,ask:71,timestamp:200000}]);
 expect(r.fixed.grossPnl).toBe(19);expect(r.riskBased.grossPnl).toBeNull();
});
