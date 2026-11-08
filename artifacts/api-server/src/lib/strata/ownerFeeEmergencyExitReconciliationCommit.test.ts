import assert from "node:assert/strict";
import test from "node:test";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";
import {createHash,generateKeyPairSync} from "node:crypto";
import {readAuthenticatedProtectiveExitOutcome} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
const OWNER="11111111-1111-4111-8111-111111111111";
const RES="22222222-2222-4222-8222-222222222222";
const CID="v13p-33333333-3333-4333-8333-333333333333";
const MARKET="KXBTC15M-26OCT191545-45";
const NOW=1792440000000;
const privateKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
const input={ownerId:OWNER,accountId:"owner-execution-2",reservationId:RES,
 material:{keyId:"ephemeral-test-only",privateKey},
 order:{ticker:MARKET,client_order_id:CID,count:"2.00",side:"ask",price:"0.5500",
  reduce_only:true,post_only:false,time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",subaccount:1,exchange_index:2}};
function observation(fill="1.00"):IocRecoveryObservation{
 const remaining=(2-Number(fill)).toFixed(2),after=(3-Number(fill)).toFixed(2);
 return {clientOrderId:CID,requestedCountFp:"2.00",marketTicker:MARKET,
  positionMarketTicker:MARKET,initialPositionFp:"3.00",
  observedPositionFp:after,reducingBookSide:"ask",
  completeExchangeHistory:true,exactMarketAndAccountMatched:true,
  orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
  response:{httpStatus:201,order_id:"order-1",client_order_id:CID,
    fill_count:fill,remaining_count:remaining,ts_ms:1792440000000}};
}
async function authenticatedObservation(obs:IocRecoveryObservation):Promise<IocRecoveryObservation>{
 const filled=String(obs.response!.fill_count);
 return readAuthenticatedProtectiveExitOutcome(input,obs.response,{
  now:()=>NOW,monotonicNow:()=>1000,
  db:{query:async()=>({rows:[{initial_position_fp:"3.00",position_observed_at_ms:NOW-200,
   order_digest:createHash("sha256").update(JSON.stringify(input.order)).digest("hex")}]})},
  readFeeds:async(_material,observedAtMs)=>({ok:true,historicalCoverageComplete:true,observedAtMs,cashMicros:"0",settlements:[],
   positions:[{ticker:MARKET,position_fp:obs.observedPositionFp}],
   orders:[{order_id:"order-1",client_order_id:CID,ticker:MARKET,book_side:"ask",yes_price_dollars:"0.5500",
    subaccount_number:1,exchange_index:2,created_time:new Date(NOW-100).toISOString(),
    status:filled==="2.00"?"executed":"canceled",initial_count_fp:"2.00",fill_count_fp:filled,remaining_count_fp:"0.00"}],
   fills:filled==="0.00"?[]:[{trade_id:"fill-1",order_id:"order-1",ticker:MARKET,count_fp:filled,
    subaccount_number:1,exchange_index:2,created_time:new Date(NOW).toISOString()}],
  }),
 });
}
function harness(opts:{noLock?:boolean;badBaseline?:boolean;duplicate?:boolean;
 failAt?:"SELECT"|"INSERT"|"UPDATE"|"COMMIT"}={}){
 const events:string[]=[];
 let phase="UNKNOWN",pendingPhase="UNKNOWN";
 const client={query:async(sql:string,params?:unknown[])=>{
  const tag=sql.startsWith("SELECT")?"SELECT":sql.startsWith("INSERT")?"INSERT":
   sql.startsWith("UPDATE")?"UPDATE":sql;
  events.push(tag);
  if(opts.failAt===tag)throw Error("database_failure");
  if(tag==="SELECT"){
   assert.match(sql,/FOR UPDATE OF r/);
   assert.match(sql,/r.state='UNKNOWN'/);
   assert.equal(params?.[0],RES);
   if(opts.noLock||phase!=="UNKNOWN")return {rows:[]};
   return {rows:[{reservation_id:RES,initial_position_fp:
     opts.badBaseline?"5.00":"3.00",quantity_hundredths:"200",reducing_side:"YES"}]};
  }
  if(tag==="INSERT"){
   assert.match(sql,/ON CONFLICT DO NOTHING/);
   if(opts.duplicate)return {rows:[]};
   return {rows:[{reservation_id:RES}]};
  }
  if(tag==="UPDATE"){
   assert.match(sql,/state='RECONCILED'/);
   assert.match(sql,/state='UNKNOWN'/);
   pendingPhase="RECONCILED";return {rows:[{reservation_id:RES}]};
  }
  if(tag==="COMMIT")phase=pendingPhase;
  if(tag==="ROLLBACK")pendingPhase=phase;
  return {rows:[]};
 },release:()=>events.push("RELEASE")};
 const db={connect:async()=>client};
 const run=async(obs=observation())=>persistAuthenticatedExitReconciliation(input,await authenticatedObservation(obs),{db});
 const runRaw=(obs:IocRecoveryObservation)=>persistAuthenticatedExitReconciliation(input,obs,{db});
 return {run,runRaw,events,phase:()=>phase};
}
test("authenticated zero partial full fill records one immutable audit and terminal transition",async()=>{
 for(const fill of ["0.00","1.00","2.00"]){
  const h=harness();
  const result=await h.run(observation(fill));
  assert.equal(result.committed,true);
  assert.equal(result.tradingAuthorized,false);
  assert.equal(result.mayRetry,false);
  assert.deepEqual(h.events.filter(x=>["SELECT","INSERT","UPDATE","COMMIT"].includes(x)),
    ["SELECT","INSERT","UPDATE","COMMIT"]);
  assert.equal(h.phase(),"RECONCILED");
  const repeated=await h.run(observation(fill));
  assert.equal(repeated.committed,false);
 }
});
test("duplicate, changed baseline or db outage leaves state unreconciled and no retries",async()=>{
 for(const options of [{noLock:true},{badBaseline:true},{duplicate:true},
   {failAt:"SELECT" as const},{failAt:"INSERT" as const},
   {failAt:"UPDATE" as const},{failAt:"COMMIT" as const}]){
  const h=harness(options),result=await h.run();
  assert.equal(result.committed,false);
  assert.equal(result.tradingAuthorized,false);
  assert.equal(result.mayRetry,false);
  assert.ok(h.events.includes("ROLLBACK"));
  assert.equal(h.events.at(-1),"RELEASE");
 }
});
test("ambiguous fills and wrong identities never touch database",async()=>{
 for(const bad of [{...observation(),clientOrderId:"other"},
   {...observation(),completeExchangeHistory:false},
   {...observation(),isolatedPositionDelta:false},
   {...observation(),observedPositionFp:"3.00"},
   {...observation(),response:null}]){
  const h=harness(),result=await h.runRaw(bad);
  assert.equal(result.committed,false);
  assert.equal(h.events.length,0);
 }
});
test("internally consistent caller-created observation still lacks authenticated deadline provenance",async()=>{
 const h=harness(),result=await h.runRaw(observation());
 assert.equal(result.committed,false);assert.equal(result.commitState,"NOT_ATTEMPTED");
 assert.equal(result.reason,"exit_reconcile_freshness_unverified");assert.equal(h.events.length,0);
});
