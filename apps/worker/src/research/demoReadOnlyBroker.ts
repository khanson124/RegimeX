import { DerivMT5BrokerAdapter } from "@regimex/trading-engine";
// Direct imports deliberately limit the transport exposed to the research adapter.
import { HttpMt5BridgeClient } from "../../../../packages/trading-engine/src/broker/mt5/bridgeClient.js";
import type { Mt5BridgeTransport } from "../../../../packages/trading-engine/src/broker/mt5/types.js";
export function readOnlyTransport(transport:Mt5BridgeTransport):Mt5BridgeTransport {
 return {close:()=>transport.close(),request(command,payload,opts){
  if(!['ping','getAccount','getInstrument','getQuote','getOpenPositions','getHistory'].includes(command))throw Error('RESEARCH_MUTATION_FORBIDDEN');
  return transport.request(command,payload,opts);
 }};
}
export async function demoResearchBroker(env:NodeJS.ProcessEnv){
 const url=env.MT5_DEMO_BRIDGE_URL;
 if(env.EXECUTION_MODE!=='broker_demo_mt5'||!url||url===env.MT5_LIVE_BRIDGE_URL||url.includes('live'))throw Error('EXPLICIT_DEMO_BRIDGE_REQUIRED');
 const transport=readOnlyTransport(new HttpMt5BridgeClient({baseUrl:url,secret:env.MT5_DEMO_BRIDGE_SECRET??env.MT5_BRIDGE_SECRET??'',timeoutMs:8000}));
 const broker=new DerivMT5BrokerAdapter({requireDemoAccount:true,executionEnvironment:'demo',bridgeUrl:url,bridgeSecret:'',
  timeoutMs:8000,maxQuoteAgeMs:5000,maxTestVolume:0,maxTestRiskPercent:0,magic:Number(env.MT5_MAGIC_NUMBER??26082301),expectedBroker:env.MT5_EXPECTED_BROKER??"Deriv",expectedServer:env.MT5_EXPECTED_SERVER,expectedLogin:env.MT5_EXPECTED_LOGIN,transport});
 await broker.connect();return broker;
}
