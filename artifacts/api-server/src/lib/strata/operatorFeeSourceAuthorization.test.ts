import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOperatorSourceGrant, OPERATOR_FEE_SOURCE_POLICY,
  type OperatorSourceInputs } from "./operatorFeeSourceAuthorization";
import { REVIEWED_FEE_DIGEST } from "./operatorAttestedFeeEligibility";

const owner = "11111111-1111-4111-8111-111111111111";
const admin = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const releaseId = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-16T15:00:00.000Z");

function sample(): OperatorSourceInputs {
  return {
    nowMs:NOW,callerOwnerUserId:owner,stage:"STEP_9",
    privatePdfSha256:REVIEWED_FEE_DIGEST,
    eligibleCandidate:{ok:true,releaseId,expiresAt:new Date(NOW+600_000).toISOString(),provenance:"operator_attested"},
    grant:{
      policyVersion:OPERATOR_FEE_SOURCE_POLICY,grantId,releaseId,
      reviewedPdfSha256:REVIEWED_FEE_DIGEST,ownerUserId:owner,
      approvedByAdminId:admin,approvedAtMs:NOW-1000,
      expiresAtMs:NOW+300_000,revokedAtMs:null,
      authorizedStages:["STEP_6","STEP_9","STEP_11"],
    },
    consent:{ownerUserId:owner,grantId,releaseId,confirmedAtMs:NOW-500,revokedAtMs:null},
    liveScope:{
      ticker:"KXBTC15M-26OCT161045-45",eventTicker:"KXBTC15M-26OCT161045",
      series:"KXBTC15M",exchangeIndex:2,multiplier:1,feeType:"quadratic",
      metadataFingerprint:"a".repeat(64),verifiedAtMs:NOW-100,
      noUnverifiedOverridesOrChanges:true,
    },
  };
}
function negative(mutator: (x:OperatorSourceInputs)=>void, reason:string) {
  const value=sample();mutator(value);
  const outcome=evaluateOperatorSourceGrant(value);
  assert.equal(outcome.ok,false);assert.equal(outcome.reason,reason);
  assert.equal(outcome.pdfProviderVerified,false);
  assert.equal(outcome.policyApproved,false);
  assert.equal(outcome.commissioningApproved,false);
  assert.equal(outcome.tradingAuthorized,false);
}

test("eligible source grant is an assessment, never policy or trading authority",()=>{
  const r=evaluateOperatorSourceGrant(sample());
  assert.equal(r.ok,true);
  assert.equal(r.reason,"operator_source_grant_read_only_eligible");
  assert.equal(r.pdfProviderVerified,false);
  assert.equal(r.policyApproved,false);
  assert.equal(r.commissioningApproved,false);
  assert.equal(r.tradingAuthorized,false);
  assert.equal(r.expiresAtMs,NOW+300_000);
});
test("refuses operator release missing, expired, or of unknown provenance",()=>{
  negative(x=>{x.eligibleCandidate={ok:false,reason:"candidate_expired"};},"operator_release_not_eligible");
  negative(x=>{x.eligibleCandidate={ok:true,releaseId,expiresAt:new Date(NOW-1).toISOString(),provenance:"operator_attested"};},"operator_release_expired");
  negative(x=>{x.privatePdfSha256="b".repeat(64);},"reviewed_pdf_integrity_unverified");
});
test("requires separately approved scoped grant from service-only source",()=>{
  negative(x=>{x.grant=null;},"operator_source_policy_grant_missing");
  negative(x=>{x.grant!.ownerUserId=admin;},"operator_source_policy_grant_invalid");
  negative(x=>{x.grant!.releaseId=admin;},"operator_source_policy_grant_invalid");
  negative(x=>{x.grant!.revokedAtMs=NOW-1;},"operator_source_policy_grant_invalid");
  negative(x=>{x.grant!.reviewedPdfSha256="a".repeat(64);},"operator_source_policy_grant_invalid");
  negative(x=>{x.stage="ORDER_ENTRY";},"operator_source_policy_scope_or_expiry_invalid");
  negative(x=>{x.grant!.authorizedStages=["STEP_9","STEP_9"];},"operator_source_policy_scope_or_expiry_invalid");
  negative(x=>{x.grant!.expiresAtMs=NOW-1;},"operator_source_policy_scope_or_expiry_invalid");
  negative(x=>{x.grant!.expiresAtMs=NOW+900_001;},"operator_source_policy_scope_or_expiry_invalid");
});
test("requires exact owner consent bound to the grant and release",()=>{
  negative(x=>{x.consent=null;},"owner_source_consent_missing_or_invalid");
  negative(x=>{x.consent!.grantId=admin;},"owner_source_consent_missing_or_invalid");
  negative(x=>{x.consent!.ownerUserId=admin;},"owner_source_consent_missing_or_invalid");
  negative(x=>{x.consent!.revokedAtMs=NOW-1;},"owner_source_consent_missing_or_invalid");
  negative(x=>{x.consent!.confirmedAtMs=NOW-1_500;},"owner_source_consent_missing_or_invalid");
});
test("requires fresh exact KXBTC15M event/schedule fee metadata",()=>{
  negative(x=>{x.liveScope=null;},"live_event_fee_evidence_unverified");
  negative(x=>{x.liveScope!.multiplier=2 as 1;},"live_event_fee_evidence_unverified");
  negative(x=>{x.liveScope!.noUnverifiedOverridesOrChanges=false as true;},"live_event_fee_evidence_unverified");
  negative(x=>{x.liveScope!.ticker="KXBTC15M-other";},"live_event_fee_evidence_unverified");
  negative(x=>{x.liveScope!.verifiedAtMs=NOW-10_001;},"live_event_fee_evidence_unverified");
  negative(x=>{x.liveScope!.metadataFingerprint="not_a_hash";},"live_event_fee_evidence_unverified");
});
