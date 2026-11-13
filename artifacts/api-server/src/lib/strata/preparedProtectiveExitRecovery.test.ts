import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {recoverPreparedOwnedExitIntents} from './preparedProtectiveExitRecovery';
import {digest} from '../v13-production/types';
const now=100000,owner='owner',account='main';
function fixture(q:string,legacy=false){
 const request={market:'KXBTC15M-TEST-000',side:'YES',action:'SELL',reduceOnly:true,timeInForce:'IOC',clientOrderId:'v13p-exit',limitMicros:450000,...(legacy?{contracts:2}:{quantityVersion:'EXIT_HUNDREDTHS_V1',quantityHundredths:q})};
 const decision={ownedEvaluation:{source:{evaluated_at:new Date(now-6000).toISOString()}},policy:{maxQuoteAgeMs:5000}};
 const intent={id:'exit',parent_id:'parent',account_id:account,market:request.market,side:'YES',kind:'EXIT',state:'PREPARED',terminal:false,dispatch_at:null,exchange_order_id:null,filled_hundredths:'0',reserved_micros:'0',exit_fee_micros:'0',request,client_order_id:request.clientOrderId,decision,policy_hash:'policy',fee_fingerprint:'fee',capability_digest:''};
 intent.capability_digest=digest({id:intent.id,request,decision,policyHash:'policy',fee:'fee'});
 const quantity=BigInt(q),raw=JSON.stringify({ticker:request.market,side:'ask',count:`${quantity/100n}.${String(quantity%100n).padStart(2,'0')}`,price:'0.4500',client_order_id:request.clientOrderId,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2});
 const marker={reservation_id:'marker',state:'PREPARED',trading_authorized:false,owner_user_id:owner,execution_account_id:account,market_ticker:request.market,reducing_side:'YES',quantity_hundredths:q,order_request_json:raw,order_digest:createHash('sha256').update(raw).digest('hex')};
 let voids=0;const tx={query:async(sql:string)=>{if(sql.startsWith('SELECT * FROM v13_production_position'))return {rows:[{market:request.market,side:'YES',quantity_hundredths:q,basis_micros:'1'}]};if(sql.startsWith('SELECT * FROM private.strata_emergency_exit_reservations'))return {rows:[marker]};if(sql.startsWith('UPDATE private.strata_emergency_exit_reservations')){voids++;return {rows:[{reservation_id:'marker'}]};}throw Error('unexpected SQL')}};
 const run=()=>recoverPreparedOwnedExitIntents(tx as never,{ownerId:owner,account:{id:account,owner_user_id:owner},intents:[{id:'parent',kind:'ENTRY',terminal:true},intent],snapshot:{authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,observedAtMs:now},observe:async()=>{}} as never);
 return {run,intent,marker,voids:()=>voids};
}
test('prepared recovery preserves exact0.01,0.50,1.50 and legacy2.00 without a send or quantity reduction',async()=>{
 for(const [q,legacy] of [['1',false],['50',false],['150',false],['200',true]] as const){const f=fixture(q,legacy);await f.run();assert.equal(f.intent.state,'BLOCKED');assert.equal(f.voids(),1);assert.equal(f.marker.quantity_hundredths,q);}
});
test('prepared recovery rejects changed marker quantity or non-PREPARED state',async()=>{
 for(const mutation of [{quantity_hundredths:'2'},{state:'UNKNOWN'},{state:'RECONCILED'}]){const f=fixture('50');Object.assign(f.marker,mutation);await assert.rejects(f.run(),/marker_not_proven_unsent/);assert.equal(f.voids(),0);assert.equal(f.intent.state,'PREPARED');}
});
