export interface GoldStoredClose {entryPrice:number;initialStopLoss:number;closePrice:number;realizedPnl:number;direction:string}
export interface GoldBrokerClose {found:boolean;pendingHistory:boolean;entryPrice:number|null;exitPrice:number|null;realizedPnl:number|null;closeReason:string|null;brokerReason:string|null;commission:number|null;swap:number|null;fee:number|null}
export function auditGoldClose(stored:GoldStoredClose,broker:GoldBrokerClose){
 const valid=[stored.entryPrice,stored.initialStopLoss,stored.closePrice,stored.realizedPnl].every(Number.isFinite)&&(stored.direction==='BUY'||stored.direction==='SELL');
 const found=broker.found&&!broker.pendingHistory;
 const beyond=valid?(stored.direction==='BUY'?Math.max(0,stored.initialStopLoss-stored.closePrice):Math.max(0,stored.closePrice-stored.initialStopLoss)):null;
 return {observationalOnly:true,brokerHistoryAvailable:found,
  storedPnlMatchesBroker:found&&valid&&broker.realizedPnl!=null&&Number.isFinite(broker.realizedPnl)?Math.abs(stored.realizedPnl-broker.realizedPnl)<=.01:null,
  storedExitMatchesBroker:found&&valid&&broker.exitPrice!=null&&Number.isFinite(broker.exitPrice)?Math.abs(stored.closePrice-broker.exitPrice)<=.00001:null,
  distanceBeyondRecordedStop:beyond,brokerCloseReason:found?broker.closeReason:null,brokerReason:found?broker.brokerReason:null,
  brokerCosts:found?{commission:broker.commission,swap:broker.swap,fee:broker.fee}:null,
  historicalStopAcknowledgement:'NOT_AVAILABLE_FROM_DEAL_HISTORY',
  conclusion:!found?'INDETERMINATE_HISTORY':beyond!=null&&beyond>0?'VERIFY_STOP_ACK_AND_TICK_PATH':'NO_RECORDED_STOP_OVERSHOOT',
  limitation:'Matching deal prices/PnL does not prove the historical stop was attached or establish the cause of a fill beyond the stop.'};
}
