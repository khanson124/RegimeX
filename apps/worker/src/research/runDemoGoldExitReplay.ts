import { readFile, writeFile } from "node:fs/promises";
import { replayDemoGoldExits } from "./replayDemoGoldExits.js";
const [positionsFile,quotesFile,outputFile]=process.argv.slice(2);
if(!positionsFile||!quotesFile||!outputFile)throw Error("USAGE: positions.json quotes.json output.json");
const snapshot=JSON.parse(await readFile(positionsFile,"utf8"));
const quotes=JSON.parse(await readFile(quotesFile,"utf8")).map((q:{bid:number;ask:number;brokerQuoteTimestampMs:number})=>({
 bid:q.bid,ask:q.ask,timestamp:q.brokerQuoteTimestampMs}));
const first=quotes[0]?.timestamp;if(!Number.isFinite(first))throw Error("NO_QUOTE_HISTORY");
const results=[];
for(const p of snapshot.rows){
 if(p.symbol!=="XAUUSD"||p.metadata?.executionModel!=="broker_demo_mt5"||p.origin!=="ENGINE"||!p.openedAt)continue;
 const open=Date.parse(p.openedAt);
 // Report only trades attached near their entry, rather than pretending late samples cover the trade.
 if(open<first-120000)continue;
 const spec=p.metadata.volumePreflight,telemetry=p.metadata.executionTelemetry;
 results.push({actualStoredPnl:p.realizedPnl,...replayDemoGoldExits({id:p.id,direction:p.direction,entry:Number(p.entryPrice),
  initialStop:Number(p.initialStopLoss),takeProfit:Number(p.initialTakeProfit),openedAtMs:open,
  endMs:Math.min(Date.parse(snapshot.asOfUTC),open+48*3600000),volume:Number(p.volume),tickSize:telemetry.tickSize,
  tickValue:telemetry.tickValue,point:spec.point,stopsLevel:spec.stopsLevel,freezeLevel:spec.freezeLevel},quotes)});
}
const result={model:"GOLD_FIXED_10_VS_RISK_BASED_V1_SAMPLED",asOfUTC:snapshot.asOfUTC,observationalOnly:true,
 policyFrozenBeforeReplay:true,results};
await writeFile(outputFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
