import { expect, it } from "vitest";
import { demoGoldExitPolicy } from "./demoGoldExitPolicy.js";
const input={executionMode:"broker_demo_mt5",sessionMode:"DEMO_TRADING",symbol:"XAUUSD",interval:"15m",
 strategyId:"xau-trend-pullback-v1",configuredMode:"RISK_BASED"};
it("opts in only new scoped DEMO positions",()=>expect(demoGoldExitPolicy(input)).toEqual({demoGoldExitPolicy:"RISK_BASED_V1"}));
it.each([{executionMode:"broker_real_mt5"},{sessionMode:"LIVE_TRADING"},{symbol:"R_10"},{interval:"1m"},
 {strategyId:"another"},{configuredMode:"FIXED_USD"}])("preserves other scopes %j",patch=>{
 expect(demoGoldExitPolicy({...input,...patch})).toEqual({});
});
it("keeps legacy open/pending tickets legacy after enabling the new mode",()=>{
 expect(demoGoldExitPolicy({...input,existing:{metadata:{executionModel:"broker_demo_mt5"}}})).toEqual({});
});
it("preserves a tagged policy across config changes/restarts",()=>{
 expect(demoGoldExitPolicy({...input,configuredMode:"FIXED_USD",existing:{metadata:{demoGoldExitPolicy:"RISK_BASED_V1"}}}))
  .toEqual({demoGoldExitPolicy:"RISK_BASED_V1"});
});
