import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync} from "node:crypto";
import {runPreparedDemoIocQualification} from "./kalshiDemoIocQualification";
import {demoSignerFingerprint,type DemoExitApproval} from "./kalshiDemoSignedIoc";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const keyId="demo-key-001";
const privateKeyPem=generateKeyPairSync("ed25519").privateKey
  .export({format:"pem",type:"pkcs8"}).toString();
const now=1780000000000;
const clientId="v13p-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticker="KXBTC15M-26OCT161945-45";
const identity={
  ownerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  demoAccountId:"demo-only-a1",
  attemptId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  operatorApprovalId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  workerHolderId:"worker-demo",workerFencingToken:7,
};
const order:EmergencyExitOrder={
 ticker,side:"ask",count:"2.00",price:"0.5500",
 client_order_id:clientId,time_in_force:"immediate_or_cancel",
 post_only:false,reduce_only:true,
 self_trade_prevention_type:"taker_at_cross",
 subaccount:1,exchange_index:2,
};
const approval:DemoExitApproval={
 environment:"KALSHI_DEMO",
 authenticatedOwnerId:identity.ownerId,
 accountOwnerId:identity.ownerId,
 signerFingerprint:demoSignerFingerprint(keyId,privateKeyPem)!,
 demoAccountVerified:true,subaccount:1,exchangeIndex:2,
 ownerDemoApprovalConfirmed:true,
 ownerDemoApprovalConfirmation:"AUTHORIZE_ONE_SHOT_KALSHI_DEMO_PROTECTIVE_IOC_ONLY",
 ownerApprovalId:identity.operatorApprovalId,
 ownerApprovalSignedAtMs:now-1_000,
 approvalExpiresAtMs:now+5_000,marketTicker:ticker,marketOpen:true,
 priceGridVerified:true,permittedLimitPrice:"0.5500",
 positionMarketTicker:ticker,positionsComplete:true,
 signedPositionFp:"3.00",positionObservedAtMs:now-100,
 restingOrderCount:0,unresolvedOrderCount:0,
 feeFingerprint:"a".repeat(64),feeObservedAtMs:now-100,
 feesCurrentAndApplicable:true,workerFencingToken:7,
};
function harness(rejectPrepare=false){
 const calls:string[]=[];
 const receipt={
    httpStatus:201,order_id:"demo-order-1",client_order_id:clientId,
    fill_count:"1.00",remaining_count:"1.00",ts_ms:now,
 };
 const observation:IocRecoveryObservation={
    clientOrderId:clientId,requestedCountFp:"2.00",
    marketTicker:ticker,positionMarketTicker:ticker,
    initialPositionFp:"3.00",observedPositionFp:"2.00",
    reducingBookSide:"ask",completeExchangeHistory:true,
    exactMarketAndAccountMatched:true,orderAndFillHistoryMatched:true,
    isolatedPositionDelta:true,response:receipt,
 };
 const ledger={
    prepare:async()=>{calls.push("prepare");return !rejectPrepare;},
    consume:async()=>{calls.push("unknown");return {
      persisted:true as const,state:"UNKNOWN" as const,
      clientOrderId:clientId,fencingToken:7,
      mayRetry:false as const,oneShot:true as const,
    };},
    finalize:async()=>{calls.push("finalize");return true;},
 };
 const fetchImpl=(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
   calls.push("POST");
   assert.equal(init?.method,"POST");
   assert.equal(String(url),"https://external-api.demo.kalshi.co/trade-api/v2/portfolio/events/orders");
   return new Response(JSON.stringify(receipt),
      {status:201,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
 const readVerifiedExchangeHistory=async()=>{
   calls.push("GET history");
   return observation;
 };
 return {ledger,fetchImpl,readVerifiedExchangeHistory,calls};
}
test("One fully fenced DEMO pipeline follows PREPARE->UNKNOWN->POST->GET->FINAL",async()=>{
 const h=harness();
 const x=await runPreparedDemoIocQualification({
   identity,order,approval,demoKeyId:keyId,demoPrivateKeyPem:privateKeyPem,
   nowMs:()=>now,
  verifyAuthenticatedOwnerTestApproval:async()=>true,
   verifyAuthenticatedOwnerTestApproval:async()=>true,
   verifyAuthenticatedOwnerTestApproval:async(ownerId,approvalId)=>
     ownerId===identity.ownerId && approvalId===identity.operatorApprovalId,
   ledger:h.ledger as unknown as Parameters<typeof runPreparedDemoIocQualification>[0]["ledger"],
   fetchImpl:h.fetchImpl,
   readVerifiedExchangeHistory:h.readVerifiedExchangeHistory,
 });
 assert.equal(x.state,"RECONCILED");
 assert.equal(x.tradingAuthorized,false);
 assert.equal(x.filledHundredths,"100");
 assert.deepEqual(h.calls,["prepare","unknown","POST","GET history","finalize"]);
});
test("DEMO qualification denies missing server-backed owner approval before PREPARED",async()=>{
 const h=harness();
 const x=await runPreparedDemoIocQualification({
  identity,order,approval,demoKeyId:keyId,demoPrivateKeyPem:privateKeyPem,
  verifyAuthenticatedOwnerTestApproval:async()=>false,
  nowMs:()=>now,
  verifyAuthenticatedOwnerTestApproval:async()=>true,
  ledger:h.ledger as unknown as Parameters<typeof runPreparedDemoIocQualification>[0]["ledger"],
  fetchImpl:h.fetchImpl,readVerifiedExchangeHistory:h.readVerifiedExchangeHistory,
 });
 assert.equal(x.state,"BLOCKED");
 assert.deepEqual(h.calls,[]);
});
test("Owner mismatch or duplicate durable reservation denies ANY signed POST",async()=>{
 const x=harness();
 const result=await runPreparedDemoIocQualification({
  identity:{...identity,ownerId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},
  order,approval,demoKeyId:keyId,demoPrivateKeyPem:privateKeyPem,
  nowMs:()=>now,
  verifyAuthenticatedOwnerTestApproval:async()=>true,
  verifyAuthenticatedOwnerTestApproval:async(ownerId,approvalId)=>
    ownerId===identity.ownerId && approvalId===identity.operatorApprovalId,
  ledger:x.ledger as unknown as Parameters<typeof runPreparedDemoIocQualification>[0]["ledger"],
  fetchImpl:x.fetchImpl,readVerifiedExchangeHistory:x.readVerifiedExchangeHistory,
 });
 assert.equal(result.state,"BLOCKED");
 assert.deepEqual(x.calls,[]);
 const h=harness(true);
 const duplicate=await runPreparedDemoIocQualification({
  identity,order,approval,demoKeyId:keyId,demoPrivateKeyPem:privateKeyPem,
  nowMs:()=>now,
  verifyAuthenticatedOwnerTestApproval:async()=>true,
  verifyAuthenticatedOwnerTestApproval:async(ownerId,approvalId)=>
    ownerId===identity.ownerId && approvalId===identity.operatorApprovalId,
  ledger:h.ledger as unknown as Parameters<typeof runPreparedDemoIocQualification>[0]["ledger"],
  fetchImpl:h.fetchImpl,readVerifiedExchangeHistory:h.readVerifiedExchangeHistory,
 });
 assert.equal(duplicate.state,"BLOCKED");
 assert.deepEqual(h.calls,["prepare"]);
});
