import assert from "node:assert/strict";
import test from "node:test";
import { inspectFeeAuthorizationReadiness } from "./feeAuthorizationReadiness";

const owner = "11111111-1111-4111-8111-111111111111";
const validEvidence = async () => ({
  ok:true,operatorAttested:true,uploadedPdfBytesVerified:true,liveMarketFeesVerified:true,
  pdfProviderVerified:false as const,policyApproved:false as const,
  commissioningApproved:false as const,tradingAuthorized:false as const,
  digest:"a".repeat(64),reason:"operator_attested_fee_evidence_diagnostic_only",candidateExpiresAt:"2026-10-16T20:00:00Z",
});
const fakeDb = async () => ({rows:[{grant_table:true,consent_table:true}],rowCount:1});
test("passing diagnostics and installed tables NEVER authorize steps or live orders",async()=>{
  for(const stage of ["STEP_6","STEP_9","STEP_11","ORDER_ENTRY"]) {
    const r=await inspectFeeAuthorizationReadiness(owner,stage,fakeDb as never,validEvidence as never);
    assert.equal(r.ok,false);assert.equal(r.tradingAuthorized,false);
    assert.equal(r.policyApproved,false);assert.equal(r.commissioningApproved,false);
    assert.equal(r.officialPdfApproved,false);
    assert.equal(r.sourcePolicyGrantRecorded,false);
    assert.equal(r.ownerSourceConsentRecorded,false);
    assert.ok(r.blockers.includes("stage_bound_fee_approval_not_implemented"));
  }
});
test("missing tables are distinct from missing authorization records",async()=>{
  const r=await inspectFeeAuthorizationReadiness(owner,"STEP_9",
    (async()=>({rows:[{grant_table:false,consent_table:false}]})) as never,validEvidence as never);
  assert.ok(r.blockers.includes("source_authorization_store_not_installed"));
  assert.ok(r.blockers.includes("approved_operator_source_grant_unverified"));
});
test("missing evidence refuses readiness",async()=>{
  const r=await inspectFeeAuthorizationReadiness(owner,"STEP_6",fakeDb as never,
    (async()=>({...await validEvidence(),ok:false})) as never);
  assert.equal(r.operatorEvidenceDiagnosticPassed,false);
  assert.ok(r.blockers.includes("operator_evidence_missing_or_expired"));
});
test("foreign or invalid owner and unknown stage refuse without database reads",async()=>{
  let calls=0;
  for(const [who,stage] of [["untrusted","STEP_9"],[owner,"TRADING"]]) {
    const r=await inspectFeeAuthorizationReadiness(who,stage,
      (async()=>{calls++;throw Error("should not run")}) as never,validEvidence as never);
    assert.ok(r.blockers.includes("owner_or_stage_invalid"));
  }
  assert.equal(calls,0);
});
test("database error fails closed",async()=>{
  const r=await inspectFeeAuthorizationReadiness(owner,"ORDER_ENTRY",
    (async()=>{throw Error("offline")}) as never,validEvidence as never);
  assert.equal(r.ok,false);
  assert.ok(r.blockers.includes("source_authorization_store_unavailable"));
});
