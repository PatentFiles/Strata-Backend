import {randomUUID} from 'node:crypto';
import {digest} from '../v13-production/types';
import {economicSettlementFixture} from './ownerEconomicSettlementFixture';
import {proveEconomicSettlement,economicSettlementPlan} from './ownerEconomicSettlementProof';
export function economicDischargeFixture(result:'NO_WINS'|'NO_LOSES'='NO_WINS'){
 const x=economicSettlementFixture();
 if(result==='NO_LOSES'){
  // Test a real losing-NO economic obligation without assuming an exit was
  // never sent. The original UNKNOWN request/reservation must remain intact.
  x.snapshot.settlements[0]!.result='YES';
  x.snapshot.settlements[0]!.payoutMicros='0';
  x.snapshot.cashMicros=x.account.cash_micros;
  x.rawSettlement.market_result='yes';
  x.rawSettlement.revenue=0;
  x.rawPosition.realized_pnl_dollars='-1.522500';
 }
 const plan=economicSettlementPlan(proveEconomicSettlement(x));
 const booking={request_id:randomUUID(),execution_account_id:x.account.id,owner_user_id:x.account.owner_user_id,entry_intent_id:plan.parentId,
  exit_intent_id:plan.exitId,reservation_id:plan.reservationId,settlement_event_id:plan.eventId,settlement_digest:digest(plan.settlement),
  prior_revision:x.account.revision,posted_revision:String(BigInt(x.account.revision)+1n),payload:plan,payload_digest:digest(plan),transport_outcome:'UNKNOWN',trading_authorized:false};
 x.account.cash_micros=plan.cashAfterMicros;x.account.revision=booking.posted_revision;
 x.history.events.push({account_id:x.account.id,event_id:plan.eventId,intent_id:plan.parentId,kind:'SETTLEMENT',payload:plan.settlement,digest:digest(plan.settlement),cash_delta_micros:plan.cashDeltaMicros,pnl_micros:plan.pnlMicros,occurred_at:new Date(plan.settlement.occurredAtMs)});
 const position=x.history.positions[0]!;position.quantity_hundredths='0';position.basis_micros='0';position.realized_pnl_micros=plan.pnlMicros;
 const market={ticker:plan.settlement.market,exchange_index:2,market_type:'binary',status:'finalized',result:plan.settlement.result.toLowerCase(),settlement_ts:x.rawSettlement.settled_time,close_time:new Date(plan.settlement.occurredAtMs-1000).toISOString(),settlement_value_dollars:plan.settlement.result==='YES'?'1.0000':'0.0000'};
 return {...x,booking,market,transfers:{subaccount:[] as Record<string,unknown>[],crossExchange:[] as Record<string,unknown>[],complete:true}};
}
