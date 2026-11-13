import assert from "node:assert/strict";
import test from "node:test";
import {inspectSingleOwnerFeePreflight} from "./singleOwnerFeePreflight";
import type {MonetaryFeeEvidenceContract} from "./monetaryFeeContract";

const OWNER="11111111-1111-4111-8111-111111111111";
const DIGEST="a".repeat(64);
const SHA="b".repeat(40);
const good:MonetaryFeeEvidenceContract={
 ok:true,reason:"provider_monetary_fee_schedule_and_market_verified",stage:"STEP_9",
 marketTicker:"KXBTC15M-TEST",sourceDigest:DIGEST,verifiedAt:new Date().toISOString(),
 monetaryFeeAuthorized:true,policyApproved:false,tradingAuthorized:false,
};
const account={
 id:"strata-owner-test",commissioned:true,execution_enabled:false,kill_switch:true,
 blocked_reason:null,subaccount:1,exchange_index:2,
 fee_policy_version:"micro-live-standing-fee-policy-v1",policy_state:"APPROVED",
 configured_stake_cents:500,lease_state:"released",arm_requested:false,
 lease_account_kill:false,max_entry_stake_cents:500,max_entry_all_in_cents:550,
};
const make=(row:Record<string,unknown>|null=account,
  opts:{schema?:boolean;receipt?:boolean;readFailure?:boolean}={})=>{
 const sqls:string[]=[];
 const db={query:async(sql:string,args:unknown[])=>{
   sqls.push(sql);
   assert.ok(/^\s*SELECT\b/i.test(sql),"read-only query required");
   if(sql.includes("to_regclass")){
     assert.match(sql,/strata_owner_fee_v3_immutable_guard/);
     assert.match(sql,/pg_catalog\.pg_trigger/);
     assert.deepEqual(args,[]);
     if(opts.readFailure)throw Error("database unavailable");
     return {rows:[{installed:opts.schema!==false}]};
   }
   if(sql.includes("FROM private.strata_owner_fee_evidence_v3")){
     assert.deepEqual(args,[OWNER,row?.id,SHA]);
     return {rows:opts.receipt?[{attestation_id:"existing-owner-receipt"}]:[]};
   }
   assert.deepEqual(args,[OWNER]);
   return {rows:row?[row]:[]};
 }};
 return {db,sqls};
};
test("owner-scoped official evidence candidate is NOT an authorization or order",async()=>{
 const {db,sqls}=make();
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.equal(out.ok,true);
 assert.equal(out.evidenceVerified,true);
 assert.equal(out.tradingAuthorized,false);
 assert.equal(out.ownerConsentRecorded,false);
 assert.equal(out.sourceGrantRecorded,false);
 assert.equal(out.reviewAuthorityRecorded,false);
 assert.equal(out.ordersSubmitted,false);
 assert.equal(out.sourceDigest,DIGEST);
 assert.equal(sqls.length,3);
 assert.equal(out.v3SchemaInstalled,true);
 assert.equal(out.v3EvidenceReceiptPresent,false);
 assert.match(out.suggestedNextActions.join(","),/owner_fee_v3_evidence_consent_not_recorded/);
 assert.match(out.suggestedNextActions.join(","),/exact_sha_protective_exit_exchange_qualification_required/);
});
test("invalid user cannot even query account or provider",async()=>{
 let called=false;
 const out=await inspectSingleOwnerFeePreflight("foreign-account-id",{
   db:{query:async()=>{called=true;return {rows:[]}}},
   observe:async()=>{called=true;return good},
 });
 assert.equal(out.ok,false);assert.equal(called,false);
 assert.equal(out.tradingAuthorized,false);
});
test("missing or ambiguous owner account is fail closed",async()=>{
 const {db}=make(null);
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.equal(out.reason,"owned_execution_account_missing_or_ambiguous");
 assert.equal(out.evidenceVerified,false);
});
test("provider failure or tampered source does not verify any authority",async()=>{
 const {db}=make();
 for(const proof of [
   {...good,ok:false},
   {...good,sourceDigest:"invalid"},
   {...good,marketTicker:"KXNOTBTC-TEST"},
   {...good,stage:"ORDER_ENTRY" as const},
   {...good,monetaryFeeAuthorized:false},
 ]) {
   const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>proof,sha:()=>SHA});
   assert.equal(out.ok,false);
   assert.equal(out.tradingAuthorized,false);
   assert.equal(out.sourceGrantRecorded,false);
 }
 const exception=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>{throw Error("429")},sha:()=>SHA});
 assert.equal(exception.reason,"official_monetary_fee_source_unavailable");
});

test("owner preflight surfaces known provider cooldown and market failures without granting authority",async()=>{
 for(const reason of [
   "official_fee_schedule_http_429",
   "official_fee_schedule_formula_unverifiable",
   "official_fee_schedule_unavailable",
   "no_current_open_kxbtc15m_market",
   "market_listing_incomplete",
   "fee_change_schedule_unverified",
 ]){
   const {db}=make();
   const out=await inspectSingleOwnerFeePreflight(OWNER,{
     db,sha:()=>SHA,observe:async()=>({...good,ok:false,reason,
       monetaryFeeAuthorized:false}),
   });
   assert.equal(out.reason,reason);
   assert.equal(out.ok,false);
   assert.equal(out.evidenceVerified,false);
   assert.equal(out.ownerAuthenticated,true);
   assert.equal(out.tradingAuthorized,false);
   assert.equal(out.sourceGrantRecorded,false);
   assert.equal(out.ordersSubmitted,false);
 }
});
test("unrecognized or malicious upstream details cannot leak through preflight",async()=>{
 for(const reason of [
   "HTTP 429 Bearer private-token",
   "official_fee_schedule_http_418",
   "https://attacker.example/private/secret",
   "provider_monetary_fee_schedule_and_market_verified",
 ]){
  const {db}=make();
  const out=await inspectSingleOwnerFeePreflight(OWNER,{
    db,sha:()=>SHA,observe:async()=>({...good,ok:false,reason,
      monetaryFeeAuthorized:false}),
  });
  assert.equal(out.reason,"official_monetary_fee_source_unverified");
  assert.equal(out.tradingAuthorized,false);
  assert.equal(out.evidenceVerified,false);
 }
});
test("invalid digest cannot inherit a success-looking provider reason",async()=>{
 const {db}=make();
 const out=await inspectSingleOwnerFeePreflight(OWNER,{
   db,sha:()=>SHA,observe:async()=>({...good,sourceDigest:"not-a-digest"}),
 });
 assert.equal(out.reason,"official_monetary_fee_source_unverified");
 assert.equal(out.evidenceVerified,false);
 assert.equal(out.tradingAuthorized,false);
});
test("a safely killed owner with durable eligibility has no false STOP blocker",async()=>{
 const {db}=make({...account,execution_enabled:true,kill_switch:true,
   lease_state:"killed",configured_stake_cents:150,blocked_reason:"awaiting_account_commissioning"});
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.equal(out.ok,true);
 assert.equal(out.tradingAuthorized,false);
 assert.equal(out.suggestedNextActions.includes("stop_and_disarm_before_policy_migration"),false);
 assert.equal(out.suggestedNextActions.includes("approve_and_save_five_dollar_policy"),true);
 assert.equal(out.suggestedNextActions.includes("refresh_owner_commissioning"),true);
});

test("legacy low stake and unfenced worker are reported without mutating them",async()=>{
 const {db}=make({...account,configured_stake_cents:150,lease_state:"owned",
   execution_enabled:true,kill_switch:false,blocked_reason:"awaiting_account_commissioning"});
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.equal(out.ok,true);
 assert.equal(out.tradingAuthorized,false);
 assert.ok(out.suggestedNextActions.includes("recover_stale_worker_with_signed_kalshi"));
 assert.ok(out.suggestedNextActions.includes("stop_and_disarm_before_policy_migration"));
 assert.ok(out.suggestedNextActions.includes("approve_and_save_five_dollar_policy"));
 assert.ok(out.suggestedNextActions.includes("refresh_owner_commissioning"));
});

test("installed schema with exactly one own exact-SHA receipt is evidence-only",async()=>{
 const {db}=make(account,{receipt:true});
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.equal(out.ok,true);
 assert.equal(out.v3SchemaInstalled,true);
 assert.equal(out.v3EvidenceReceiptPresent,true);
 assert.equal(out.ownerConsentRecorded,false); // no live grant authority
 assert.equal(out.tradingAuthorized,false);
 assert.match(out.suggestedNextActions.join(","),/owner_fee_v3_evidence_only_grant_and_migration_still_required/);
});
test("missing schema and unavailable database reads fail closed without claiming a release",async()=>{
 for(const options of [{schema:false},{readFailure:true}]){
   const {db}=make(account,options);
   const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
   assert.equal(out.v3SchemaInstalled,false);
   assert.equal(out.v3EvidenceReceiptPresent,false);
   assert.equal(out.tradingAuthorized,false);
   assert.equal(out.sourceGrantRecorded,false);
   assert.match(out.suggestedNextActions.join(","),/owner_fee_v3_schema/);
 }
});
test("expired or different-SHA receipt never counts as current consent",async()=>{
 const {db,sqls}=make();
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.equal(out.v3EvidenceReceiptPresent,false);
 assert.ok(sqls.some(q=>q.includes("release_commit_sha=$3")&&q.includes("revoked_at IS NULL")&&q.includes("expires_at>now()")));
});

test("old approved $1.50 limits are diagnosed independently from saved stake",async()=>{
 const {db}=make({...account,configured_stake_cents:500,
   max_entry_stake_cents:150,max_entry_all_in_cents:200,
   fee_policy_version:"micro-live-standing-fee-policy-v1"});
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
 assert.ok(out.suggestedNextActions.includes("legacy_v1_fee_policy_requires_verified_migration"));
 assert.ok(out.suggestedNextActions.includes("approved_policy_stake_cap_below_five_dollars"));
 assert.ok(out.suggestedNextActions.includes("approved_policy_all_in_cap_below_five_dollars"));
 assert.ok(!out.suggestedNextActions.includes("approve_and_save_five_dollar_policy"));
 assert.equal(out.tradingAuthorized,false);
});
test("unsafe killed/released lease never counts as cleanly disarmed",async()=>{
 for(const changed of [{lease_state:"killed",arm_requested:true,lease_account_kill:true},
                       {lease_state:"killed",arm_requested:false,lease_account_kill:false},
                       {lease_state:"released",arm_requested:true,lease_account_kill:false}]){
   const {db}=make({...account,...changed});
   const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good,sha:()=>SHA});
   assert.ok(out.suggestedNextActions.includes("worker_lease_not_safely_disarmed"));
   assert.equal(out.tradingAuthorized,false);
 }
});

test("authentic issuer/bridge/local 429 reasons and exact retry deadline are owner-only diagnostics",async()=>{
 const retryAt="2026-10-24T22:46:58.810Z";
 for(const origin of ["provider","shared_cooldown","backend_local","bridge_unclassified"] as const){
  const {db}=make();
  const reason="official_fee_schedule_http_429_"+origin;
  const out=await inspectSingleOwnerFeePreflight(OWNER,{db,sha:()=>SHA,observe:async()=>({
   ...good,ok:false,reason,monetaryFeeAuthorized:false,rateLimitOrigin:origin,retryAt,
  })});
  assert.equal(out.reason,reason);
  assert.equal(out.rateLimitOrigin,origin);
  assert.equal(out.retryAt,retryAt);
  assert.equal(out.ownerAuthenticated,true);
  assert.equal(out.tradingAuthorized,false);
  assert.equal(out.evidenceVerified,false);
  assert.equal(out.sourceGrantRecorded,false);
  assert.equal(out.ordersSubmitted,false);
 }
});
