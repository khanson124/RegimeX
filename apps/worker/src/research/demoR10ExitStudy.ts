export const EXIT_STUDY_MODEL = "R10_SAMPLED_EXIT_V1_EARLY_BE_0_5R";
export interface ExitTrade {
  id:string; symbol:string; interval:string|null; origin:string; executionModel:string;
  direction:string; entry:number; initialStop:number; target:number|null; volume:number;
}
export interface ExitQuote { bid:number; ask:number; timestamp:number }
export interface ExitSpec { point:number; tickSize:number; tickValue:number; stopsLevel:number|null; freezeLevel:number|null }
export interface ExitModelState { stop:number; exitPrice:number|null; exitReason:string|null; blockedModifications:number }
export interface ExitObservation {
  positionId:string; lastQuoteMs:number|null; samples:number; incomplete:boolean;
  peakPriceR:number; peakBrokerFloatingPnl:number|null; baseline:ExitModelState; earlier:ExitModelState;
}
export function eligibleExitTrade(t:ExitTrade):boolean {
 return t.executionModel==='broker_demo_mt5'&&t.symbol==='R_10'&&t.interval==='1m'&&t.origin==='ENGINE'&&
  (t.direction==='BUY'||t.direction==='SELL')&&[t.entry,t.initialStop,t.volume].every(v=>Number.isFinite(v)&&v>0)&&
  (t.direction==='BUY'?t.initialStop<t.entry:t.initialStop>t.entry)&&
  (t.target===null||Number.isFinite(t.target)&&(t.direction==='BUY'?t.target>t.entry:t.target<t.entry));
}
export function initialExitObservation(t:ExitTrade):ExitObservation {
 return {positionId:t.id,lastQuoteMs:null,samples:0,incomplete:false,peakPriceR:0,peakBrokerFloatingPnl:null,
  baseline:{stop:t.initialStop,exitPrice:null,exitReason:null,blockedModifications:0},
  earlier:{stop:t.initialStop,exitPrice:null,exitReason:null,blockedModifications:0}};
}
/** Pure sampled comparison. Never sends modifications or consumes production state. */
export function observeExitQuote(t:ExitTrade,state:ExitObservation,q:ExitQuote,spec:ExitSpec,
 now:number,brokerFloatingPnl:number|null):ExitObservation {
 const s=structuredClone(state);
 if(!eligibleExitTrade(t)||state.positionId!==t.id)throw Error('EXIT_STUDY_SCOPE_MISMATCH');
 if(![q.bid,q.ask,q.timestamp,now].every(Number.isFinite)||q.bid<=0||q.ask<q.bid||now-q.timestamp<0||now-q.timestamp>5000){s.incomplete=true;return s;}
 if(s.lastQuoteMs!==null&&q.timestamp<=s.lastQuoteMs)return s;
 if(s.lastQuoteMs!==null&&q.timestamp-s.lastQuoteMs>10000)s.incomplete=true;
 s.lastQuoteMs=q.timestamp;s.samples++;
 const price=t.direction==='BUY'?q.bid:q.ask, risk=Math.abs(t.entry-t.initialStop);
 const favorable=(t.direction==='BUY'?price-t.entry:t.entry-price)/risk;
 s.peakPriceR=Math.max(s.peakPriceR,favorable);
 if(brokerFloatingPnl!=null&&Number.isFinite(brokerFloatingPnl))s.peakBrokerFloatingPnl=Math.max(s.peakBrokerFloatingPnl??-Infinity,brokerFloatingPnl);
 const validSpec=[spec.point,spec.tickSize,spec.tickValue].every(v=>Number.isFinite(v)&&v>0)&&
  spec.stopsLevel!=null&&Number.isFinite(spec.stopsLevel)&&spec.stopsLevel>=0&&
  spec.freezeLevel!=null&&Number.isFinite(spec.freezeLevel)&&spec.freezeLevel>=0;
 if(!validSpec)s.incomplete=true;
 for(const [key,model] of [['baseline',s.baseline],['earlier',s.earlier]] as const){
  if(model.exitPrice!==null)continue;
  if(t.direction==='BUY'?price<=model.stop:price>=model.stop){model.exitPrice=price;model.exitReason='SAMPLED_STOP';continue;}
  if(t.target!==null&&(t.direction==='BUY'?price>=t.target:price<=t.target)){model.exitPrice=t.target;model.exitReason='SAMPLED_TARGET';continue;}
  const protectedR=favorable>=1.75?1:favorable>=1.5?.5:favorable>=1?.2:favorable>=(key==='earlier'?.5:.75)?0:null;
  if(protectedR===null)continue;
  if(!validSpec){model.blockedModifications++;continue;}
  const proposed=t.entry+(t.direction==='BUY'?1:-1)*risk*protectedR;
  const rounded=(t.direction==='BUY'?Math.floor(proposed/spec.tickSize):Math.ceil(proposed/spec.tickSize))*spec.tickSize;
  if(t.direction==='BUY'?rounded<=model.stop:rounded>=model.stop)continue;
  const required=Math.max(spec.stopsLevel!,spec.freezeLevel!)*spec.point+spec.tickSize;
  const distance=t.direction==='BUY'?price-rounded:rounded-price;
  const oldDistance=t.direction==='BUY'?price-model.stop:model.stop-price;
  if(distance<required||oldDistance<=spec.freezeLevel!*spec.point){model.blockedModifications++;continue;}
  model.stop=rounded;
 }
 return s;
}
export function exitStudyResult(t:ExitTrade,s:ExitObservation,spec:ExitSpec,costPerLot:number|null,actualPnl:number|null,manual:boolean){
 function result(m:ExitModelState){
  const gross=m.exitPrice==null?null:(t.direction==='BUY'?m.exitPrice-t.entry:t.entry-m.exitPrice)/spec.tickSize*spec.tickValue*t.volume;
  const net=gross!=null&&Number.isFinite(gross)&&costPerLot!=null&&Number.isFinite(costPerLot)&&costPerLot>=0&&!s.incomplete?gross-costPerLot*t.volume:null;
  return {...m,estimatedGrossPnl:gross!=null&&Number.isFinite(gross)?gross:null,estimatedNetPnl:net,
   censoredAtActualClose:m.exitPrice===null};
 }
 return {model:EXIT_STUDY_MODEL,observationalOnly:true,positionId:t.id,samples:s.samples,incomplete:s.incomplete,
  peakSampledExecutablePriceR:s.peakPriceR,peakSampledBrokerFloatingPnl:s.peakBrokerFloatingPnl,
  actualStoredPnl:actualPnl,manualClose:manual,
  givebackFromSampledBrokerPeak:actualPnl!=null&&Number.isFinite(actualPnl)&&s.peakBrokerFloatingPnl!=null?s.peakBrokerFloatingPnl-actualPnl:null,
  baselineProxy:result(s.baseline),earlierProtection:result(s.earlier),costPerLot,
  limitations:['Sampled quotes miss intrapoll paths; gross broker floating PnL is not net close PnL.',
   'Broker modifications/latency and tick-value changes are not reproduced; no executable-profit guarantee.',
   'Missing cost estimate or incomplete observations means no modeled net result; manual closes are separate.',
   'Open model paths are censored at actual close; no portfolio capacity or subsequent entries replay.']};
}
