import test from 'node:test';import assert from 'node:assert/strict';
import {proveEconomicSettlement,economicSettlementPlan} from './ownerEconomicSettlementProof';
import {economicSettlementFixture as fixture} from './ownerEconomicSettlementFixture';

test('proposed settlement books precise P&L without double-charging fees or altering UNKNOWN/reserves',()=>{
 const f=fixture(),before=structuredClone(f),proof=proveEconomicSettlement(f),p=economicSettlementPlan(proof);
 assert.equal(p.cashDeltaMicros,'3000000');assert.equal(p.pnlMicros,'1477500');assert.equal(p.reservedMicros,'3000000');
 assert.equal(p.transportOutcome,'UNKNOWN');assert.equal(p.tradingAuthorized,false);assert.deepEqual(f,before);
 assert.equal(f.history.rows[1]!.state,'DISPATCHED');assert.equal(f.history.markers[0]!.state,'UNKNOWN');
});
test('process-local plan is immutable across input, output and serialized-token mutation',()=>{
 const f=fixture(),proof=proveEconomicSettlement(f);f.snapshot.cashMicros='1';const p=economicSettlementPlan(proof);p.cashDeltaMicros='1';
 assert.equal(economicSettlementPlan(proof).cashDeltaMicros,'3000000');assert.throws(()=>economicSettlementPlan({...proof}),/process_local/);
});
test('losing settlement realizes the complete entry debit without inventing payout',()=>{
 const f=fixture();f.snapshot.settlements[0]!.result='YES';f.snapshot.settlements[0]!.payoutMicros='0';f.snapshot.cashMicros=f.account.cash_micros;
 f.rawSettlement.market_result='yes';f.rawSettlement.revenue=0;
 assert.equal(economicSettlementPlan(proveEconomicSettlement(f)).pnlMicros,'-1522500');
});
const mutations:Record<string,(f:ReturnType<typeof fixture>)=>void>={
 'foreign owner':f=>{f.history.markers[0]!.owner_user_id='foreign';},
 'different account':f=>{f.history.rows[0]!.account_id='foreign';},
 'wrong subaccount':f=>{f.snapshot.identity.subaccount=0;},
 'wrong venue':f=>{f.rawSettlement.exchange_index=1;},
 'wrong current key':f=>{f.snapshot.identity.keyFingerprint='b'.repeat(64);},
 'stale snapshot':f=>{f.nowMs+=5001;},
 'future snapshot':f=>{f.nowMs--;},
 'missing history coverage':f=>{f.snapshot.historyFromMs=f.nowMs;},
 'incomplete history':f=>{f.snapshot.complete=false;},
 'unauthenticated response':f=>{f.snapshot.authenticated=false;},
 'pending live order':f=>{f.snapshot.orders[0]!.terminal=false;},
 'exit subsequently found':f=>{f.snapshot.orders.push({orderId:'late-order',request:f.history.requests[1]!,terminal:true,filledHundredths:'0'});},
 'exit subsequently filled':f=>{f.snapshot.fills.push({...f.snapshot.fills[0]!,id:'late-fill',clientOrderId:f.history.requests[1]!.clientOrderId,action:'SELL'});},
 'open exchange position':f=>{f.snapshot.positions.push({market:f.rawSettlement.ticker as string,side:'NO',quantityHundredths:'1'});},
 'missing explicit flat position':f=>{delete f.rawPosition.position_fp;},
 'wrong flat-position market':f=>{f.rawPosition.ticker='OTHER';},
 'wrong flat-position scope':f=>{f.rawPosition.subaccount=0;},
 'settlement quantity differs':f=>{f.snapshot.settlements[0]!.quantityHundredths='200';},
 'aggregate fees differ':f=>{f.rawSettlement.fee_cost='0.052501';},
 'aggregate gross differs':f=>{f.rawSettlement.no_total_cost_dollars='1.480000';},
 'double fee subtraction':f=>{f.snapshot.settlements[0]!.feeMicros='52500';},
 'payout inflated':f=>{f.snapshot.settlements[0]!.payoutMicros='3000001';},
 'cash does not match delta':f=>{f.snapshot.cashMicros='31477501';},
 'settlement predates exit':f=>{f.history.rows[1]!.dispatch_at=new Date(f.nowMs-1);},
 'settlement already recorded':f=>{f.history.events.push({...f.history.events[0]!,event_id:`settlement:${f.snapshot.settlements[0]!.id}`});},
 'known fill missing':f=>{f.snapshot.fills=[];},
 'known order missing':f=>{f.snapshot.orders=[];},
 'ledger event missing':f=>{f.history.events=[];},
 'ledger P&L corrupt':f=>{f.history.positions[0]!.realized_pnl_micros='1';},
 'reserve corrupt':f=>{f.account.reserved_micros='0';},
 'entry capability altered':f=>{f.history.rows[0]!.capability_digest='f'.repeat(64);},
 'other unresolved intent':f=>{f.history.rows.push({...f.history.rows[1]!,id:'another'});},
 'other UNKNOWN reservation':f=>{f.history.markers.push({...f.history.markers[0]!,reservation_id:'another'});},
 'mixed settlement sides':f=>{f.rawSettlement.yes_count_fp='1.00';},
 'unexplained cash activity':f=>{f.snapshot.unexplainedCashActivity=true;},
};
for(const [name,mutate] of Object.entries(mutations))test(`economic proof refuses ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>proveEconomicSettlement(f));});