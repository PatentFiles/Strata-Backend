import assert from "node:assert/strict";
import test from "node:test";
import {verifyReviewedProtectiveExitFee} from "./reviewedProtectiveExitFee";
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256} from "./apiFeeRateReference";
const owner="11111111-1111-4111-8111-111111111111";
const account="owner-execution-2";
const market="KXBTC15M-26OCT191945-45";
const grant="55555555-5555-4555-8555-555555555555";
const observed=Date.parse("2026-10-19T23:45:00.000Z");
function harness(input:{approved?:boolean;provider?:boolean;stale?:boolean;readThrows?:boolean}={}){
 const events:string[]=[];
 const db={query:async(sql:string,args:unknown[])=>{
  events.push("SIGNED_DB");
  assert.match(sql,/r\.revoked_at IS NULL/);
  assert.match(sql,/r\.reviewer_user_id<>a\.owner_user_id/);
  assert.match(sql,/g\.rate_decision_digest=\$5::text/);
  assert.match(sql,/g\.policy_version=\$3::text/);
  assert.match(sql,/a\.kill_switch=false/);
  assert.equal(args[0],account);
  assert.equal(args[1],owner);
  assert.equal(args[4],PDF_FREE_API_RATE_REVIEW_DECISION_SHA256);
  if(input.readThrows)throw Error("no_db");
  return {rows:input.approved===false?[]:[{grant_id:grant}]};
 }};
 const readFee=async(ticker:string)=>{
  events.push("PROVIDER_GET");
  assert.equal(ticker,market);
  return input.provider===false?
   {ok:false,reason:"provider_unavailable"} as const:
   {ok:true,marketTicker:ticker,marketOpen:true,
    observedAtMs:input.stale?observed-5000:observed,
    fingerprint:"a".repeat(64)} as const;
 };
 return {events,run:()=>verifyReviewedProtectiveExitFee(owner,account,market,{
  db,readFee:readFee as never,now:()=>observed,
 })};
}
test("approved historical owner-model plus fresh official exact-market proof qualifies source only",async()=>{
 const h=harness(),r=await h.run();
 assert.equal(r.ok,true);
 assert.equal(r.monetaryFeeAuthorized,true);
 assert.equal(r.marketTicker,market);
 assert.equal(r.tradingAuthorized,false);
 assert.equal(r.policyApproved,false);
 assert.deepEqual(h.events,["SIGNED_DB","PROVIDER_GET"]);
});
test("no independent reviewer, no model approval, no provider probe",async()=>{
 const h=harness({approved:false}),r=await h.run();
 assert.equal(r.ok,false);
 assert.equal(r.monetaryFeeAuthorized,false);
 assert.deepEqual(h.events,["SIGNED_DB"]);
});
test("missing original review table blocks protective submission and provider probe",async()=>{
 const h=harness({readThrows:true}),r=await h.run();
 assert.equal(r.ok,false);
 assert.equal(r.reason,"protective_fee_historic_review_unavailable");
 assert.deepEqual(h.events,["SIGNED_DB"]);
});
test("stale or missing official fee market does not authorize source",async()=>{
 for(const opt of [{provider:false},{stale:true}]){
  const h=harness(opt),r=await h.run();
  assert.equal(r.ok,false);
  assert.equal(r.monetaryFeeAuthorized,false);
 }
});
test("foreign owner, malformed ticker, invalid account are rejected before DB",async()=>{
 let queries=0;
 for(const [o,a,m] of [["not-owner",account,market],[owner,"",market],[owner,account,"OTHER"]]){
  const r=await verifyReviewedProtectiveExitFee(o,a,m,{
   db:{query:async()=>{queries++;return {rows:[{grant_id:grant}]}}}
  });
  assert.equal(r.ok,false);
 }
 assert.equal(queries,0);
});
