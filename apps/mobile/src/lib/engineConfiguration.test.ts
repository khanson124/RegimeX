import {describe,expect,it} from 'vitest';
import {configurationForSymbol,engineStrategyChoices} from './engineConfiguration.js';
describe('engine form symbol scope',()=>{
 const gold={symbol:'XAUUSD',interval:'15m',selectionMode:'SINGLE',fixedStrategyId:'xau-trend-pullback-v1',riskProfileId:'gold-risk'};
 const r10={symbol:'R_10',interval:'1m',selectionMode:'AUTO',fixedStrategyId:null as string | null,riskProfileId:'r-risk'};
 it('switches to the selected symbol settings instead of the legacy Gold configuration',()=>{
  expect(configurationForSymbol([gold,r10],gold,'R_10')).toBe(r10);
  expect(configurationForSymbol([gold,r10],gold,'XAUUSD')).toBe(gold);
 });
 it('does not copy settings for an unconfigured symbol',()=>expect(configurationForSymbol([gold],gold,'R_10')).toBeUndefined());
 it('supports legacy same-symbol responses',()=>expect(configurationForSymbol([],r10,'R_10')).toBe(r10));
 it('selects the latest matching configuration',()=>expect(configurationForSymbol([r10,{...r10,selectionMode:'SINGLE'}],gold,'R_10')?.selectionMode).toBe('SINGLE'));
 it('offers enabled compatible engine IDs while preserving database IDs',()=>{
  const choices=[{id:'db-gold',strategyId:'xau-trend-pullback-v1',enabled:true,eligibility:{allowedSymbols:['XAUUSD'],allowedIntervals:['15m']}},
   {id:'db-r10',strategyId:'ema-pullback-v1',enabled:true,eligibility:{allowedSymbols:['R_10'],allowedIntervals:['1m','5m']}},
   {id:'db-disabled',strategyId:'disabled',enabled:false}, {id:'old-api-id',enabled:true}];
  expect(engineStrategyChoices(choices,'R_10','1m').map(s=>s.strategyId)).toEqual(['ema-pullback-v1']);
  expect(engineStrategyChoices(choices,'XAUUSD','15m').map(s=>s.id)).toEqual(['db-gold']);
  expect(engineStrategyChoices(choices,'R_10','15m')).toEqual([]);
 });
});
