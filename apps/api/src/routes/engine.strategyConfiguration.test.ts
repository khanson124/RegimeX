import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {registerEngineRoutes} from './engine.js';
import {registerErrorHandler} from '../plugins/errorHandler.js';
import type {AppContext} from '../context.js';
const apps:ReturnType<typeof Fastify>[]=[];
function fixture(prior:object[]=[]){
 const prisma={symbol:{findUnique:vi.fn().mockResolvedValue({enabled:true})},
  liveEngine:{findUnique:vi.fn().mockResolvedValue({id:'engine'}),upsert:vi.fn().mockResolvedValue({id:'engine'})},
  liveEngineConfiguration:{findMany:vi.fn().mockResolvedValue(prior),updateMany:vi.fn().mockResolvedValue({count:1}),create:vi.fn(async({data})=>data)},
  strategyDefinition:{findMany:vi.fn().mockResolvedValue([{kind:'xau-trend-pullback'},{kind:'ema-pullback'}])}};
 const redis={publish:vi.fn().mockResolvedValue(0)};
 const app=Fastify();apps.push(app);registerErrorHandler(app);
 registerEngineRoutes(app,{prisma,redis,config:{DEMO_TRADING_ENABLED:true,ENGINE_VERSION:'test'},tokens:{verifyAccessToken:()=>({sub:'u'})}} as unknown as AppContext);
 const request=(body:object)=>app.inject({method:'PUT',url:'/engine/configuration',headers:{authorization:'Bearer test'},payload:{symbol:'R_10',interval:'1m',mode:'DEMO_TRADING',...body}});
 return {prisma,redis,request};
}
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
describe('fixed-strategy configuration validation',()=>{
 it.each([
  {selectionMode:'SINGLE',fixedStrategyId:'xau-trend-pullback-v1'},
  {selectionMode:'SINGLE',fixedStrategyId:'ema-pullback-v1',symbol:'XAUUSD',interval:'15m'},
  {selectionMode:'SINGLE',fixedStrategyId:'xau-trend-pullback-v1',symbol:'XAUUSD',interval:'1m'},
  {selectionMode:'SINGLE',fixedStrategyId:null},
  {selectionMode:'SINGLE'},
  {selectionMode:'SINGLE',fixedStrategyId:'database-definition-id'},
  {selectionMode:'SINGLE',fixedStrategyId:'missing-strategy'}
 ])('rejects invalid fixed selection without writes/control: %j',async body=>{
  const f=fixture();expect((await f.request(body)).statusCode).toBe(400);
  expect(f.prisma.liveEngine.upsert).not.toHaveBeenCalled();expect(f.prisma.liveEngineConfiguration.updateMany).not.toHaveBeenCalled();
  expect(f.prisma.liveEngineConfiguration.create).not.toHaveBeenCalled();expect(f.redis.publish).not.toHaveBeenCalled();
 });
 it.each([{symbol:'R_10',interval:'1m',fixedStrategyId:'ema-pullback-v1'},
  {symbol:'XAUUSD',interval:'15m',fixedStrategyId:'xau-trend-pullback-v1'}])('accepts valid same-session selection: %j',async body=>{
  const f=fixture();const r=await f.request({selectionMode:'SINGLE',...body});expect(r.statusCode).toBe(200);expect(r.json().configuration.fixedStrategyId).toBe(body.fixedStrategyId);
  expect(f.prisma.strategyDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({enabled:true,deletedAt:null,OR:[{userId:null},{userId:'u'}]})}));
 });
 it('preserves same-symbol advanced values when omitted',async()=>{
  const f=fixture([{id:'r',symbol:'R_10',isActive:true,selectionMode:'SINGLE',fixedStrategyId:'ema-pullback-v1',riskProfileId:'risk-r',resumeTradingAfterRestart:true}]);
  const r=await f.request({});expect(r.statusCode).toBe(200);expect(r.json().configuration).toMatchObject({selectionMode:'SINGLE',fixedStrategyId:'ema-pullback-v1',riskProfileId:'risk-r',resumeTradingAfterRestart:true});
 });
 it('validates inherited selection before deactivating existing configurations',async()=>{
  const f=fixture([{id:'r',symbol:'R_10',isActive:true,selectionMode:'SINGLE',fixedStrategyId:'xau-trend-pullback-v1'}]);
  expect((await f.request({})).statusCode).toBe(400);expect(f.prisma.liveEngineConfiguration.updateMany).not.toHaveBeenCalled();expect(f.redis.publish).not.toHaveBeenCalled();
 });
 it.each(['AUTO','ENSEMBLE'])('clears stale fixed IDs for %s',async selectionMode=>{
  const f=fixture();const r=await f.request({selectionMode,fixedStrategyId:'xau-trend-pullback-v1'});
  expect(r.statusCode).toBe(200);expect(r.json().configuration.fixedStrategyId).toBeNull();
 });
 it('does not inherit Gold settings into a new R_10 track',async()=>{
  const f=fixture([{id:'gold',symbol:'XAUUSD',isActive:true,selectionMode:'SINGLE',fixedStrategyId:'xau-trend-pullback-v1',riskProfileId:'gold-risk'}]);
  const r=await f.request({});expect(r.statusCode).toBe(200);expect(r.json().configuration).toMatchObject({selectionMode:'AUTO',fixedStrategyId:null,riskProfileId:null});
  expect(f.prisma.liveEngineConfiguration.updateMany).not.toHaveBeenCalled();
 });
});
