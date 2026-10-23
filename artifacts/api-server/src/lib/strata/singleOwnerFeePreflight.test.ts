import assert from "node:assert/strict";
import test from "node:test";
import {inspectSingleOwnerFeePreflight} from "./singleOwnerFeePreflight";
import type {MonetaryFeeEvidenceContract} from "./monetaryFeeContract";

const OWNER="11111111-1111-4111-8111-111111111111";
const DIGEST="a".repeat(64);
const good:MonetaryFeeEvidenceContract={
 ok:true,reason:"provider_monetary_fee_schedule_and_market_verified",stage:"STEP_9",
 marketTicker:"KXBTC15M-TEST",sourceDigest:DIGEST,verifiedAt:new Date().toISOString(),
 monetaryFeeAuthorized:true,policyApproved:false,tradingAuthorized:false,
};
const account={
 id:"strata-owner-test",commissioned:true,execution_enabled:false,kill_switch:true,
 blocked_reason:null,subaccount:1,exchange_index:2,
 fee_policy_version:"micro-live-standing-fee-policy-v1",policy_state:"APPROVED",
 configured_stake_cents:500,lease_state:"released",
};
const make=(row:Record<string,unknown>|null=account) => {
 const sqls:string[]=[];
 const db={query:async(sql:string,args:unknown[])=>{
   sqls.push(sql);
   assert.ok(/^\s*SELECT\b/i.test(sql),"read-only query required");
   assert.deepEqual(args,[OWNER]);
   return {rows:row?[row]:[]};
 }};
 return {db,sqls};
};
test("owner-scoped official evidence candidate is NOT an authorization or order",async()=>{
 const {db,sqls}=make();
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good});
 assert.equal(out.ok,true);
 assert.equal(out.evidenceVerified,true);
 assert.equal(out.tradingAuthorized,false);
 assert.equal(out.ownerConsentRecorded,false);
 assert.equal(out.sourceGrantRecorded,false);
 assert.equal(out.reviewAuthorityRecorded,false);
 assert.equal(out.ordersSubmitted,false);
 assert.equal(out.sourceDigest,DIGEST);
 assert.equal(sqls.length,1);
 assert.match(out.suggestedNextActions.join(","),/owner_fee_v3_schema_and_consent_not_yet_released/);
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
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good});
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
   const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>proof});
   assert.equal(out.ok,false);
   assert.equal(out.tradingAuthorized,false);
   assert.equal(out.sourceGrantRecorded,false);
 }
 const exception=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>{throw Error("429")}});
 assert.equal(exception.reason,"official_monetary_fee_source_unavailable");
});
test("legacy low stake and unfenced worker are reported without mutating them",async()=>{
 const {db}=make({...account,configured_stake_cents:150,lease_state:"owned",
   execution_enabled:true,kill_switch:false,blocked_reason:"awaiting_account_commissioning"});
 const out=await inspectSingleOwnerFeePreflight(OWNER,{db,observe:async()=>good});
 assert.equal(out.ok,true);
 assert.equal(out.tradingAuthorized,false);
 assert.ok(out.suggestedNextActions.includes("recover_stale_worker_with_signed_kalshi"));
 assert.ok(out.suggestedNextActions.includes("stop_and_disarm_before_policy_migration"));
 assert.ok(out.suggestedNextActions.includes("approve_and_save_five_dollar_policy"));
 assert.ok(out.suggestedNextActions.includes("refresh_owner_commissioning"));
});
