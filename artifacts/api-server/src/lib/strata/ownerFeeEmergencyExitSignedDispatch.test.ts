import test from "node:test";
import {generateKeyPairSync,createPublicKey,verify,constants} from "node:crypto";
import assert from "node:assert/strict";
import {dispatchReviewedProtectiveExitOnce,isDurableProtectiveExitNoSend} from "./ownerFeeEmergencyExitSignedDispatch";
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
 failPersist?:boolean;failCommit?:boolean;commitDelayMs?:number;reservationAgeMs?:number;heartbeatAgeMs?:number;finalize?:boolean;leaseChanged?:boolean;finalizeFail?:string;secondFeeRejected?:boolean;secondFeeThrows?:boolean;clientOrderId?:string;reservationId?:string;initialPosition?:string}={}){
 const clientId=input.clientOrderId??CID,reservationId=input.reservationId??RES;
 const calls:{fee:number;mark:number;post:number;read:number;releases:number;sql:string[]}={
   fee:0,mark:0,post:0,read:0,releases:0,sql:[],
 };
 let consumed=false;let monotonic=0;
 const receipt={httpStatus:201,order_id:"order-1",client_order_id:clientId,
  fill_count:input.fill??"1.00",remaining_count:
    input.fill==="0.00"?"2.00":input.fill==="2.00"?"0.00":"1.00",
  ts_ms:1792200000000};
 const db={connect:async()=>({query:async (sql:string)=>{
  calls.sql.push(sql);
  if(sql.includes("AS intent_id"))return {rows:input.finalize?[{reservation_id:reservationId,intent_id:"exit-intent"}]:[]};
  if(sql.startsWith("SELECT id FROM public.v13_production_account"))return {rows:input.finalize?[{id:identity.accountId}]:[]};
  if(sql.startsWith("SELECT execution_account_id FROM private.kalshi_account_worker_lease"))return {rows:input.finalize&&!input.leaseChanged?[{execution_account_id:identity.accountId}]:[]};
  if(sql.startsWith("INSERT INTO private.strata_protective_exit_local_no_send")){
   if(input.finalizeFail==="insert")throw Error("audit unavailable");return {rows:[{reservation_id:reservationId}]};
  }
  if(sql.startsWith("UPDATE public.v13_production_intent SET state='BLOCKED'")){
   if(input.finalizeFail==="intent")return {rows:[]};return {rows:[{id:"exit-intent"}]};
  }
  if(sql.startsWith("UPDATE private.strata_emergency_exit_reservations SET state='VOID'")){
   if(input.finalizeFail==="reservation")return {rows:[]};return {rows:[{reservation_id:reservationId}]};
  }
  if(sql==="COMMIT"&&input.finalizeFail==="commit"&&calls.sql.some(x=>x.startsWith("INSERT INTO private.strata_protective_exit_local_no_send")))throw Error("finalize acknowledgement lost");
  if(sql==="COMMIT")monotonic+=input.commitDelayMs??0;
  if(sql==="COMMIT"&&input.failCommit)throw Error("commit_acknowledgement_lost");
  if(sql.startsWith("SELECT r.reservation_id")){
   assert.doesNotMatch(sql,/private\.strata_owner_sha_approvals oa/);
   assert.match(sql,/private\.strata_protective_exit_release v/);
   assert.match(sql,/v\.independent_reviewer_id<>a\.owner_user_id/);
   assert.match(sql,/v\.operator_approver_id<>v\.independent_reviewer_id/);
   assert.match(sql,/r\.state='UNKNOWN'/);
   assert.match(sql,/a\.minimum_exit_micros <= \$11::bigint/);
   assert.match(sql,/FOR SHARE OF r,a,g,w,pos/);
   assert.match(sql,/r\.order_digest=\$12::text/);
   assert.match(sql,/w\.credential_fingerprint=\$13::text/);
   return {rows:input.denyLock?[]:[{reservation_id:reservationId,reservation_age_ms:input.reservationAgeMs??0,heartbeat_age_ms:input.heartbeatAgeMs??0}]};
  }
  return {rows:[]};
 },release:()=>{calls.releases++}})};
 const run=()=>dispatchReviewedProtectiveExitOnce({...identity,reservationId,order:{...o,client_order_id:clientId}},{
   db,monotonicNow:()=>monotonic,verifyFee:(async()=>{
     calls.fee++;if(input.secondFeeThrows&&calls.fee===2)throw Error("SECRET read-only provider failure");
     const feeOk=input.fee!==false&&!(input.secondFeeRejected&&calls.fee===2);
     return {ok:feeOk,monetaryFeeAuthorized:feeOk,
      marketTicker:MARKET,reason:"verified"};
   }) as never,
   mark:(async()=>{calls.mark++;
     if(input.marker===false||consumed)return {unknownRecorded:false};
     consumed=true;
     return {unknownRecorded:true,clientOrderId:clientId,
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
    const initial=input.initialPosition??"3.00",position=(Number(initial)-Number(filled)).toFixed(2);
    return {clientOrderId:clientId,marketTicker:MARKET,requestedCountFp:"2.00",
     initialPositionFp:initial,observedPositionFp:position,
     positionMarketTicker:MARKET,reducingBookSide:"ask",
     completeExchangeHistory:true,exactMarketAndAccountMatched:true,
     orderAndFillHistoryMatched:input.badHistory!==true,isolatedPositionDelta:true,
     response:observed} satisfies IocRecoveryObservation;
   }
 });
 return {run,calls,elapsed:()=>monotonic};
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

test("final outbound fence demands a matching DISPATCHED V13 financial EXIT intent",async()=>{
 const h=harness({receipt:false});
 await h.run();
 const fence=h.calls.sql.find(q=>q.includes("FROM private.strata_emergency_exit_reservations r"));
 assert.ok(fence,"expected account-scoped signed release fence");
 assert.match(fence!,/i\.client_order_id=r\.client_order_id/);
 assert.match(fence!,/i\.kind='EXIT'/);
 assert.match(fence!,/i\.state='DISPATCHED'/);
 assert.match(fence!,/i\.terminal=false/);
 assert.match(fence!,/i\.client_order_id<>r\.client_order_id/);
});

// Production must never treat an absent opt-in as authorization, even when
// a caller supplies valid order/owner data. This test performs ZERO network I/O.
test("hosted signed dispatcher rejects absent, malformed and false release switch before DB or POST",async()=>{
 const prior={
  mode:process.env.NODE_ENV,
  hosted:process.env.RAILWAY_SERVICE_ID,
  flag:process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE,
 };
 try{
  process.env.NODE_ENV="production";
  process.env.RAILWAY_SERVICE_ID="ci-hosted-guard-test";
  for(const value of [undefined,"","1","TRUE","false"]){
   if(value===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
   else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=value;
   let called=0;
   const result=await dispatchReviewedProtectiveExitOnce(identity,{
    verifyFee:(async()=>{called++;throw Error("must not probe");}) as never,
    post:async()=>{called++;throw Error("must not POST");},
   });
   assert.equal(result.state,"BLOCKED",String(value));
   assert.equal(result.reason,"protective_exit_release_disabled",String(value));
   assert.equal(result.postAttempted,false);
   assert.equal(called,0);
  }
 }finally{
  if(prior.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior.mode;
  if(prior.hosted===undefined)delete process.env.RAILWAY_SERVICE_ID;
  else process.env.RAILWAY_SERVICE_ID=prior.hosted;
  if(prior.flag===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
  else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=prior.flag;
 }
});

test("owned exit rechecks DB-relative reservation/heartbeat lifetimes after delayed COMMIT",async()=>{
 for(const options of [{commitDelayMs:9000},{commitDelayMs:5000},{commitDelayMs:1,heartbeatAgeMs:4999},{commitDelayMs:1,reservationAgeMs:7999}]){
  const h=harness(options),r=await h.run();
  assert.equal(h.calls.post,0);assert.equal(r.state,"UNKNOWN");assert.equal(r.postAttempted,false);
  assert.equal(r.mayRetry,false);await h.run();assert.equal(h.calls.post,0);
 }
 const fresh=harness({commitDelayMs:4999}),r=await fresh.run();
 assert.equal(r.state,"RECONCILED");assert.equal(fresh.calls.post,1);
});
test("owned exit fails closed for missing, future and invalid DB age evidence",async()=>{
 for(const age of [NaN,Infinity,-1,8000]){
  const h=harness({reservationAgeMs:age}),r=await h.run();
  assert.equal(r.postAttempted,false);assert.equal(h.calls.post,0);
 }
 const h=harness({heartbeatAgeMs:5000});assert.equal((await h.run()).postAttempted,false);
});

test("owned exit rejects invalid or regressed monotonic time and preserves UNKNOWN without retry",async()=>{
 for(const commitDelayMs of [NaN,Infinity,-1]){
  const h=harness({commitDelayMs}),r=await h.run();
  assert.equal(r.state,"UNKNOWN");assert.equal(r.postAttempted,false);assert.equal(h.calls.post,0);
  await h.run();assert.equal(h.calls.post,0);
 }
});
test("real signing path refuses aged evidence before raw fetch",async()=>{
 const oldFetch=globalThis.fetch;let sends=0;
 globalThis.fetch=(async()=>{sends++;throw Error("unexpected send");}) as typeof fetch;
 try{
  const h=harness({rawSigned:true,commitDelayMs:5000}),r=await h.run();
  assert.equal(r.state,"UNKNOWN");assert.equal(r.postAttempted,false);assert.equal(sends,0);
 }finally{globalThis.fetch=oldFetch;}
});

test("proven no-send is durably VOID/BLOCKED, never RECONCILED or replayed",async()=>{
 for(const options of [{commitDelayMs:5000},{secondFeeRejected:true},{secondFeeThrows:true}]){
  const h=harness({...options,finalize:true}),r=await h.run();
  assert.equal(r.state,"BLOCKED");assert.equal(r.reason,"protective_exit_proven_not_posted_refresh_required");
  assert.equal(r.postAttempted,false);assert.equal(r.mayRetry,false);assert.equal(h.calls.post,0);
  assert.ok(h.calls.sql.some(x=>x.startsWith("INSERT INTO private.strata_protective_exit_local_no_send")));
  assert.ok(h.calls.sql.some(x=>x.includes("SET state='VOID'")));
  assert.ok(!h.calls.sql.some(x=>x.includes("SET state='RECONCILED'")));
  await h.run();assert.equal(h.calls.post,0);
 }
});
test("takeover or partial/ambiguous local finalization retains UNKNOWN without retry",async()=>{
 for(const options of [{leaseChanged:true},...['insert','intent','reservation','commit'].map(finalizeFail=>({finalizeFail}))]){
  const h=harness({commitDelayMs:5000,finalize:true,...options}),r=await h.run();
  assert.equal(r.state,"UNKNOWN");assert.equal(r.postAttempted,false);assert.equal(h.calls.post,0);
  assert.ok(h.calls.sql.includes("ROLLBACK"));await h.run();assert.equal(h.calls.post,0);
 }
});
test("actual transport ambiguity never mints a local no-send audit",async()=>{
 const h=harness({reject:true,finalize:true}),r=await h.run();
 assert.equal(r.state,"UNKNOWN");assert.equal(r.postAttempted,true);assert.equal(h.calls.post,1);
 assert.ok(!h.calls.sql.some(x=>x.startsWith("INSERT INTO private.strata_protective_exit_local_no_send")));
});

test("second fee reader exception cannot be mistaken for an ambiguous order transport",async()=>{
 const h=harness({secondFeeThrows:true,finalize:true}),r=await h.run();
 assert.equal(r.state,"BLOCKED");assert.equal(r.postAttempted,false);assert.equal(h.calls.post,0);
 assert.equal(h.calls.mark,1);assert.equal(h.calls.fee,2);assert.ok(!JSON.stringify(r).includes("SECRET"));
 const transport=harness({reject:true,finalize:true}),unknown=await transport.run();
 assert.equal(unknown.state,"UNKNOWN");assert.equal(unknown.postAttempted,true);
});

test("durable local result is exact-object/scope branded; forged or ambiguous results cannot bypass sticky hold",async()=>{
 const h=harness({commitDelayMs:5000,finalize:true}),r=await h.run();
 const scope={ownerId:OWNER,accountId:identity.accountId,reservationId:RES};
 assert.equal(isDurableProtectiveExitNoSend(r,scope),true);assert.ok(Object.isFrozen(r));
 for(const forged of [{...r},JSON.parse(JSON.stringify(r)),{state:"BLOCKED",reason:r.reason},null])
  assert.equal(isDurableProtectiveExitNoSend(forged,scope),false);
 for(const change of [{ownerId:"other"},{accountId:"other"},{reservationId:"other"}])
  assert.equal(isDurableProtectiveExitNoSend(r,{...scope,...change}),false);
 const unknown=await harness({commitDelayMs:5000,finalize:true,finalizeFail:"commit"}).run();
 assert.equal(isDurableProtectiveExitNoSend(unknown,scope),false);
});

import {reconcileOwnedProtectiveExitOutcome} from "./ownedProtectiveExitOutcome";
import {TechnicalReleaseEntryGate} from "./technicalReleaseEntryGate";
import {reconciledFlatEntryEvidence} from "./reconciledFlatEntryEvidence";
import type {Snapshot} from "../v13-production/types";
test("composed main-owned flow retains reconciliation hold, exits with fresh ID and resumes only from signed flat valid gates",async()=>{
 const technical=new TechnicalReleaseEntryGate();const state={entriesAuthorized:true};
 const source:Snapshot={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:"test"},observedAtMs:1000,
  authenticated:true,complete:true,cashExact:true,historyFromMs:0,cashMicros:"25000000",orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
 const reconcile=async(flat:boolean,approved=true,failed=false)=>{
  if(failed)throw Error("signed reconciliation unavailable");
  const snapshot={...source,positions:flat?[]:[{market:MARKET,side:"YES" as const,quantityHundredths:"200"}]};
  const valid=await reconciledFlatEntryEvidence({query:async()=>({rows:[{reserved_micros:flat?"0":"30000",cash_micros:source.cashMicros,
   blocked_reason:null,kill_switch:false,execution_enabled:true,unresolved:"0",exits:"0",positions:flat?"0":"1"}]})},
   {ownerId:OWNER,accountId:identity.accountId,snapshot,nowMs:1000});
  technical.completeReconciliation(approved&&valid);
 };
 const accept=(r:Awaited<ReturnType<typeof dispatchReviewedProtectiveExitOnce>>,rid:string,read:()=>Promise<void>)=>
  reconcileOwnedProtectiveExitOutcome({outcome:r,ownerId:OWNER,accountId:identity.accountId,reservationId:rid,
   technicalRelease:technical,state,reconcile:read});
 technical.beginReconciliation();const expired=harness({commitDelayMs:5000,finalize:true}),blocked=await expired.run();
 await accept(blocked,RES,()=>reconcile(false));assert.equal(expired.calls.post,0);assert.equal(state.entriesAuthorized,true);
 assert.equal(technical.mayEnter(state.entriesAuthorized,false),false,"owned exposure keeps entry held");
 // Next worker iteration creates a distinct identity, never replays the old one.
 const nextId="v13p-44444444-4444-4444-8444-444444444444",nextReservation="55555555-5555-4555-8555-555555555555";
 technical.beginReconciliation();const fresh=harness({clientOrderId:nextId,reservationId:nextReservation,fill:"2.00",initialPosition:"2.00"});
 const closed=await fresh.run();assert.equal(closed.state,"RECONCILED");assert.equal(fresh.calls.post,1);
 await accept(closed,nextReservation,()=>reconcile(true));assert.equal(technical.mayEnter(state.entriesAuthorized,false),true);
 await expired.run();assert.equal(expired.calls.post,0,"old ID permanently non-replayable");
 await reconcile(true,false);assert.equal(technical.mayEnter(state.entriesAuthorized,false),false,"revoked release never reopens");
 technical.beginReconciliation();await assert.rejects(accept(blocked,RES,()=>reconcile(true,true,true)));
 await reconcile(true);assert.equal(technical.mayEnter(state.entriesAuthorized,false),false,"reconciliation failure remains sticky");
});

test("production outcome helper rejects forged/uncertain results and never enables an entry",async()=>{
 const r=await harness({commitDelayMs:5000,finalize:true}).run();
 for(const outcome of [{...r},await harness({reject:true}).run(),await harness({commitDelayMs:5000,finalize:true,finalizeFail:"commit"}).run()]){
  const gate=new TechnicalReleaseEntryGate(),state={entriesAuthorized:true};let reads=0;gate.completeReconciliation(true);
  await assert.rejects(reconcileOwnedProtectiveExitOutcome({outcome,ownerId:OWNER,accountId:identity.accountId,reservationId:RES,
   technicalRelease:gate,state,reconcile:async()=>{reads++;}}));
  assert.equal(reads,0);assert.equal(state.entriesAuthorized,false);assert.equal(gate.mayEnter(true,false),false);
 }
});
