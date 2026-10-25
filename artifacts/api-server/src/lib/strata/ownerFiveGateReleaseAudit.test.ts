import test from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import {inspectOwnerFiveGateReleaseAudit} from "./ownerFiveGateReleaseAudit";
const owner="11111111-1111-4111-8111-111111111111";
const now=Date.parse("2026-10-24T23:00:00Z");
const account={id:"strata-account-test",commissioned:true,kill_switch:true,
 cash_precision_verified:true,reconciled_at:new Date(now-10_000),
 policy_state:"APPROVED",configured_stake_cents:500,max_entry_stake_cents:500,
 fee_policy_version:"strata_owner_provider_dynamic_fee_v4",open_intents:0,open_positions:0,open_exits:0};
function audit(row:Record<string,unknown>=account){
 const queries:string[]=[];
 const db={async query(sql:string,args?:unknown[]){
  queries.push(sql);
  assert.equal(args?.[0],owner);
  assert.match(sql,/owner_user_id=\$1::uuid/);
  assert.doesNotMatch(sql,/\b(UPDATE|INSERT|DELETE)\b/);
  return {rows:[row]};
 }};
 const reviewed=async()=>({
  ok:true,reason:"read_only",currentReviewers:1,
  grantId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerConsentRecorded:true,policyApproved:false,
  commissioningApproved:false,tradingAuthorized:false,
 }) as never;
 const v4=async()=>({
  ok:true,deployedSha:"a".repeat(40),checks:{
   modelEvidence:false,feeAuthority:false,
   protectiveExitRelease:true,ownerShaApproval:true,
  },
 }) as never;
 return {query:queries,run:()=>inspectOwnerFiveGateReleaseAudit(owner,{
  db,reviewed:reviewed as never,v4:v4 as never,now:()=>now,
 })};
}
test("five independent release gate observations do not grant trading or clear the kill",async()=>{
 const x=audit();
 const r=await x.run();
 assert.equal(r.ok,true);
 assert.equal(r.tradingAuthorized,false);
 assert.equal(r.ordersSubmitted,false);
 assert.equal(r.account.killSwitchOn,true);
 assert.equal(r.cash.persistedReconciliationFresh,true);
 assert.equal(r.cash.localExposureFlat,true);
 assert.equal(r.cash.signedExchangeReconciliationPerformed,false);
 assert.equal(r.fee.independentReview.recordPresent,true);
 assert.equal(r.fee.reviewedApiGrant.recordPresent,true);
 assert.equal(r.fee.ownerFeeConsent.recordPresent,true);
 assert.equal(r.fee.ownerFeeConsent.verifiedInThisRequest,false);
 assert.equal(r.fee.v4Authority.recordPresent,false);
 assert.equal(r.exit.protectiveRelease.recordPresent,true);
 assert.equal(r.owner.exactShaApproval.recordPresent,true);
 assert.ok(r.remaining.includes("retain_kill_until_independent_activation_checks_pass"));
 assert.ok(r.remaining.includes("verify_current_signed_kalshi_exchange_evidence_in_owner_reconciliation"));
 assert.equal(x.query.length,1);
});
test("stale persisted cash and unresolved local intents are independent blockers",async()=>{
 const x=audit({...account,reconciled_at:new Date(now-16*60_000),open_intents:1});
 const r=await x.run();
 assert.equal(r.cash.persistedReconciliationFresh,false);
 assert.equal(r.cash.localExposureFlat,false);
 assert.ok(r.remaining.includes("refresh_kalshi_signed_cash_positions_orders_fills_and_exit_reservations"));
 assert.equal(r.tradingAuthorized,false);
});
test("reviewed API V2 $5 approved stake is not wrongly failed by V4-only validator",async()=>{
 const a={...account,fee_policy_version:"strata_api_fee_source_signed_review_v2",
  policy_hash:"a".repeat(64),state:"APPROVED",capital_limit_cents:2500,
  risk_capital_cents:2500,risk_preset_id:"test-20pct",risk_preset_revision:1,
  max_entry_all_in_cents:625,max_daily_loss_cents:1000,max_total_loss_cents:1500};
 const r=await audit(a).run();
 assert.equal(r.ok,true);
 assert.equal(r.policyPath,"reviewed_api_v2");
 assert.equal(r.account.fiveDollarPolicyApproved,true);
 assert.equal(r.tradingAuthorized,false);
 const invalid=await audit({...a,policy_hash:"not-a-sha"}).run();
 assert.equal(invalid.account.fiveDollarPolicyApproved,false);
});
test("missing or ambiguous owner and malformed user identity fail closed",async()=>{
 const missing=await inspectOwnerFiveGateReleaseAudit(owner,{db:{async query(){return {rows:[]};}}});
 assert.equal(missing.ok,false);
 const wrong=await inspectOwnerFiveGateReleaseAudit("not-user-id",{db:{async query(){throw Error("should never query");}}});
 assert.equal(wrong.ok,false);
 const ambig=await inspectOwnerFiveGateReleaseAudit(owner,{db:{async query(){return {rows:[account,account]};}}});
 assert.equal(ambig.ok,false);
});
test("route is authenticated and read-only and separate from provider PDF preflight",()=>{
 const routePath=existsSync("src/routes/userExecutionRouter.ts")?"src/routes/userExecutionRouter.ts":"artifacts/api-server/src/routes/userExecutionRouter.ts";
 const router=readFileSync(routePath,"utf8");
 assert.match(router,/router\.get\("\/release\/five-gate-audit"/);
 assert.match(router,/const owner=subject\(res\)/);
 assert.match(router,/inspectOwnerFiveGateReleaseAudit\(owner\)/);
 assert.match(router,/Cache-Control","private, no-store"/);
 const sourcePath=existsSync("src/lib/strata/ownerFiveGateReleaseAudit.ts")?"src/lib/strata/ownerFiveGateReleaseAudit.ts":"artifacts/api-server/src/lib/strata/ownerFiveGateReleaseAudit.ts";
 const code=readFileSync(sourcePath,"utf8");
 assert.doesNotMatch(code,/verifyMonetaryFeeContract|fetchTrustedFeeFromSupabaseBridge|authorizeWalletV4FeeModel/);
 assert.doesNotMatch(code,/\b(UPDATE|INSERT|DELETE)\b.*public\./);
});

test("owner V4 monetary fee failures do not demand reviewed API ADMIN grants or block signed cash status",async()=>{
 const a=audit();
 const r=await a.run();
 assert.equal(r.policyPath,"dynamic_v4");
 assert.ok(r.remaining.includes("v4_issuer_pdf_and_market_fee_model_evidence_missing"));
 assert.ok(r.remaining.includes("v4_owner_mfa_fee_consent_missing"));
 assert.ok(!r.remaining.some(x=>/admin_review|reviewed_api_/.test(x)));
 assert.equal(r.cash.persistedReconciliationFresh,true);
 assert.equal(r.exit.protectiveRelease.recordPresent,true);
});
test("only reviewed API V2 accounts receive independent reviewer steps, never a V4 PDF requirement",async()=>{
 const a={...account,fee_policy_version:"strata_api_fee_source_signed_review_v2",
  policy_hash:"a".repeat(64),state:"APPROVED",capital_limit_cents:2500,
  risk_capital_cents:2500,risk_preset_id:"test-20pct",risk_preset_revision:1,
  max_entry_all_in_cents:625,max_daily_loss_cents:1000,max_total_loss_cents:1500};
 const result=await inspectOwnerFiveGateReleaseAudit(owner,{
  db:{async query(){return {rows:[a]}}},
  reviewed:async()=>({ok:true,currentReviewers:0,grantId:null,ownerConsentRecorded:false}) as never,
  v4:async()=>({ok:true,deployedSha:"a".repeat(40),checks:{modelEvidence:false,
   feeAuthority:false,ownerShaApproval:false,protectiveExitRelease:false}}) as never,
  now:()=>now,
 });
 assert.equal(result.policyPath,"reviewed_api_v2");
 assert.ok(result.remaining.includes("reviewed_api_independent_fee_review_missing"));
 assert.ok(result.remaining.includes("reviewed_api_owner_specific_grant_missing"));
 assert.ok(result.remaining.includes("reviewed_api_owner_mfa_consent_missing"));
 assert.ok(!result.remaining.some(x=>x.includes("v4_issuer_pdf")));
});
