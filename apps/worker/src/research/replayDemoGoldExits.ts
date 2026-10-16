import { goldProtectedStop } from "../cfd/goldProfitLock.js";
export interface GoldReplayTrade {
  id: string; direction: "BUY" | "SELL"; entry: number; initialStop: number; takeProfit: number;
  openedAtMs: number; endMs: number; volume: number; tickSize: number; tickValue: number;
  point: number; stopsLevel: number; freezeLevel: number;
}
/** Sampled individual-entry counterfactual only. No broker, database, net-cost or portfolio model. */
export function replayDemoGoldExits(t: GoldReplayTrade, quotes: readonly { bid: number; ask: number; timestamp: number }[]) {
  const sign = t.direction === "BUY" ? 1 : -1;
  if (![t.entry,t.initialStop,t.takeProfit,t.volume,t.tickSize,t.tickValue,t.point].every(v=>Number.isFinite(v)&&v>0) ||
    ![t.openedAtMs,t.endMs,t.stopsLevel,t.freezeLevel].every(Number.isFinite) || t.endMs<t.openedAtMs ||
    !["BUY","SELL"].includes(t.direction) || sign*(t.entry-t.initialStop)<=0 || sign*(t.takeProfit-t.entry)<=0) {
    throw Error("INVALID_REPLAY_TRADE");
  }
  const rows=quotes.filter(q=>q.timestamp>=t.openedAtMs&&q.timestamp<=t.endMs&&
    [q.bid,q.ask,q.timestamp].every(Number.isFinite)&&q.bid>0&&q.ask>=q.bid).sort((a,b)=>a.timestamp-b.timestamp);
  const fixed={stop:t.initialStop,grossPnl:null as number|null,exitAtMs:null as number|null,reason:null as string|null};
  const riskBased={...fixed};let last:number|null=null,samples=0,gaps=0;
  for(const q of rows){
    if(last!=null&&q.timestamp<=last)continue;
    if(last!=null&&q.timestamp-last>120000)gaps++;
    if(fixed.exitAtMs!==null&&riskBased.exitAtMs!==null)break;
    last=q.timestamp;samples++;
    const market=sign===1?q.bid:q.ask;
    const gross=sign*(market-t.entry)/t.tickSize*t.tickValue*t.volume;
    for(const [mode,state]of [["FIXED_USD",fixed],["RISK_BASED_V1",riskBased]]as const){
      if(state.exitAtMs!==null)continue;
      const stop=sign*(market-state.stop)<=0,target=sign*(market-t.takeProfit)>=0;
      if(stop||target||(mode==="FIXED_USD"&&gross>=10)){
        state.grossPnl=gross;state.exitAtMs=q.timestamp;state.reason=stop?"SAMPLED_STOP":target?"SAMPLED_NATIVE_TP":"SAMPLED_10_USD";
      }else if(mode==="RISK_BASED_V1"){
        const next=goldProtectedStop({direction:t.direction,entry:t.entry,initialStop:t.initialStop,currentStop:state.stop,
          market,tickSize:t.tickSize,point:t.point,stopsLevel:t.stopsLevel,freezeLevel:t.freezeLevel,riskBased:true});
        if(next)state.stop=next.stop;
      }
    }
  }
  return {positionId:t.id,samples,gapsOverTwoMinutes:gaps,fixed,riskBased,estimatedNetPnl:null,
    limitations:["Minute samples miss intraminute paths and broker modification/close latency.",
      "Entry-time instrument specifications are held fixed; fees/swaps are not modeled.",
      "Individual original entries continue after actual close; capacity, later entries and new entry guards are not replayed."]};
}
