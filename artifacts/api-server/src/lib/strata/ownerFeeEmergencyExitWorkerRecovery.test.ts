import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {reconcileOwnedProtectiveExits} from "./ownerFeeEmergencyExitWorkerRecovery";
const ownerId="11111111-1111-4111-8111-111111111111";
const rid="22222222-2222-4222-8222-222222222222";
const clientId="v13p-33333333-3333-4333-8333-333333333333";
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
