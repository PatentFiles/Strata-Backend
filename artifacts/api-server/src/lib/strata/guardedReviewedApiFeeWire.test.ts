import test from "node:test";
import assert from "node:assert/strict";
import {createGuardedReviewedApiFeeFetch,FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL} from "./guardedReviewedApiFeeWire";
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from "./apiFeeSourceStage";
const owner="11111111-1111-4111-8111-111111111111";
const grant="55555555-5555-4555-8555-555555555555";
const account="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const policyHash="b".repeat(64);
const signer="c".repeat(64);
const token=7;
const leaseHolder="personal-11111111-1111-4111-8111-111111111111";
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
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,token,leaseHolder);
 await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify({...order,reduce_only:false})}),
  /new_entry_blocked/);
 assert.equal(sent,0);
});
test("refuses any invalid order shape, scope, URL or unsourced grant",async()=>{
 let sent=0;
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 assert.throws(()=>createGuardedReviewedApiFeeFetch(owner,account,"http://malicious",transport,policyHash,signer,token,leaseHolder),/source_url_invalid/);
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,token,leaseHolder);
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
   feePolicyVersion:API_SOURCE_POLICY_VERSION,
   formulaVersion:API_SOURCE_FORMULA_VERSION,
   marketTicker:ticker,verifiedAtMs:Date.now(),
  }};
 };
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,token,leaseHolder,{
  connect:(async()=>db) as never, verify:grantProof as never,
  verifyMonetary:(async(_stage:string,market:string)=>{
    assert.equal(market,ticker);
    calls.push("MONETARY");
    return {ok:true,reason:"provider_monetary_fee_schedule_and_market_verified",marketTicker:ticker};
  }) as never,
 });
 await wrapped(url,{method:"POST",body:JSON.stringify(order)});
 assert.equal(sent,1);assert.equal(released,1);
 assert.ok(calls.indexOf("MONETARY")>calls.indexOf("BEGIN"));
 assert.ok(calls.indexOf("VERIFIED")>calls.indexOf("MONETARY"));
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
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,token,leaseHolder,{
  connect:(async()=>db) as never,
  verify:(async()=>({ok:false,reason:"fee_review_missing"})) as never,
 });
 await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify(order)}));
 assert.equal(sent,0);
 assert.ok(calls.includes("ROLLBACK"));
 assert.equal(calls.at(-1),"RELEASE");
});

test("final SQL account fence requires exactly the canonical V2 fee source version",()=>{
 assert.equal(API_SOURCE_POLICY_VERSION,"strata_api_fee_source_signed_review_v2");
 assert.equal(API_SOURCE_FORMULA_VERSION,"standard-quadratic-0.07-v1");
 assert.ok(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL.includes(
   "p.fee_formula_version='"+API_SOURCE_FORMULA_VERSION+"'"
 ));
 assert.ok(!FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL.includes("standard_quadratic_0.07_round_cent_v1"));

 assert.ok(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL.includes(
   "p.fee_policy_version='"+API_SOURCE_POLICY_VERSION+"'"
 ));
 assert.ok(!FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL.includes(
   "strata_api_fee_source_signed_review_v1"
 ));
});

test("final transaction refuses revoked signer, closed account or global kill before any POST",async()=>{
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/a\.commissioned=true/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/a\.kill_switch=false/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/live\.manual_kill_switch=false/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/live\.live_execution_enabled=true/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/c\.revoked_at IS NULL/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/p\.policy_hash=\$4/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/lease\.fencing_token=\$6::bigint/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/lease\.holder_id=\$7/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/lease\.state=\x27owned\x27/);
 assert.match(FINAL_REVIEWED_API_ACCOUNT_FENCE_SQL,/FOR SHARE OF a,p,live,c,lease/);
 let sent=0,verified=0,rolledBack=0,released=0;
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 const db={query:async(sql:string)=>{
  if(sql.startsWith("ROLLBACK"))rolledBack++;
  return {rows:[]}; // no matched account: closed/stale state
 },release:()=>{released++}};
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,policyHash,signer,token,leaseHolder,{
  connect:(async()=>db) as never,
  verify:(async()=>{verified++;return {ok:true}}) as never,
 });
 await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify(order)}),
  /api_fee_final_account_signer_or_kill_closed/);
 assert.equal(sent,0);assert.equal(verified,0);
 assert.equal(rolledBack,1);assert.equal(released,1);
});

test("Request-object and mixed-case POST cannot bypass signed order fence",async()=>{
 let sent=0;
 const transport=(async()=>{sent++;return new Response("{}");}) as typeof fetch;
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,
   policyHash,signer,token,leaseHolder);
 await assert.rejects(wrapped(new Request(url,{method:"POST",body:JSON.stringify(order)})),
   /api_fee_unexpected_order_endpoint/);
 for(const method of ["post","PoSt","pOsT"]){
   await assert.rejects(wrapped(url,{method,body:JSON.stringify(order)}),
    /api_fee_unexpected_order_endpoint/);
 }
 await assert.rejects(wrapped(url,{method:"PATCH",body:"{}"}),
   /api_fee_unsupported_exchange_method/);
 assert.equal(sent,0);
});

test("only canonical Kalshi order cancellations may bypass fee-POST fence",async()=>{
 const calls:string[]=[];
 const transport=(async(_req,_init)=>{calls.push("DELETE");return new Response("{}");}) as typeof fetch;
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,
   policyHash,signer,token,leaseHolder);
 const path="https://external-api.kalshi.com/trade-api/v2/portfolio/orders/a0123456-abcdef";
 await wrapped(path,{method:"DELETE"});
 await wrapped("https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders/a0123456?market_ticker="+ticker,
   {method:"DELETE"});
 for(const target of [
   "https://untrusted.example/trade-api/v2/portfolio/orders/a0123456",
   "https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders",
   "https://external-api.kalshi.com/trade-api/v2/portfolio/withdrawals/abc",
 ]){
   await assert.rejects(wrapped(target,{method:"DELETE"}),
    /api_fee_unexpected_(?:cancel|read)_endpoint/);
 }
 assert.equal(calls.length,2);
});


test("signed GET and HEAD requests are limited to canonical Kalshi API paths",async()=>{
 let sent=0;
 const transport=(async(req:unknown,init?:RequestInit)=>{
   sent++;
   assert.equal(init?.redirect,"error");
   return new Response("{}",{status:200});
 }) as typeof fetch;
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,transport,
   policyHash,signer,token,leaseHolder);
 const official=[
   "https://external-api.kalshi.com/trade-api/v2/portfolio/positions?subaccount=1&exchange_index=2",
   "https://external-api.kalshi.com/trade-api/v2/series/KXBTC15M",
   "https://external-api.kalshi.com/trade-api/v2/events/KXBTC15M-26OCT18T0325",
 ];
 await wrapped(official[0]!,{method:"GET"});
 await wrapped(new Request(official[1]!,{method:"GET"}));
 await wrapped(official[2]!,{method:"HEAD",redirect:"follow"});
 assert.equal(sent,3);
 for(const url of [
   "https://evil.example/trade-api/v2/portfolio/positions",
   "http://external-api.kalshi.com/trade-api/v2/portfolio/positions",
   "https://external-api.kalshi.com.evil.example/trade-api/v2/portfolio/positions",
   "https://user:pass@external-api.kalshi.com/trade-api/v2/portfolio/positions",
   "https://external-api.kalshi.com:444/trade-api/v2/portfolio/positions",
   "https://external-api.kalshi.com/not-the-api/portfolio/positions",
   "https://external-api.kalshi.com/trade-api/v2/portfolio%2fpositions",
   "https://external-api.kalshi.com/trade-api/v2/portfolio/%2e%2e/admin",
   "https://external-api.kalshi.com/trade-api/v2//portfolio/positions",
 ]){
  await assert.rejects(wrapped(url,{method:"GET"}),/api_fee_unexpected_read_endpoint/);
 }
 await assert.rejects(wrapped(new Request("https://evil.example/steal",{method:"HEAD"})),
    /api_fee_unexpected_read_endpoint/);
 assert.equal(sent,3,"no signed request reaches an unexpected origin");
});

test("reviewed API-source order does not depend on Kalshi PDF fetch once independently signed grant is verified",async()=>{
 let sent=0,reviewChecks=0;
 const sequence:string[]=[];
 const db={
  async query(sql:string){
   sequence.push(sql==="COMMIT"?"COMMIT":sql==="BEGIN"?"BEGIN":"SQL");
   return {rows:sql.includes("SELECT a.id")?[{id:account}]:[]};
  },
  release(){sequence.push("RELEASE");},
 };
 const verified=async()=>{reviewChecks++;sequence.push("REVIEWED_API");
  return {ok:true,reason:"reviewed_api_fee_source_stage_current",identity:{
   grantId:grant,sourceUrl:source,digest:"a".repeat(64),
   feePolicyVersion:API_SOURCE_POLICY_VERSION,
   formulaVersion:API_SOURCE_FORMULA_VERSION,
   marketTicker:ticker,verifiedAtMs:Date.now(),
  }};
 };
 const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,
  (async()=>{sent++;sequence.push("POST");return new Response("{}");}) as typeof fetch,
  policyHash,signer,token,leaseHolder,{
   connect:(async()=>db) as never,
   verify:verified as never,
   // No PDF verifier is injected. The strictly authenticated, signed
   // reviewed API stage must be the sole monetary-model proof.
  });
 await wrapped(url,{method:"POST",body:JSON.stringify(order)});
 assert.equal(reviewChecks,1);assert.equal(sent,1);
 assert.ok(sequence.indexOf("POST")>sequence.indexOf("REVIEWED_API"));
 assert.ok(sequence.indexOf("COMMIT")>sequence.indexOf("POST"));
});

test("reviewed API grant with incorrect formula or digest cannot submit an order",async()=>{
 for(const bad of [
  {formulaVersion:"unapproved",digest:"a".repeat(64)},
  {formulaVersion:API_SOURCE_FORMULA_VERSION,digest:"tampered"},
 ]){
  let sent=0;
  const db={query:async(sql:string)=>({rows:sql.includes("SELECT a.id")?[{id:account}]:[]}),release(){}};
  const wrapped=createGuardedReviewedApiFeeFetch(owner,account,source,
    (async()=>{sent++;return new Response("{}");}) as typeof fetch,
    policyHash,signer,token,leaseHolder,{
    connect:(async()=>db) as never,
    verify:(async()=>({ok:true,identity:{
     grantId:grant,sourceUrl:source,marketTicker:ticker,
     feePolicyVersion:API_SOURCE_POLICY_VERSION,
     formulaVersion:bad.formulaVersion,digest:bad.digest,
    }})) as never,
  });
  await assert.rejects(wrapped(url,{method:"POST",body:JSON.stringify(order)}),/grant_or_market_closed/);
  assert.equal(sent,0);
 }
});
