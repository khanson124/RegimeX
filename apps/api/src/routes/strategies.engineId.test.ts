import Fastify from 'fastify';
import {expect,it} from 'vitest';
import {registerStrategyRoutes} from './strategies.js';
import type {AppContext} from '../context.js';
it('keeps definition ID for research and exposes runtime ID for engine selection',async()=>{
 const app=Fastify();
 registerStrategyRoutes(app,{prisma:{strategyDefinition:{findMany:async()=>[{id:'db-gold',kind:'xau-trend-pullback',name:'Gold',description:'',enabled:true,userId:null,updatedAt:new Date(),versions:[]}]}},tokens:{verifyAccessToken:()=>({sub:'u'})}} as unknown as AppContext);
 try{const r=await app.inject({method:'GET',url:'/strategies',headers:{authorization:'Bearer test'}});
  expect(r.statusCode).toBe(200);expect(r.json().strategies[0]).toMatchObject({id:'db-gold',strategyId:'xau-trend-pullback-v1',eligibility:{allowedSymbols:['XAUUSD'],allowedIntervals:['15m']}});
 }finally{await app.close();}
});
