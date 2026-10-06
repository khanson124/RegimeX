import {mkdir,readFile,appendFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {PrismaClient} from '@regimex/database';
import {demoResearchBroker} from './demoReadOnlyBroker.js';
import {EXIT_STUDY_MODEL,eligibleExitTrade,initialExitObservation,observeExitQuote,exitStudyResult,type ExitTrade,type ExitObservation,type ExitSpec} from './demoR10ExitStudy.js';
if(process.env.R10_EXIT_STUDY_ENABLED!=='true')throw Error('EXPLICIT_RESEARCH_ENABLE_REQUIRED');
const dir=process.env.R10_EXIT_STUDY_DIR,from=new Date(process.env.R10_EXIT_STUDY_FROM??'');
if(!dir||!Number.isFinite(from.getTime())||!/^([0-9a-f]{40})$/.test(process.env.R10_EXIT_STUDY_COMMIT??''))throw Error('FIXED_DIRECTORY_AND_START_REQUIRED');
const cost=!process.env.R10_EXIT_STUDY_COST_PER_LOT?.trim()?null:Number(process.env.R10_EXIT_STUDY_COST_PER_LOT);
if(cost!==null&&(!Number.isFinite(cost)||cost<0))throw Error('INVALID_COST_ASSUMPTION');
const manifest={model:EXIT_STUDY_MODEL,from:from.toISOString(),sourceCommit:process.env.R10_EXIT_STUDY_COMMIT??'unknown',costPerLot:cost,pollMs:5000,maxPositions:200,observationalOnly:true};
await mkdir(dir,{recursive:true});
try{if(JSON.stringify(JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')))!==JSON.stringify(manifest))throw Error('MANIFEST_MISMATCH');}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest),{flag:'wx'});}
interface Sample {trade:ExitTrade;state:ExitObservation;spec:ExitSpec;quote?:{bid:number;ask:number;timestamp:number};brokerSnapshot?:{readAt:string;floatingPnl:number;stopLoss:number;takeProfit:number|null}}
const samples=new Map<string,Sample>(),done=new Set<string>(),lockIds=new Set<string>();
try{for(const line of (await readFile(join(dir,'samples.jsonl'),'utf8')).split('\n').filter(Boolean)){const v=JSON.parse(line);samples.set(v.trade.id,v);}}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
try{for(const line of (await readFile(join(dir,'results.jsonl'),'utf8')).split('\n').filter(Boolean))done.add(JSON.parse(line).positionId);}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
try{for(const line of (await readFile(join(dir,'profit-lock-events.jsonl'),'utf8')).split('\n').filter(Boolean))lockIds.add(JSON.parse(line).id);}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const db=new PrismaClient(),broker=await demoResearchBroker(process.env);let stop=false;let wake:(()=>void)|undefined;
for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>{stop=true;wake?.();});
try{while(!stop){try{
 const rows=await db.$transaction(async tx=>{await tx.$executeRaw`SET TRANSACTION READ ONLY`;await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
 const rows=await tx.position.findMany({where:{symbol:'R_10',interval:'1m',origin:'ENGINE',status:{in:['OPEN','CLOSED']},createdAt:{gte:from},metadata:{path:['executionModel'],equals:'broker_demo_mt5'}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:200,
 select:{id:true,status:true,direction:true,entryPrice:true,initialStopLoss:true,initialTakeProfit:true,volume:true,brokerPositionId:true,realizedPnl:true,closeReason:true,openedAt:true}});
 const locks=await tx.positionEvent.findMany({where:{positionId:{in:rows.map(r=>r.id)},eventType:'PROFIT_LOCK_UPDATED'},orderBy:{createdAt:'desc'},take:100,select:{id:true,positionId:true,createdAt:true,payload:true}});
 return {rows,locks};},{timeout:15000});
 for(const event of rows.locks){if(!lockIds.has(event.id)){await appendFile(join(dir,'profit-lock-events.jsonl'),JSON.stringify(event)+'\n');lockIds.add(event.id);}}
 const positions=rows.rows;
 // Account identity is revalidated every cycle before any market/history read.
 await broker.connect();
 const opens=await broker.getOpenPositions();const brokerReadAt=new Date().toISOString();
 const live=await broker.getLiveSymbol('Volatility 10 Index');
 const quote=await broker.getQuote('Volatility 10 Index');
 const spec:ExitSpec={point:live?.point??NaN,tickSize:live?.tickSize??NaN,tickValue:live?.tickValue??NaN,stopsLevel:live?.stopsLevel??null,freezeLevel:live?.freezeLevel??null};
 for(const row of positions){
  if(done.has(row.id))continue;
  let sample=samples.get(row.id);
  if(row.status==='CLOSED'){
   if(sample){await appendFile(join(dir,'results.jsonl'),JSON.stringify(exitStudyResult(sample.trade,sample.state,sample.spec,cost,row.realizedPnl==null?null:Number(row.realizedPnl),row.closeReason==='MANUAL'))+'\n');done.add(row.id);}
   continue;
  }
  const remote=opens.find(p=>p.brokerPositionId===row.brokerPositionId&&p.symbol==='Volatility 10 Index'&&p.direction===row.direction);
  if(!remote||!quote)continue;
  const trade:ExitTrade={id:row.id,symbol:'R_10',interval:'1m',origin:'ENGINE',executionModel:'broker_demo_mt5',direction:row.direction,entry:row.entryPrice==null?NaN:Number(row.entryPrice),initialStop:Number(row.initialStopLoss),target:row.initialTakeProfit==null?null:Number(row.initialTakeProfit),volume:Number(row.volume)};
  if(!eligibleExitTrade(trade))continue;
  if(sample&&JSON.stringify(sample.trade)!==JSON.stringify(trade))throw Error('FROZEN_TRADE_CHANGED');
  sample??={trade,state:initialExitObservation(trade),spec};
  // Late attachment cannot establish a whole-trade counterfactual.
  if(!samples.has(row.id)&&(!row.openedAt||Date.now()-row.openedAt.getTime()>10000))sample.state.incomplete=true;
  if(JSON.stringify(sample.spec)!==JSON.stringify(spec)||Math.abs(remote.entryPrice-trade.entry)>spec.tickSize||Math.abs(remote.volume-trade.volume)>1e-8)sample.state.incomplete=true;
  sample.quote={bid:quote.bid,ask:quote.ask,timestamp:quote.timestamp};
  sample.brokerSnapshot={readAt:brokerReadAt,floatingPnl:remote.floatingPnl,stopLoss:remote.stopLoss,takeProfit:remote.takeProfit};
  sample.state=observeExitQuote(trade,sample.state,quote,spec,Date.now(),remote.floatingPnl);
  await appendFile(join(dir,'samples.jsonl'),JSON.stringify(sample)+'\n');samples.set(row.id,sample);
 }
 const summary={...manifest,updatedAt:new Date().toISOString(),observed:samples.size,closed:done.size,open:positions.filter(r=>r.status==='OPEN').length,recordedProfitLockUpdates:lockIds.size};
 await writeFile(join(dir,'summary.tmp'),JSON.stringify(summary));await rename(join(dir,'summary.tmp'),join(dir,'summary.json'));
 console.log(JSON.stringify({event:'R10_EXIT_STUDY_HEARTBEAT',...summary}));
 }catch{console.error(JSON.stringify({event:'R10_EXIT_STUDY_RETRY',reason:'READ_OR_ARTIFACT_FAILURE'}));if(process.argv.includes('--once'))process.exitCode=1;}
 if(process.argv.includes('--once'))break;
 await new Promise<void>(resolve=>{const t=setTimeout(resolve,5000);wake=()=>{clearTimeout(t);resolve();};});
}}finally{await db.$disconnect();await broker.disconnect();}
