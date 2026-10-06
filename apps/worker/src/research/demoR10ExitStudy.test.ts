import {describe,it,expect,vi} from 'vitest';
import {initialExitObservation,observeExitQuote,eligibleExitTrade,exitStudyResult,type ExitTrade} from './demoR10ExitStudy.js';
import {readOnlyTransport,demoResearchBroker} from './demoReadOnlyBroker.js';
import {auditGoldClose} from './demoGoldExecutionAudit.js';
const t:ExitTrade={id:'p',symbol:'R_10',interval:'1m',origin:'ENGINE',executionModel:'broker_demo_mt5',direction:'BUY',entry:100,initialStop:90,target:120,volume:1};
const spec={point:.01,tickSize:.01,tickValue:.01,stopsLevel:0,freezeLevel:0};
const q=(bid:number,timestamp=1000)=>({bid,ask:bid+1,timestamp});
describe('isolated exit study',()=>{
 it.each([{executionModel:'broker_real_mt5'},{symbol:'XAUUSD'},{interval:'15m'},{origin:'MANUAL'},{direction:'HOLD'},{entry:NaN},{initialStop:101},{target:99},{volume:0}])('excludes unsafe trade %s',v=>expect(eligibleExitTrade({...t,...v})).toBe(false));
 it('compares earlier BE with the fixed baseline using bid, with no input mutation',()=>{
  const original=initialExitObservation(t);const s=observeExitQuote(t,original,q(105),spec,1000,5);
  expect(s.earlier.stop).toBe(100);expect(s.baseline.stop).toBe(90);expect(original.samples).toBe(0);
  const closed=observeExitQuote(t,s,q(99,2000),spec,2000,-1);
  expect(closed.earlier.exitPrice).toBe(99);expect(closed.baseline.exitPrice).toBeNull();
  const result=exitStudyResult(t,closed,spec,.2,-1,false);
  expect(result.earlierProtection.estimatedNetPnl).toBeCloseTo(-1.2);expect(result.baselineProxy.censoredAtActualClose).toBe(true);
 });
 it('uses ask for SELL and locks mirrored stops',()=>{
  const sell={...t,direction:'SELL',initialStop:110,target:80};
  const s=observeExitQuote(sell,initialExitObservation(sell),q(94),spec,1000,5);
  expect(s.peakPriceR).toBe(.5);expect(s.earlier.stop).toBe(100);expect(s.baseline.stop).toBe(110);
 });
 it('keeps higher milestones identical and exits before changing a stop',()=>{
  const s=observeExitQuote(t,initialExitObservation(t),q(115),spec,1000,15);
  expect(s.baseline.stop).toBe(105);expect(s.earlier.stop).toBe(105);
  const closed=observeExitQuote(t,s,q(104,2000),spec,2000,4);
  expect(closed.baseline.exitReason).toBe('SAMPLED_STOP');expect(closed.baseline.stop).toBe(105);
 });
 it('models TP conservatively at target and freezes completed model paths',()=>{
  const s=observeExitQuote(t,initialExitObservation(t),q(121),spec,1000,21);
  expect(s.baseline.exitPrice).toBe(120);
  expect(observeExitQuote(t,s,q(80,2000),spec,2000,-20).baseline.exitPrice).toBe(120);
 });
 it.each([{stopsLevel:1000},{freezeLevel:1000},{stopsLevel:null},{tickSize:0}])('honors broker stop/freeze/missing specifications %s',v=>{
  const s=observeExitQuote(t,initialExitObservation(t),q(105),{...spec,...v},1000,5);
  expect(s.earlier.stop).toBe(90);expect(s.earlier.blockedModifications).toBe(1);
 });
 it('does not count repeated/out-of-order quotes and flags gaps',()=>{
  const s=observeExitQuote(t,initialExitObservation(t),q(105),spec,1000,5);
  expect(observeExitQuote(t,s,q(106),spec,1000,6)).toEqual(s);
  expect(observeExitQuote(t,s,q(106,20000),spec,20000,6).incomplete).toBe(true);
 });
 it.each([{bid:NaN,ask:106,timestamp:1000},{bid:105,ask:104,timestamp:1000},{bid:105,ask:106,timestamp:99999},{bid:105,ask:106,timestamp:1}])('flags bad/stale/future quotes %s',quote=>{
  const s=observeExitQuote(t,initialExitObservation(t),quote,spec,10000,null);expect(s.incomplete).toBe(true);expect(s.samples).toBe(0);
 });
 it('never invents net returns without costs or coverage, and preserves manual provenance',()=>{
  const s=observeExitQuote(t,initialExitObservation(t),q(89),spec,1000,null);
  expect(exitStudyResult(t,s,spec,null,-11,true).earlierProtection.estimatedNetPnl).toBeNull();
  const result=exitStudyResult(t,{...s,incomplete:true},spec,0,-11,true);
  expect(result.earlierProtection.estimatedNetPnl).toBeNull();expect(result.manualClose).toBe(true);expect(result.peakSampledBrokerFloatingPnl).toBeNull();
 });
 it.each(['openMarket','modifyPosition','closePosition','getBars','getSymbols'] as const)('transport forbids %s before touching bridge',cmd=>{
  const request=vi.fn();const ro=readOnlyTransport({request,close:vi.fn()});
  expect(()=>ro.request(cmd,{}, {requestId:'r',idempotencyKey:'i'})).toThrow('RESEARCH_MUTATION_FORBIDDEN');expect(request).not.toHaveBeenCalled();
 });
 it('allows only named read commands and closes the diagnostic transport',async()=>{
  const request=vi.fn().mockResolvedValue({ok:true}),close=vi.fn();const ro=readOnlyTransport({request,close});
  await ro.request('getHistory',{}, {requestId:'r',idempotencyKey:'i'});ro.close();expect(request).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 });
 it.each([{EXECUTION_MODE:'broker_real_mt5',MT5_DEMO_BRIDGE_URL:'http://demo'}, {EXECUTION_MODE:'broker_demo_mt5'},
  {EXECUTION_MODE:'broker_demo_mt5',MT5_DEMO_BRIDGE_URL:'http://live'}, {EXECUTION_MODE:'broker_demo_mt5',MT5_DEMO_BRIDGE_URL:'http://same',MT5_LIVE_BRIDGE_URL:'http://same'}])('rejects unsafe bridge config before network %s',async env=>{
  await expect(demoResearchBroker(env)).rejects.toThrow('EXPLICIT_DEMO_BRIDGE_REQUIRED');
 });
 it('Gold audit distinguishes matching evidence, missing history and unknown stop acknowledgement',()=>{
  const stored={direction:'SELL',entryPrice:100,initialStopLoss:110,closePrice:120,realizedPnl:-20};
  const broker={found:true,pendingHistory:false,entryPrice:100,exitPrice:120,realizedPnl:-20,closeReason:'STOP_LOSS',brokerReason:'SL',commission:0,swap:0,fee:0};
  expect(auditGoldClose(stored,broker)).toMatchObject({storedPnlMatchesBroker:true,storedExitMatchesBroker:true,distanceBeyondRecordedStop:10,conclusion:'VERIFY_STOP_ACK_AND_TICK_PATH'});
  expect(auditGoldClose(stored,{...broker,found:false})).toMatchObject({storedPnlMatchesBroker:null,conclusion:'INDETERMINATE_HISTORY'});
  expect(auditGoldClose(stored,{...broker,realizedPnl:-10})).toMatchObject({storedPnlMatchesBroker:false});
 });
});
