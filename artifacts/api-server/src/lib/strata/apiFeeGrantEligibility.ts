/**
 * Independent, source-specific authorization eligibility for a proposed
 * PDF-free API fee policy. All records MUST come from trusted service-owned
 * DB reads, never client-supplied grant/reviewer flags. This pure validator
 * has NO APPROVAL SIDE EFFECT and cannot authorize an exchange POST.
 */
import { API_FEE_POLICY_SOURCE_V1, type ApiFeePolicyReviewResult } from "./apiFeePolicyReviewCandidate";
import { PDF_FREE_RATE_REVIEW_VECTOR_VERSION, PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 } from "./apiFeeRateReference";

export const API_POLICY_SIGNED_REVIEW_V1="strata_api_fee_source_signed_review_v1" as const;
export type ApiFeeStage="STEP_9"|"STEP_11"|"ORDER_ENTRY";
type Review={
 reviewId:string; reviewerUserId:string; currentlyAdmin:boolean;
 feeModelVersion:typeof PDF_FREE_RATE_REVIEW_VECTOR_VERSION;
 rateDecisionDigest:string;
 scope:"KXBTC15M:INDEX2";signedAtMs:number;expiresAtMs:number;
 revokedAtMs:number|null; // Independent signed, service-verified human decision
};
type OwnerConsent={
 grantId:string;ownerUserId:string;confirmedAtMs:number;
 revokedAtMs:number|null;
};
type Grant={
 grantId:string;ownerUserId:string;issuerAdminId:string;
 feeModelVersion:typeof PDF_FREE_RATE_REVIEW_VECTOR_VERSION;
 rateDecisionDigest:string;
 policyVersion:typeof API_POLICY_SIGNED_REVIEW_V1;
 scope:"KXBTC15M:INDEX2";issuedAtMs:number;expiresAtMs:number;
 revokedAtMs:number|null;authorizedStages:readonly ApiFeeStage[];
};
export type ApiFeeGrantEvidence={
 stage:ApiFeeStage;nowMs:number;ownerUserId:string;
 candidate:ApiFeePolicyReviewResult;grant:Grant|null;
 reviews:readonly Review[];consent:OwnerConsent|null;
};
export type ApiFeeGrantDecision={
 ok:boolean;reason:string;sourceKind:typeof API_FEE_POLICY_SOURCE_V1;
 eligibleForIndependentPolicyReview:boolean;
 policyApproved:false;commissioningApproved:false;
 tradingAuthorized:false;
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GRANT_MS=15*60_000;
const deny=(reason:string):ApiFeeGrantDecision=>({
 ok:false,reason,sourceKind:API_FEE_POLICY_SOURCE_V1,
 eligibleForIndependentPolicyReview:false,
 policyApproved:false,commissioningApproved:false,tradingAuthorized:false,
});
/** Eligibility only. Real stage and order authority must independently
 * re-read immutable DB grant, admin roles, revocations and current fee API
 * inside the final transactional/order boundary. */
export function evaluatePdfFreeApiGrant(e:ApiFeeGrantEvidence):ApiFeeGrantDecision {
 const {grant,candidate,consent,ownerUserId,nowMs}=e;
 if(!UUID.test(ownerUserId)||!Number.isSafeInteger(nowMs)||nowMs<=0 ||
    !["STEP_9","STEP_11","ORDER_ENTRY"].includes(e.stage))
  return deny("api_fee_owner_or_clock_invalid");
 if(!candidate.ok || candidate.sourceKind!==API_FEE_POLICY_SOURCE_V1 ||
    candidate.requiresIndependentFeeModelReview!==true ||
    candidate.policyApproved!==false || candidate.tradingAuthorized!==false)
  return deny("api_fee_observation_not_verified");
 const observed=Date.parse(candidate.verifiedAt);
 if(!Number.isFinite(observed) || observed>nowMs || nowMs-observed>10_000 ||
    candidate.marketTicker.indexOf("KXBTC15M-")!==0 ||
    candidate.eventTicker.indexOf("KXBTC15M-")!==0)
  return deny("api_fee_observation_stale_or_wrong_market");
 if(!grant || !UUID.test(grant.grantId) || !UUID.test(grant.issuerAdminId) ||
    grant.ownerUserId!==ownerUserId || grant.issuerAdminId===ownerUserId ||
    grant.policyVersion!==API_POLICY_SIGNED_REVIEW_V1 ||
    grant.scope!=="KXBTC15M:INDEX2" ||
    grant.feeModelVersion!==PDF_FREE_RATE_REVIEW_VECTOR_VERSION ||
    grant.rateDecisionDigest!==PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 ||
    !grant.authorizedStages.includes(e.stage) ||
    grant.revokedAtMs!==null ||
    !Number.isSafeInteger(grant.issuedAtMs) ||
    !Number.isSafeInteger(grant.expiresAtMs) ||
    grant.issuedAtMs>nowMs || grant.expiresAtMs<=nowMs ||
    grant.expiresAtMs-grant.issuedAtMs>MAX_GRANT_MS)
  return deny("api_fee_grant_missing_invalid_or_expired");
 if(!consent || consent.ownerUserId!==ownerUserId ||
    consent.grantId!==grant.grantId || consent.revokedAtMs!==null ||
    !Number.isSafeInteger(consent.confirmedAtMs) ||
    consent.confirmedAtMs>nowMs || consent.confirmedAtMs<grant.issuedAtMs)
  return deny("api_fee_owner_consent_missing_or_revoked");
 const matches=e.reviews.filter(r=>
   UUID.test(r.reviewId) && UUID.test(r.reviewerUserId) &&
   r.currentlyAdmin && r.scope==="KXBTC15M:INDEX2" &&
   r.feeModelVersion===PDF_FREE_RATE_REVIEW_VECTOR_VERSION &&
   r.rateDecisionDigest===PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 &&
   r.revokedAtMs===null && Number.isSafeInteger(r.signedAtMs) &&
   Number.isSafeInteger(r.expiresAtMs) &&
   r.signedAtMs<=grant.issuedAtMs && r.expiresAtMs>nowMs &&
   r.reviewerUserId!==ownerUserId &&
   r.reviewerUserId!==grant.issuerAdminId);
 if(matches.length<2 || new Set(matches.map(r=>r.reviewerUserId)).size<2)
  return deny("api_fee_independent_admin_signatures_missing");
 return {
  ok:true, reason:"api_fee_source_independent_review_eligible_only",
  sourceKind:API_FEE_POLICY_SOURCE_V1,
  eligibleForIndependentPolicyReview:true, policyApproved:false,
  commissioningApproved:false,tradingAuthorized:false,
 };
}
