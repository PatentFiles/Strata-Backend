import assert from "node:assert/strict";
import test from "node:test";
import {dispatchOwnedWorkerProtectiveExit} from "./ownerFeeEmergencyExitWorkerDispatch";
import type {MarketEvidence} from "../v13-production/types";
const OWNER="11111111-1111-4111-8111-111111111111";
const market="KXBTC15M-26OCT191945-45";
const evidence={
 observedAtMs:Date.now(),bestBidDollars:"0.5500",
 bids:[{priceDollars:"0.5500",availableContracts:"5.00"}],
 bestAskDollars:"0.5600",
 asks:[{priceDollars:"0.5600",availableContracts:"5.00"}],
 fee:{policyVersion:"test",sourceUrl:"test",formulaVersion:"test",
  fingerprint:"a".repeat(64),verifiedAtMs:Date.now(),
  contracts:2,limitPrice:0.55,reservedEntryFeeCents:1,reservedExitFeeCents:1},
} as MarketEvidence;
const input={
 ownerId:OWNER,accountId:"acct-owner-1",
 material:{keyId:"test-not-real",privateKey:"not-a-real-key"},
 lease:{holderId:"personal-owner-lease",fencingToken:17},
 market,positionSide:"YES" as "YES"|"NO",
 ownedQuantityHundredths:"200",minimumExitMicros:10000,
 readMarket:async()=>evidence,
};
test("owned YES position forms one signed reduce-only IOC after durable preparation",async()=>{
 let prepares=0,posts=0;
 const result=await dispatchOwnedWorkerProtectiveExit(input,{
  reserve:async(owner,account,material,order,lease)=>{
   prepares++;
   assert.equal(owner,OWNER);assert.equal(account,input.accountId);
   assert.equal(order.side,"ask");assert.equal(order.price,"0.5500");
   assert.equal(order.count,"2.00");assert.equal(order.reduce_only,true);
   assert.equal(order.subaccount,1);assert.equal(order.exchange_index,2);
   assert.equal(order.time_in_force,"immediate_or_cancel");
   assert.match(String(order.client_order_id),/^v13p-[a-f0-9-]{36}$/);
   assert.equal(lease.fencingToken,17);
   return {ok:false,tradingAuthorized:false,reservationPrepared:true,
    reason:"prepared",clientOrderId:String(order.client_order_id),
    reservationId:"22222222-2222-4222-8222-222222222222"};
  },
  dispatch:async o=>{
   posts++;
   assert.equal(o.reservationId,"22222222-2222-4222-8222-222222222222");
   assert.equal(o.order.side,"ask");
   return {state:"RECONCILED",reason:"proof",postAttempted:true,
    tradingAuthorized:false,mayRetry:false};
  },
 });
 assert.equal(result.state,"RECONCILED");assert.equal(prepares,1);assert.equal(posts,1);
});
test("NO position uses complementary YES book bid while honoring approved NO floor",async()=>{
 let checked=false;
 const result=await dispatchOwnedWorkerProtectiveExit({...input,positionSide:"NO"},{
  reserve:async(_owner,_account,_material,order)=>{
   checked=true;
   assert.equal(order.side,"bid");assert.equal(order.price,"0.4500");
   return {ok:false,tradingAuthorized:false,reservationPrepared:false,
    reason:"no_provider_inventory"};
  },
 });
 assert.equal(result.state,"BLOCKED");assert.equal(checked,true,result.reason);
 assert.equal(result.postAttempted,false);
});
test("missing depth and below-floor quotes produce no reservation or network attempt",async()=>{
 for(const minimumExitMicros of [550001,900000]){
  let calls=0;
  const r=await dispatchOwnedWorkerProtectiveExit({...input,minimumExitMicros},{
   reserve:async()=>{calls++;throw Error("never");},
   dispatch:async()=>{calls++;throw Error("never");},
  });
  assert.equal(r.state,"BLOCKED");assert.equal(calls,0);
 }
});
test("an UNKNOWN signed IOC never falls through to another dispatcher",async()=>{
 let calls=0;
 const r=await dispatchOwnedWorkerProtectiveExit(input,{
  reserve:async()=>({ok:false,tradingAuthorized:false,reservationPrepared:true,
   reason:"prepared",reservationId:"22222222-2222-4222-8222-222222222222"}),
  dispatch:async()=>{calls++;return {state:"UNKNOWN",reason:"ambiguous",
   postAttempted:true,mayRetry:false,tradingAuthorized:false};},
 });
 assert.equal(calls,1);assert.equal(r.state,"UNKNOWN");
 assert.equal(r.postAttempted,true);
});
test("hosted production rejects injected provider proofs and release skips",async()=>{
 const prior=process.env.RAILWAY_SERVICE_ID;
 process.env.RAILWAY_SERVICE_ID="hosted-test-only";
 try{
  let calls=0;
  const r=await dispatchOwnedWorkerProtectiveExit(input,{
   reserve:async()=>{calls++;throw Error("never");},
   dispatch:async()=>{calls++;throw Error("never");},
  });
  assert.equal(r.reason,"protective_exit_test_ports_prohibited");
  assert.equal(calls,0);
 }finally{
  if(prior===undefined)delete process.env.RAILWAY_SERVICE_ID;
  else process.env.RAILWAY_SERVICE_ID=prior;
 }
});
