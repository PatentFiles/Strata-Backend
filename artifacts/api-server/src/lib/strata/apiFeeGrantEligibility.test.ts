import test from "node:test";
import assert from "node:assert/strict";
import {
 evaluatePdfFreeApiGrant, API_POLICY_SIGNED_REVIEW_V1,
 type ApiFeeGrantEvidence,
} from "./apiFeeGrantEligibility";
import { PDF_FREE_RATE_REVIEW_VECTOR_VERSION } from "./apiFeeRateReference";
import { API_FEE_POLICY_SOURCE_V1 } from "./apiFeePolicyReviewCandidate";

const now=Date.parse("2026-10-18T02:30:00.000Z");
const owner="11111111-1111-4111-8111-111111111111";
const issuer="22222222-2222-4222-8222-222222222222";
const first="33333333-3333-4333-8333-333333333333";
const second="44444444-4444-4444-8444-444444444444";
const grantId="55555555-5555-4555-8555-555555555555";
function fixture():ApiFeeGrantEvidence{
 const issued=now-60_000;
 const baseReview={currentlyAdmin:true,feeModelVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
  scope:"KXBTC15M:INDEX2" as const,signedAtMs:issued-5_000,
  expiresAtMs:now+60_000,revokedAtMs:null};
 return {
  stage:"STEP_9",nowMs:now,ownerUserId:owner,
  candidate:{
   ok:true,reason:"api_fee_observation_eligible_for_independent_review_only",
   sourceKind:API_FEE_POLICY_SOURCE_V1,observationDigest:"a".repeat(64),
   reviewCandidateDigest:"b".repeat(64),
   marketTicker:"KXBTC15M-26OCT172230-00",
   eventTicker:"KXBTC15M-26OCT172230",
   verifiedAt:new Date(now-500).toISOString(),
   feeFormulaVersion:"standard_quadratic_0.07_round_cent_v1" as never,
   requiresIndependentFeeModelReview:true,
   policyApproved:false,commissioningApproved:false,tradingAuthorized:false,
  },
  grant:{grantId,ownerUserId:owner,issuerAdminId:issuer,
   feeModelVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
   policyVersion:API_POLICY_SIGNED_REVIEW_V1,
   scope:"KXBTC15M:INDEX2",issuedAtMs:issued,expiresAtMs:now+60_000,
   revokedAtMs:null,authorizedStages:["STEP_9","STEP_11","ORDER_ENTRY"]},
  reviews:[
   {...baseReview,reviewId:"66666666-6666-4666-8666-666666666666",reviewerUserId:first},
   {...baseReview,reviewId:"77777777-7777-4777-8777-777777777777",reviewerUserId:second}
  ],
  consent:{grantId,ownerUserId:owner,confirmedAtMs:issued+1_000,revokedAtMs:null}
 };
}
test("distinct current admins plus owner consent qualifies for review but never approvals",()=>{
 const x=evaluatePdfFreeApiGrant(fixture());
 assert.equal(x.ok,true);
 assert.equal(x.eligibleForIndependentPolicyReview,true);
 assert.equal(x.policyApproved,false);
 assert.equal(x.commissioningApproved,false);
 assert.equal(x.tradingAuthorized,false);
});
test("denies missing or duplicate reviewers, revoked roles and altered owner",()=>{
 const edits:Array<(x:ApiFeeGrantEvidence)=>void>=[
  x=>{x.reviews=[]},
  x=>{x.reviews[1]!.reviewerUserId=first},
  x=>{x.reviews[0]!.currentlyAdmin=false},
  x=>{x.reviews[0]!.reviewerUserId=x.grant!.issuerAdminId},
  x=>{x.reviews[0]!.reviewerUserId=owner},
  x=>{x.reviews[1]!.revokedAtMs=now-1},
  x=>{x.ownerUserId="99999999-9999-4999-8999-999999999999"},
  x=>{x.consent!.revokedAtMs=now},
  x=>{x.consent!.ownerUserId=issuer},
  x=>{x.grant!.revokedAtMs=now},
  x=>{x.grant!.feeModelVersion="not-reviewed" as never},
  x=>{x.grant!.expiresAtMs=now},
  x=>{x.grant!.authorizedStages=[]},
  x=>{x.grant!.policyVersion="operator_attested_fee_source_v1" as never},
  x=>{if(x.candidate.ok)x.candidate.verifiedAt=new Date(now-20_000).toISOString()},
  x=>{if(x.candidate.ok)x.candidate.marketTicker="OTHER" },
 ];
 for(const edit of edits) {
  const v=fixture();edit(v);
  const result=evaluatePdfFreeApiGrant(v);
  assert.equal(result.ok,false,JSON.stringify(result));
  assert.equal(result.tradingAuthorized,false);
 }
});
test("a fresh observation cannot silently authorize an unreviewed order-entry stage",()=>{
 const x=fixture();x.stage="ORDER_ENTRY";
 assert.equal(evaluatePdfFreeApiGrant(x).ok,true);
 x.grant!.authorizedStages=["STEP_9","STEP_11"];
 assert.equal(evaluatePdfFreeApiGrant(x).ok,false);
});
