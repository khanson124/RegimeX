import {writeFile} from 'node:fs/promises';
import {PrismaClient} from '@regimex/database';
import {demoResearchBroker} from './demoReadOnlyBroker.js';
import {auditGoldClose} from './demoGoldExecutionAudit.js';
if(process.env.GOLD_DEMO_AUDIT_ENABLED!=='true'||!process.env.GOLD_DEMO_AUDIT_OUTPUT)throw Error('EXPLICIT_AUDIT_ENABLE_AND_OUTPUT_REQUIRED');
const db=new PrismaClient(),broker=await demoResearchBroker(process.env);
try{
 const rows=await db.$transaction(async tx=>{await tx.$executeRaw`SET TRANSACTION READ ONLY`;await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
  return tx.position.findMany({where:{symbol:'XAUUSD',origin:'ENGINE',status:'CLOSED',metadata:{path:['executionModel'],equals:'broker_demo_mt5'}},orderBy:{closedAt:'desc'},take:20,
   select:{id:true,brokerPositionId:true,direction:true,entryPrice:true,initialStopLoss:true,closePrice:true,realizedPnl:true,closedAt:true}});},{timeout:15000});
 const results=[];
 for(const r of rows){if(!r.brokerPositionId||!Number.isSafeInteger(Number(r.brokerPositionId)))continue;
  const evidence=await broker.reconstructClosedPosition(Number(r.brokerPositionId));
  results.push({positionId:r.id,closedAt:r.closedAt,brokerPositionId:r.brokerPositionId,stored:r,broker:evidence,
   audit:auditGoldClose({direction:r.direction,entryPrice:r.entryPrice==null?NaN:Number(r.entryPrice),initialStopLoss:Number(r.initialStopLoss),closePrice:r.closePrice==null?NaN:Number(r.closePrice),realizedPnl:r.realizedPnl==null?NaN:Number(r.realizedPnl)},evidence)});
 }
 await writeFile(process.env.GOLD_DEMO_AUDIT_OUTPUT,JSON.stringify({asOf:new Date(),demoVerified:broker.getStatus().isDemo,results},null,2),{flag:'wx'});
 console.log(JSON.stringify({event:'GOLD_DEMO_AUDIT_COMPLETE',positions:results.length}));
}finally{await db.$disconnect();await broker.disconnect();}
