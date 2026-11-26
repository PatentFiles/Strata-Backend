import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {reconcileOwnedProtectiveExits} from "./ownerFeeEmergencyExitWorkerRecovery";
const ownerId="11111111-1111-4111-8111-111111111111";
const rid="22222222-2222-4222-8222-222222222222";
const clientId="v13p-55555555-5555-4555-8555-555555555555";
const order={ticker:"KXBTC15M-26OCT191545-45",client_order_id:clientId,
 side:"ask",count:"2.00",price:"0.5500",reduce_only:true,
 post_only:false,time_in_force:"immediate_or_cancel",
 self_trade_prevention_type:"taker_at_cross",subaccount:1,exchange_index:2};
const json=JSON.stringify(order);
const digest=createHash("sha256").update(json).digest("hex");
const identity={ownerId,accountId:"acct-1",material:{keyId:"test",privateKey:"not-a-real-key"}};
const row={reservation_id:rid,market_ticker:order.ticker,
 client_order_id:order.client_order_id,order_digest:digest,order_request_json:json};
function db(rows:Record<string,unknown>[]){
 return {query:async(sql:string,params?:unknown[])=>{
  assert.match(sql,/state='UNKNOWN'/);
  assert.match(sql,/owner_user_id=\$1::uuid/);
  assert.match(sql,/execution_account_id=\$2::text/);
  assert.deepEqual(params,[ownerId,"acct-1"]);
  return {rows};
 }};
}
test("worker recovers the exact persisted request without a signed POST",async()=>{
 let recovered=0;
 const result=await reconcileOwnedProtectiveExits(identity,db([row]),{
  recover:async x=>{
   recovered++;
   assert.equal(x.ownerId,ownerId);
   assert.equal(x.reservationId,rid);
   assert.deepEqual(x.order,order);
   return {state:"RECONCILED",reason:"provider_read_only_complete",
    mayRetry:false,postAttempted:false};
  },
 });
 assert.equal(result.ok,true);
 assert.equal(result.attempted,1);
 assert.equal(recovered,1);
 assert.equal(result.postAttempted,false);
});
test("no UNKNOWN reservation does not initiate exchange reads or posting",async()=>{
 let invoked=0;
 const result=await reconcileOwnedProtectiveExits(identity,db([]),{
  recover:async()=>{invoked++;throw Error("unexpected");},
 });
 assert.equal(result.ok,true);
 assert.equal(invoked,0);
});
test("tampered, absent, duplicate or foreign order body stays UNKNOWN",async()=>{
 let recovered=0;
 for(const invalid of [
  {...row,order_request_json:null},
  {...row,order_request_json:"{}"},
  {...row,order_request_json:json.replace("0.5500","0.6000")},
  {...row,client_order_id:"v13p-00000000-0000-4000-8000-000000000000"},
  {...row,order_digest:"a".repeat(64)},
 ]){
  const result=await reconcileOwnedProtectiveExits(identity,db([invalid]),{
   recover:async()=>{recovered++;throw Error("never called");},
  });
  assert.equal(result.ok,false);
  assert.equal(result.mayRetry,false);
  assert.equal(result.postAttempted,false);
 }
 const multiple=await reconcileOwnedProtectiveExits(identity,db([row,row]));
 assert.equal(multiple.ok,false);
 assert.equal(recovered,0);
});
test("provider downtime and uncertain reconciliation never cause retry or a second signed IOC",async()=>{
 let attempts=0;
 const result=await reconcileOwnedProtectiveExits(identity,db([row]),{
  recover:async()=>{
   attempts++;
   return {state:"UNKNOWN",reason:"exchange_history_unavailable",
    mayRetry:false,postAttempted:false};
  },
 });
 assert.equal(attempts,1);
 assert.equal(result.ok,false);
 assert.equal(result.postAttempted,false);
});
test("hosted worker cannot inject fake recovery receipts",async()=>{
 const prior=process.env.RAILWAY_SERVICE_ID;
 process.env.RAILWAY_SERVICE_ID="hosted-test-worker";
 try{
  let calls=0;
  const result=await reconcileOwnedProtectiveExits(identity,db([row]),{
   recover:async()=>{calls++;return {state:"RECONCILED",reason:"fake",
    mayRetry:false,postAttempted:false};},
  });
  assert.equal(result.ok,false);
  assert.equal(calls,0);
 }finally{
  if(prior===undefined)delete process.env.RAILWAY_SERVICE_ID;
  else process.env.RAILWAY_SERVICE_ID=prior;
 }
});
import {generateKeyPairSync} from 'node:crypto';
import {dedicatedSignerFingerprint} from './commissioning';
import {economicSettlementFixture} from './ownerEconomicSettlementFixture';
import {economicSettlementPlan,proveEconomicSettlement} from './ownerEconomicSettlementProof';
import {digest as ledgerDigest} from '../v13-production/types';

test("restart verifier recognizes the precise historical receipt without replay",async()=>{
 const f=economicSettlementFixture(Date.now()),p=economicSettlementPlan(proveEconomicSettlement(f));
 const a=f.account, r={...row,reservation_id:p.reservationId,client_order_id:f.history.requests[1]!.clientOrderId};
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString();
 const material={keyId:'isolated-test-only',privateKey:key},fp=dedicatedSignerFingerprint(material.keyId,key)!;
 const proof={payload:p,payload_digest:ledgerDigest(p),exit_intent_id:p.exitId,entry_intent_id:p.parentId,reservation_id:p.reservationId,
  client_order_id:r.client_order_id,market:p.settlement.market,settlement_event_id:p.eventId,settlement_digest:ledgerDigest(p.settlement),
  occurred_at:new Date(p.settlement.occurredAtMs)};
 let other=false,late=false,addSuccessor=false,successorConflict=false,recoveries=0,reads=0;
 const local={async query(sql:string){
  if(sql.includes("SELECT key_fingerprint,cash_micros"))return {rows:[{key_fingerprint:fp,cash_micros:p.cashAfterMicros}]};
  if(sql.includes("SELECT d.*, s.payload"))return {rows:[proof]};
  if(sql.includes("SELECT request FROM public.v13_production_intent"))return {rows:f.history.requests.map(request=>({request}))};
  if(sql.includes("AS intents,")&&sql.includes("AS exits"))return {rows:[{intents:other,exits:false}]};
  if(sql.includes("AS conflicting_intents"))return {rows:[{
   key_fingerprint:fp,matching:true,conflicting_intents:successorConflict,conflicting_markers:false}]};
  return {rows:addSuccessor?[r,row]:[r]};
 }};
 const run=()=>reconcileOwnedProtectiveExits({ownerId,accountId:a.id,material},local,{
  recover:async x=>{
   recoveries++;assert.equal(addSuccessor,true);assert.equal(x.reservationId,rid);assert.deepEqual(x.order,order);
   return {state:"RECONCILED",reason:"successor_read_only",mayRetry:false,postAttempted:false};
  },
  readFeeds:async(_material,observedAtMs)=>{
   reads++;const order=f.snapshot.orders[0]!,fill=f.snapshot.fills[0]!;
   const raw={client_order_id:order.request.clientOrderId,ticker:order.request.market,order_id:order.orderId,status:'executed',
    book_side:'ask',yes_price_dollars:'0.49',initial_count_fp:'3.00',fill_count_fp:'3.00'};
   return {ok:true,observedAtMs,historicalCoverageComplete:true,cashMicros:p.cashAfterMicros,
    orders:[raw,...(late?[{...raw,client_order_id:r.client_order_id,order_id:'late',book_side:'bid',yes_price_dollars:'0.90',status:'canceled',fill_count_fp:'0.00'}]:[])],
    fills:[{trade_id:fill.id,order_id:fill.orderId,ticker:fill.market,count_fp:'3.00',no_price_dollars:'0.49',fee_cost:'0.052500',created_time:new Date(fill.occurredAtMs).toISOString()}],
    settlements:[f.rawSettlement],positions:[f.rawPosition]} as never;
  }});
 const sha=process.env.RAILWAY_GIT_COMMIT_SHA,flag=process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA;
 try{
  process.env.RAILWAY_GIT_COMMIT_SHA='a'.repeat(40);process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA='a'.repeat(40);
  const accepted=await run();assert.equal(accepted.ok,true,JSON.stringify(accepted));assert.equal(accepted.postAttempted,false);
  late=true;assert.equal((await run()).ok,false);
  late=false;other=true;assert.equal((await run()).ok,false);
  assert.equal(reads,3);assert.equal(recoveries,0);
  other=false;addSuccessor=true;
  const successor=await run();assert.equal(successor.ok,true,JSON.stringify(successor));assert.equal(successor.attempted,1);assert.equal(successor.postAttempted,false);
  successorConflict=true;assert.equal((await run()).ok,false);
  successorConflict=false;late=true;assert.equal((await run()).ok,false);
  assert.equal(recoveries,1);
 }finally{
  if(sha===undefined)delete process.env.RAILWAY_GIT_COMMIT_SHA;else process.env.RAILWAY_GIT_COMMIT_SHA=sha;
  if(flag===undefined)delete process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA;else process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA=flag;
 }
});
