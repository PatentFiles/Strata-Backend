import assert from "node:assert/strict";
import test from "node:test";
import {verifyReviewedProtectiveExitFee,verifyReviewedProtectiveExitFeeAuthority} from "./reviewedProtectiveExitFee";
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256} from "./apiFeeRateReference";
const owner="11111111-1111-4111-8111-111111111111";
const account="owner-execution-2";
const market="KXBTC15M-26OCT191945-45";
const grant="55555555-5555-4555-8555-555555555555";
const observed=Date.parse("2026-10-19T23:45:00.000Z");
function harness(input:{approved?:boolean;provider?:boolean;stale?:boolean;readThrows?:boolean}={}){
 const events:string[]=[];
 const db={query:async(sql:string,args:unknown[])=>{
  if(sql.includes("AS standing_history"))return {rows:[{standing_history:false}]};
  events.push("SIGNED_DB");
  assert.match(sql,/r\.revoked_at IS NULL/);
  assert.match(sql,/r\.expires_at>clock_timestamp\(\)/);
  assert.match(sql,/g\.revoked_at IS NULL/);
  assert.match(sql,/c\.revoked_at IS NULL/);
  assert.match(sql,/r\.reviewer_user_id<>a\.owner_user_id/);
  assert.match(sql,/g\.rate_decision_digest=\$5::text/);
  assert.match(sql,/g\.policy_version=\$3::text/);
  assert.match(sql,/a\.kill_switch=false/);
  assert.equal(args[0],account);
  assert.equal(args[1],owner);
  assert.equal(args[4],PDF_FREE_API_RATE_REVIEW_DECISION_SHA256);
  if(input.readThrows)throw Error("no_db");
  return {rows:input.approved===false?[]:[{grant_id:grant,legacy_valid:true,valid_for_ms:60000}]};
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
  db,readFee:readFee as never,now:()=>observed,sha:()=>"a".repeat(40),
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
   db:{query:async()=>{queries++;return {rows:[{grant_id:grant,legacy_valid:true,valid_for_ms:60000}]}}}
  });
  assert.equal(r.ok,false);
 }
 assert.equal(queries,0);
});

test("completion clock allows genuinely fresh proof after slow DB and provider, but never retimestamps it",async()=>{
 for(const elapsed of [0,3001,10000]){
  let time=observed;
  const r=await verifyReviewedProtectiveExitFee(owner,account,market,{
   sha:()=>"a".repeat(40),now:()=>time,
   db:{query:async sql=>{time=observed+elapsed;return {rows:sql.includes("AS standing_history")?[{standing_history:false}]:[{grant_id:grant,legacy_valid:true,valid_for_ms:60000}]};}},
   readFee:async()=>({ok:true,marketTicker:market,marketOpen:true,observedAtMs:time,fingerprint:"a".repeat(64)}) as never,
  });
  assert.equal(r.ok,true);assert.equal(r.verifiedAt,new Date(observed+elapsed).toISOString());
 }
});
test("completion clock rejects stale, future, rollback, nonfinite and thrown provider",async()=>{
 for(const kind of ["stale","future","rollback","nonfinite","throw"]){
  let time=observed;
  const r=await verifyReviewedProtectiveExitFee(owner,account,market,{
   sha:()=>"a".repeat(40),now:()=>time,
   db:{query:async sql=>({rows:sql.includes("AS standing_history")?[{standing_history:false}]:[{grant_id:grant,legacy_valid:true,valid_for_ms:60000}]})},
   readFee:async()=>{
    if(kind==="throw")throw Error("SECRET_DO_NOT_LEAK");
    time=kind==="rollback"?observed-1:kind==="nonfinite"?NaN:observed+5000;
    return {ok:true,marketTicker:market,marketOpen:true,observedAtMs:kind==="future"?time+3001:observed,fingerprint:"a".repeat(64)} as never;
   },
  });
  assert.equal(r.ok,false,kind);assert.doesNotMatch(r.reason,/SECRET/);
 }
});

test("authority rejects unknown history and invalid expiry budgets",async()=>{
 for(const standing of [false,true])for(const budget of [undefined,null,NaN,Infinity,-1,0,"60000"]){
  const result=await verifyReviewedProtectiveExitFeeAuthority(owner,account,"a".repeat(40),{
   query:async sql=>({rows:sql.includes("AS standing_history")?[{standing_history:standing}]:
    sql.includes("SELECT d.delegation_id")?[{valid_for_ms:budget}]:[{grant_id:grant,legacy_valid:true,valid_for_ms:budget}]}),
  });assert.equal(result.ok,false,`${standing}/${budget}`);
 }
 const unknown=await verifyReviewedProtectiveExitFeeAuthority(owner,account,"a".repeat(40),{
  query:async sql=>({rows:sql.includes("AS standing_history")?[{standing_history:"true"}]:[{grant_id:grant,legacy_valid:true,valid_for_ms:60000}]}),
 });assert.equal(unknown.ok,false);assert.equal(unknown.reason,"protective_fee_standing_history_unknown");
});
test("authority caps positive DB lifetime and refuses excessive original lineage",async()=>{
 const result=await verifyReviewedProtectiveExitFeeAuthority(owner,account,"a".repeat(40),{
  query:async sql=>({rows:sql.includes("AS standing_history")?[{standing_history:false}]:[{grant_id:grant,legacy_valid:true,valid_for_ms:7200000}]}),
 });assert.equal(result.ok,true);assert.equal(result.validForMs,3600000);
 let queries=0;
 const excessive=await verifyReviewedProtectiveExitFeeAuthority(owner,account,"a".repeat(40),{
  query:async()=>{queries++;return {rows:Array.from({length:65},(_,i)=>({grant_id:grant,review_id:String(i),legacy_valid:true,valid_for_ms:60000}))};},
 });assert.equal(excessive.ok,false);assert.equal(queries,1);
});
