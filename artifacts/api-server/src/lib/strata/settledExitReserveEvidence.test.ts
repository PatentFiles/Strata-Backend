import test from 'node:test';import assert from 'node:assert/strict';
import {digest} from '../v13-production/types';
import {economicSettlementFixture as fixture} from './ownerEconomicSettlementFixture';
import {economicSettlementPlan,proveEconomicSettlement} from './ownerEconomicSettlementProof';
import {inspectSettledExitReserve} from './settledExitReserveEvidence';
function posted(){
 const f=fixture(),p=economicSettlementPlan(proveEconomicSettlement(f)),a=f.account;
 const receipt={payload:p,payload_digest:digest(p),owner_user_id:a.owner_user_id,execution_account_id:a.id,
  exit_intent_id:p.exitId,reservation_id:p.reservationId,entry_intent_id:p.parentId,settlement_event_id:p.eventId,
  settlement_digest:digest(p.settlement),prior_revision:p.expectedRevision,posted_revision:'18',transport_outcome:'UNKNOWN',trading_authorized:false};
 a.revision='18';a.cash_micros=p.cashAfterMicros;
 f.history.events.push({account_id:a.id,event_id:p.eventId,intent_id:p.parentId,kind:'SETTLEMENT',payload:p.settlement,
  digest:digest(p.settlement),cash_delta_micros:p.cashDeltaMicros,pnl_micros:p.pnlMicros,occurred_at:new Date(p.settlement.occurredAtMs)});
 Object.assign(f.history.positions[0]!,{quantity_hundredths:'0',basis_micros:'0',realized_pnl_micros:p.pnlMicros});
 return {f,receipt};
}
test('verified posted settlement + matching fresh bracket preserve unknown history and funds',()=>{
 const {f,receipt}=posted(),before=structuredClone(f),out=inspectSettledExitReserve(f,receipt);
 assert.equal(out.transportOutcome,'UNKNOWN');assert.equal(out.reservedMicros,'3000000');
 assert.equal(out.reserveReleased,false);assert.equal(out.accountingPosted,false);assert.equal(out.tradingAuthorized,false);
 assert.deepEqual(f,before);
});
const reject:Record<string,(x:ReturnType<typeof posted>)=>void>={
 'foreign owner':({receipt})=>{receipt.owner_user_id='foreign';},
 'wrong subaccount':({f})=>{f.snapshot.identity.subaccount=0;},
 'tampered receipt':({receipt})=>{receipt.payload.pnlMicros='1';},
 'duplicate credit':({f})=>{f.history.events.push({...f.history.events[1]!});},
 'wrong ledger amount':({f})=>{f.history.events[1]!.cash_delta_micros='1';},
 'intervening account revision':({f})=>{f.account.revision='19';},
 'stale evidence':({f})=>{f.nowMs+=5001;},
 'partial exchange history':({f})=>{f.snapshot.complete=false;},
 'replacement key':({f})=>{f.snapshot.identity.keyFingerprint='b'.repeat(64);},
 'cash mismatch':({f})=>{f.snapshot.cashMicros='1';},
 'unexplained cash':({f})=>{f.snapshot.unexplainedCashActivity=true;},
 'pending order':({f})=>{f.snapshot.orders[0]!.terminal=false;},
 'remaining exposure':({f})=>{f.rawPosition.position_fp='-0.01';},
 'later exchange order':({f})=>{f.snapshot.orders.push({request:f.history.requests[1]!,orderId:'late',terminal:true,filledHundredths:'0'});},
 'later exchange fill':({f})=>{f.snapshot.fills.push({...f.snapshot.fills[0]!,id:'late',action:'SELL',clientOrderId:f.history.requests[1]!.clientOrderId});},
 'rewritten exit':({f})=>{f.history.rows[1]!.terminal=true;},
 'other unresolved intent':({f})=>{f.history.rows.push({...f.history.rows[1]!,id:'another'});},
};
for(const [name,change] of Object.entries(reject))test('refuses '+name,()=>{const data=posted();change(data);assert.throws(()=>inspectSettledExitReserve(data.f,data.receipt));});
