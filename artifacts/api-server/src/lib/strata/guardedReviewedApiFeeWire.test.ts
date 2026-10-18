import test from "node:test";
import assert from "node:assert/strict";
import {createGuardedReviewedApiFeeFetch,FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL} from "./guardedReviewedApiFeeWire";
const owner="11111111-1111-4111-8111-111111111111";
const grant="55555555-5555-4555-8555-555555555555";
const account="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const policyHash="b".repeat(64);
const signer="c".repeat(64);
const source="strata-api-reviewed://kxbtc15m/"+grant;
const ticker="KXBTC15M-26OCT18T0325";
const url="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders";
const order={
 ticker,subaccount:1,exchange_index:2,reduce_only:true,
 time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",
 post_only:false,client_order_id:"v13p-88888888-8888-4888-8888-888888888888",
 side:"bid",count:"1.00",price:"0.5500",
};
test("never sends an unreviewed new entry even if all other permissions are claimed",async()=>{
 let sent=0;
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer);
 await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify({...order,reduce_only:false})}),
  /new_entry_blocked/);
 assert.equal(sent,0);
});
test("refuses any invalid order shape, scope, URL or unsourced grant",async()=>{
 let sent=0;
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 assert.throws(()=>createGuardedReviewedApiFeeFetch(owner,account,"http://malicious",transport,policyHash,signer),/source_url_invalid/);
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer);
 for(const payload of [
  {...order,ticker:"OTHER"},
  {...order,exchange_index:0},
  {...order,subaccount:0},
  {...order,post_only:true},
  {...order,time_in_force:"good_til_cancelled"},
  {...order,client_order_id:"fake"},
  {...order,price:"1.0000"},
 ]){
  await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify(payload)}));
 }
 await assert.rejects(wrapped(url+"?unsafe=true",{method:"POST",body:JSON.stringify(order)}));
 assert.equal(sent,0);
});
test("a reduce-only IOC needs independently current exact-market stage and held transaction",async()=>{
 let sent=0,released=0;
 const calls:string[]=[];
 const transport=(async()=>{sent++;calls.push("POST");return new Response("{}");}) as typeof fetch;
 const db={
  query:async(sql:string)=>{calls.push(sql==="BEGIN"?"BEGIN":sql.startsWith("COMMIT")?"COMMIT":
   sql.startsWith("ROLLBACK")?"ROLLBACK":"QUERY");return {rows:sql.includes("SELECT a.id")?[{id:account}]:[]}},
  release:()=>{released++},
 };
 const grantProof=async(_owner:string,_stage:string,_source:string|undefined,market:string|undefined)=>{
  assert.equal(market,ticker);
  calls.push("VERIFIED");
  return {ok:true,reason:"reviewed_api_fee_source_stage_current",identity:{
   grantId:grant,sourceUrl:source,digest:"a".repeat(64),
   feePolicyVersion:"strata_api_fee_source_signed_review_v1",
   formulaVersion:"standard_quadratic_0.07_round_cent_v1",
   marketTicker:ticker,verifiedAtMs:Date.now(),
  }};
 };
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,{
  connect:(async()=>db) as never, verify:grantProof as never,
 });
 await wrapped(url,{method:"POST",body:JSON.stringify(order)});
 assert.equal(sent,1);assert.equal(released,1);
 assert.ok(calls.indexOf("VERIFIED")>calls.indexOf("BEGIN"));
 assert.ok(calls.indexOf("POST")>calls.indexOf("VERIFIED"));
 assert.ok(calls.indexOf("COMMIT")>calls.indexOf("POST"));
});
test("a missing grant must ROLLBACK and never call Kalshi POST",async()=>{
 let sent=0;
 const calls:string[]=[];
 const db={query:async(sql:string)=>{calls.push(sql==="BEGIN"?"BEGIN":
  sql.startsWith("ROLLBACK")?"ROLLBACK":"OTHER");return {rows:[]}},
  release:()=>{calls.push("RELEASE")}};
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,{
  connect:(async()=>db) as never,
  verify:(async()=>({ok:false,reason:"fee_review_missing"})) as never,
 });
 await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify(order)}));
 assert.equal(sent,0);
 assert.ok(calls.includes("ROLLBACK"));
 assert.equal(calls.at(-1),"RELEASE");
});

test("final transaction refuses revoked signer, closed account or global kill before any POST",async()=>{
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/a\.commissioned=true/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/a\.kill_switch=false/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/live\.manual_kill_switch=false/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/live\.live_execution_enabled=true/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/c\.revoked_at IS NULL/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/p\.policy_hash=\$4/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/FOR SHARE OF a,p,live,c/);
 let sent=0,verified=0,rolledBack=0,released=0;
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 const db={query:async(sql:string)=>{
  if(sql.startsWith("ROLLBACK"))rolledBack++;
  return {rows:[]}; // no matched account: closed/stale state
 },release:()=>{released++}};
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,{
  connect:(async()=>db) as never,
  verify:(async()=>{verified++;return {ok:true}}) as never,
 });
 await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify(order)}),
  /api_fee_final_account_signer_or_kill_closed/);
 assert.equal(sent,0);assert.equal(verified,0);
 assert.equal(rolledBack,1);assert.equal(released,1);
});
