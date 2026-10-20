import assert from "node:assert/strict";
import test from "node:test";
import {reconcileUnknownProtectiveExitAfterRestart} from "./ownerFeeEmergencyExitRestartRecovery";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const OWNER="11111111-1111-4111-8111-111111111111";
const RES="22222222-2222-4222-8222-222222222222";
const CID="v13p-33333333-3333-4333-8333-333333333333";
const MARKET="KXBTC15M-26OCT191545-45";
const input:Parameters<typeof reconcileUnknownProtectiveExitAfterRestart>[0]={
 ownerId:OWNER,accountId:"account-2",reservationId:RES,
 material:{keyId:"test-only",privateKey:"not-a-real-key"},
 order:{ticker:MARKET,client_order_id:CID,count:"2.00",price:"0.5500",
  side:"ask",reduce_only:true,post_only:false,
  time_in_force:"immediate_or_cancel",
  self_trade_prevention_type:"taker_at_cross",subaccount:1,exchange_index:2},
};

function providerProof():IocRecoveryObservation{
 return {
  clientOrderId:CID,requestedCountFp:"2.00",marketTicker:MARKET,
  initialPositionFp:"3.00",observedPositionFp:"2.00",
  positionMarketTicker:MARKET,reducingBookSide:"ask",
  completeExchangeHistory:true,exactMarketAndAccountMatched:true,
  orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
  response:null,
  authenticatedOrder:{
   order_id:"order-123",client_order_id:CID,
   status:"canceled",initial_count_fp:"2.00",
   fill_count_fp:"1.00",remaining_count_fp:"0.00",
  },
 };
}
const persisted=(committed:boolean)=>({
 committed,reason:committed?"verified":"duplicate_or_ambiguous",
 mayRetry:false as const,tradingAuthorized:false as const,
});
test("restart succeeds exactly once on terminal provider proof without a POST",async()=>{
 let reads=0,writes=0;
 const ports={
  readOutcome:async(_input:unknown,receipt:unknown)=>{
   reads++;assert.equal(receipt,null);return providerProof();
  },
  persistReconciled:async()=>{
   writes++;return persisted(writes===1);
  },
 };
 const first=await reconcileUnknownProtectiveExitAfterRestart(input,ports);
 assert.deepEqual(first,{state:"RECONCILED",reason:"signed_exchange_history_reconciled",
  mayRetry:false,postAttempted:false});
 const repeated=await reconcileUnknownProtectiveExitAfterRestart(input,ports);
 assert.equal(repeated.state,"UNKNOWN");
 assert.equal(repeated.mayRetry,false);
 assert.equal(repeated.postAttempted,false);
 assert.equal(reads,2);assert.equal(writes,2);
});
test("unproven/ambiguous/absent history never reaches the persistence boundary",async()=>{
 let commits=0;
 for(const proof of [
  {...providerProof(),completeExchangeHistory:false},
  {...providerProof(),isolatedPositionDelta:false},
  {...providerProof(),orderAndFillHistoryMatched:false},
  {...providerProof(),response:null,authenticatedOrder:undefined},
  {...providerProof(),observedPositionFp:"3.00"},
 ]){
  const result=await reconcileUnknownProtectiveExitAfterRestart(input,{
   readOutcome:async()=>proof,
   persistReconciled:async()=>{commits++;return persisted(true);},
  });
  assert.equal(result.state,"UNKNOWN");assert.equal(result.mayRetry,false);
  assert.equal(result.postAttempted,false);
 }
 assert.equal(commits,0);
});
test("read timeout, database failure, or ambiguous terminal commit remain UNKNOWN",async()=>{
 for(const phase of ["read","persist"] as const){
  const result=await reconcileUnknownProtectiveExitAfterRestart(input,{
   readOutcome:async()=>{
    if(phase==="read")throw Error("network_timeout");
    return providerProof();
   },
   persistReconciled:async()=>{
    if(phase==="persist")throw Error("database_commit_uncertain");
    return persisted(true);
   },
  });
  assert.equal(result.state,"UNKNOWN");assert.equal(result.mayRetry,false);
  assert.equal(result.postAttempted,false);
 }
});
test("runtime forbids injected evidence/reconciliation on a hosted worker",async()=>{
 let invoked=0;
 const original=process.env.RAILWAY_PROJECT_ID;
 process.env.RAILWAY_PROJECT_ID="hosted-test-only";
 try{
  const r=await reconcileUnknownProtectiveExitAfterRestart(input,{
   readOutcome:async()=>{invoked++;return providerProof();},
   persistReconciled:async()=>{invoked++;return persisted(true);},
  });
  assert.equal(r.state,"UNKNOWN");assert.equal(r.reason,"restart_test_ports_prohibited");
  assert.equal(invoked,0);assert.equal(r.postAttempted,false);
 }finally{
  if(original===undefined)delete process.env.RAILWAY_PROJECT_ID;
  else process.env.RAILWAY_PROJECT_ID=original;
 }
});
