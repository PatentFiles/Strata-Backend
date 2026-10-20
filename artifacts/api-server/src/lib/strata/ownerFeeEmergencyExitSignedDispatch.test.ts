import test from "node:test";
import {generateKeyPairSync,createPublicKey,verify,constants} from "node:crypto";
import assert from "node:assert/strict";
import {dispatchReviewedProtectiveExitOnce} from "./ownerFeeEmergencyExitSignedDispatch";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

const OWNER="11111111-1111-4111-8111-111111111111";
const RES="22222222-2222-4222-8222-222222222222";
const CID="v13p-33333333-3333-4333-8333-333333333333";
const MARKET="KXBTC15M-26OCT161945-45";
const o={
 ticker:MARKET,client_order_id:CID,side:"ask",count:"2.00",price:"0.5500",
 time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",
 post_only:false,reduce_only:true,subaccount:1,exchange_index:2,
};
const signingKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"}).toString();
const identity={ownerId:OWNER,accountId:"owner-execution-2",
 reservationId:RES,material:{keyId:"ephemeral-regression-only",privateKey:signingKey},
 order:o,lease:{holderId:"worker-1",fencingToken:8}};
function harness(input:{fill?:string;receipt?:boolean;denyLock?:boolean;fee?:boolean;
 marker?:boolean;reject?:boolean;badHistory?:boolean;rawSigned?:boolean;
 failPersist?:boolean;failCommit?:boolean}={}){
 const calls:{fee:number;mark:number;post:number;read:number;releases:number;sql:string[]}={
   fee:0,mark:0,post:0,read:0,releases:0,sql:[],
 };
 let consumed=false;
 const receipt={httpStatus:201,order_id:"order-1",client_order_id:CID,
  fill_count:input.fill??"1.00",remaining_count:
    input.fill==="0.00"?"2.00":input.fill==="2.00"?"0.00":"1.00",
  ts_ms:1792200000000};
 const db={connect:async()=>({query:async (sql:string)=>{
  calls.sql.push(sql);
  if(sql==="COMMIT"&&input.failCommit)throw Error("commit_acknowledgement_lost");
  if(sql.startsWith("SELECT r.reservation_id")){
   assert.match(sql,/v\.independent_reviewer_id <> a\.owner_user_id/);
   assert.match(sql,/r\.state='UNKNOWN'/);
   assert.match(sql,/a\.minimum_exit_micros <= \$11::bigint/);
   assert.match(sql,/FOR SHARE OF r,a,g,w,pos,v/);
   assert.match(sql,/r\.order_digest=\$12::text/);
   assert.match(sql,/w\.credential_fingerprint=\$13::text/);
   return {rows:input.denyLock?[]:[{reservation_id:RES}]};
  }
  return {rows:[]};
 },release:()=>{calls.releases++}})};
 const run=()=>dispatchReviewedProtectiveExitOnce(identity,{
   db,verifyFee:(async()=>{
     calls.fee++;
     return {ok:input.fee!==false,monetaryFeeAuthorized:input.fee!==false,
      marketTicker:MARKET,reason:"verified"};
   }) as never,
   mark:(async()=>{calls.mark++;
     if(input.marker===false||consumed)return {unknownRecorded:false};
     consumed=true;
     return {unknownRecorded:true,clientOrderId:CID,
       mayRetry:false,transportAuthorized:false};
   }) as never,
   post:input.rawSigned?undefined:async()=>{
     // Kills/revocations must never wait on row locks across network I/O.
     assert.ok(calls.sql.includes("COMMIT"),"SQL commit must precede POST");
     assert.equal(calls.releases,1,"release account/kill/lease locks before POST");
     calls.post++;if(input.reject)throw Error("timed out");
     return input.receipt===false?null:receipt;
   },
   persistReconciled:async()=>({committed:input.failPersist!==true,mayRetry:false,tradingAuthorized:false,reason:"test"}),
   readAuthenticatedOutcome:async(_input,observed)=>{
    calls.read++;
    const filled=input.fill??"1.00";
    const position=filled==="0.00"?"3.00":filled==="2.00"?"1.00":"2.00";
    return {clientOrderId:CID,marketTicker:MARKET,requestedCountFp:"2.00",
     initialPositionFp:"3.00",observedPositionFp:position,
     positionMarketTicker:MARKET,reducingBookSide:"ask",
     completeExchangeHistory:true,exactMarketAndAccountMatched:true,
     orderAndFillHistoryMatched:input.badHistory!==true,isolatedPositionDelta:true,
     response:observed} satisfies IocRecoveryObservation;
   }
 });
 return {run,calls};
}
test("one committed UNKNOWN marker produces at most one signed IOC, even across repeated calls",async()=>{
 const h=harness();
 const first=await h.run();
 assert.equal(first.state,"RECONCILED");assert.equal(first.postAttempted,true);
 assert.equal(first.filledHundredths,"100");
 const again=await h.run();
 assert.equal(again.state,"BLOCKED");
 assert.equal(again.postAttempted,false);
 assert.equal(h.calls.post,1);assert.equal(h.calls.mark,2);
 assert.equal(h.calls.read,1);
 assert.equal(first.mayRetry,false);
 assert.equal(first.tradingAuthorized,false);
});
test("exact 0/partial/full IOC observations reconcile only after independent read",async()=>{
 for(const [fill,expected] of [["0.00","0"],["1.00","100"],["2.00","200"]] as const){
  const h=harness({fill}),r=await h.run();
  assert.equal(r.state,"RECONCILED");
  assert.equal(r.filledHundredths,expected);
  assert.equal(h.calls.post,1);
  assert.equal(h.calls.read,1);
  assert.equal(r.mayRetry,false);
 }
});
test("fail-closed before POST for missing fee evidence, durable marker, or final account/lease lock",async()=>{
 for(const options of [{fee:false},{marker:false},{denyLock:true}]){
   const h=harness(options),r=await h.run();
   assert.equal(r.postAttempted,false);
   assert.equal(h.calls.post,0);
   assert.equal(r.tradingAuthorized,false);
 }
});
test("uncertain network responses and unproven history remain UNKNOWN, never retryable",async()=>{
 for(const options of [{reject:true},{receipt:false},{badHistory:true}]){
   const h=harness(options),r=await h.run();
   assert.equal(r.state,"UNKNOWN");
   assert.equal(r.mayRetry,false);
   assert.equal(h.calls.post,1);
   await h.run(); assert.equal(h.calls.post,1);
 }
});
test("unverified monetary fees deny before consuming an emergency reservation",async()=>{
 let n=0;
 const r=await dispatchReviewedProtectiveExitOnce(identity,{
  mark:(async()=>{n++;throw Error("unexpected");}) as never,
  verifyFee:(async()=>({ok:false,monetaryFeeAuthorized:false,reason:"fee_unavailable"})) as never
 });
 assert.equal(r.state,"BLOCKED");
 assert.equal(r.reason,"protective_exit_monetary_fees_unverified");
 assert.equal(n,0);
});
test("owner, scope and order identity are checked before all external side effects",async()=>{
 for(const order of [
  {...o,reduce_only:false},
  {...o,time_in_force:"good_till_canceled"},
  {...o,subaccount:0},
  {...o,side:"buy"},
  {...o,price:"bad"},
  {...o,ticker:"OTHER"},
 ]){
   let called=0;
   const result=await dispatchReviewedProtectiveExitOnce({...identity,order},{
     verifyFee:(async()=>{called++;throw Error("unexpected");}) as never,
     readAuthenticatedOutcome:async()=>{called++;throw Error("unexpected")}
   });
   assert.equal(result.state,"BLOCKED");
   assert.equal(called,0);
 }
});

test("signed V2 POST uses exact canonical path, RSA-PSS and strict reduce-only IOC body",async()=>{
 const oldFetch=globalThis.fetch;
 let captured=0;
 globalThis.fetch=(async(url:unknown,init?:RequestInit)=>{
   captured++;
   assert.equal(url,"https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders");
   assert.equal(init?.method,"POST");assert.equal(init?.redirect,"error");
   const headers=init!.headers as Record<string,string>;
   const ts=headers["KALSHI-ACCESS-TIMESTAMP"];
   const sig=headers["KALSHI-ACCESS-SIGNATURE"];
   assert.ok(verify("sha256",Buffer.from(ts+"POST"+"/trade-api/v2/portfolio/events/orders"),
      {key:createPublicKey(signingKey),padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},
      Buffer.from(sig,"base64")));
   const body=JSON.parse(String(init!.body)) as Record<string,unknown>;
   assert.deepEqual(Object.keys(body).sort(),[
    "ticker","client_order_id","side","count","price","time_in_force",
    "self_trade_prevention_type","post_only","cancel_order_on_pause",
    "reduce_only","subaccount","exchange_index"].sort());
   assert.equal(body.reduce_only,true);
   assert.equal(body.time_in_force,"immediate_or_cancel");
   assert.equal(body.cancel_order_on_pause,true);
   assert.equal(body.subaccount,1);assert.equal(body.exchange_index,2);
   return new Response(JSON.stringify({order_id:"order-1",client_order_id:CID,
    fill_count:"1.00",remaining_count:"1.00",ts_ms:1792200000000}),{status:201});
 }) as typeof fetch;
 try{
   const h=harness({rawSigned:true}),result=await h.run();
   assert.equal(result.state,"RECONCILED");
   assert.equal(captured,1);
 }finally{globalThis.fetch=oldFetch;}
});

test("a valid exchange fill without durable audited terminal commit remains UNKNOWN",async()=>{
 const h=harness({failPersist:true});
 const result=await h.run();
 assert.equal(result.state,"UNKNOWN");
 assert.equal(result.mayRetry,false);
 assert.equal(result.tradingAuthorized,false);
 assert.equal(result.postAttempted,true);
 assert.equal(h.calls.post,1);
 await h.run();
 assert.equal(h.calls.post,1);
});

test("failed or ambiguous final fence COMMIT never posts and is never retryable",async()=>{
 const h=harness({failCommit:true});
 const result=await h.run();
 assert.equal(result.state,"UNKNOWN");
 assert.equal(result.postAttempted,false);
 assert.equal(h.calls.post,0);
 assert.equal(h.calls.releases,1);
 assert.ok(h.calls.sql.includes("ROLLBACK"));
 const repeat=await h.run();
 assert.equal(repeat.postAttempted,false);
 assert.equal(h.calls.post,0);
});

test("kill/lease/review database row locks are released before network transport",async()=>{
 const h=harness({receipt:false});
 const r=await h.run();
 assert.equal(r.state,"UNKNOWN");
 assert.equal(r.postAttempted,true);
 assert.equal(h.calls.post,1);
 assert.equal(h.calls.releases,1);
 assert.ok(h.calls.sql.indexOf("COMMIT")>=0);
 assert.ok(h.calls.sql.indexOf("COMMIT")>h.calls.sql.findIndex(q=>q.startsWith("SELECT r.reservation_id")));
});
