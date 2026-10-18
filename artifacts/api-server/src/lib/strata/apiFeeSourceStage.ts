/**
 * Real, service-owned API fee policy source stage check.
 * No browser field is accepted as a reviewer, consent or fee approval.
 * This checks signed *database* review facts and fresh Kalshi Trade API data.
 * Positive is source eligibility only: NEVER a trade/commissioning permission.
 */
import { pool } from "@workspace/db";
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";
import { preparePdfFreeApiFeePolicyReview } from "./apiFeePolicyReviewCandidate";
import {
 evaluatePdfFreeApiGrant, API_POLICY_SIGNED_REVIEW_V1,
 type ApiFeeStage,type ApiFeeGrantEvidence,
} from "./apiFeeGrantEligibility";
import { PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
 PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 } from "./apiFeeRateReference";
import { STANDARD_QUADRATIC_FEE_FORMULA_VERSION } from "../microLiveFeeArtifact";

export const API_SOURCE_POLICY_VERSION=API_POLICY_SIGNED_REVIEW_V1;
export const API_SOURCE_FORMULA_VERSION=STANDARD_QUADRATIC_FEE_FORMULA_VERSION;
const UUID="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const UUID_RE=new RegExp("^"+UUID+"$","i");
const SOURCE_RE=new RegExp("^strata-api-reviewed://kxbtc15m/("+UUID+")$","i");
const TICKER=/^KXBTC15M-[A-Za-z0-9-]+$/;
export function parseReviewedApiSource(url:string):{grantId:string}|null {
 const match=SOURCE_RE.exec(url);
 return match ? {grantId:match[1]!.toLowerCase()} : null;
}
export function encodeReviewedApiSource(grantId:string):string|null {
 return UUID_RE.test(grantId) ?
   "strata-api-reviewed://kxbtc15m/"+grantId.toLowerCase():null;
}
type Db={
 query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
};
export type VerifiedApiSourceStage =
 | {ok:true;reason:"reviewed_api_fee_source_stage_current";
    identity:{grantId:string;sourceUrl:string;digest:string;
    feePolicyVersion:typeof API_SOURCE_POLICY_VERSION;
    formulaVersion:typeof API_SOURCE_FORMULA_VERSION;
    marketTicker:string;verifiedAtMs:number}}
 | {ok:false;reason:string};
const no=(reason:string):VerifiedApiSourceStage=>({ok:false,reason});
const ms=(v:unknown):number=>v instanceof Date?v.getTime():Date.parse(String(v??""));
const txt=(v:unknown):string=>typeof v==="string"?v:"";

/** Must be read from the actual Railway runtime database, never public client. */
export const READ_API_FEE_STAGE_SQL=`
 -- api-fee:source-stage (owner + stage + exact source)
 SELECT g.grant_id, g.owner_user_id, g.issuer_admin_id, g.rate_decision_digest,
   g.fee_model_version, g.policy_version, g.scope, g.issued_at,
   g.expires_at, g.revoked_at,g.authorized_stages,
   c.confirmed_at, c.revoked_at AS consent_revoked_at, c.owner_user_id AS consent_owner,
   r1.review_id AS first_review_id, r1.reviewer_user_id AS first_reviewer,
   r1.rate_decision_digest AS first_digest, r1.fee_model_version AS first_model,
   r1.scope AS first_scope, r1.signed_at AS first_signed,
   r1.expires_at AS first_expires, r1.revoked_at AS first_revoked,
   r2.review_id AS second_review_id, r2.reviewer_user_id AS second_reviewer,
   r2.rate_decision_digest AS second_digest, r2.fee_model_version AS second_model,
   r2.scope AS second_scope, r2.signed_at AS second_signed,
   r2.expires_at AS second_expires, r2.revoked_at AS second_revoked
 FROM private.strata_api_fee_source_grants g
 JOIN private.strata_api_fee_owner_consents c
   ON c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id
 JOIN private.strata_api_fee_rate_reviews r1
   ON r1.owner_user_id=g.owner_user_id AND r1.rate_decision_digest=g.rate_decision_digest
 JOIN private.strata_api_fee_rate_reviews r2
   ON r2.owner_user_id=g.owner_user_id AND r2.rate_decision_digest=g.rate_decision_digest
   AND r1.reviewer_user_id<r2.reviewer_user_id
 WHERE g.owner_user_id=$1::uuid AND ($2::uuid IS NULL OR g.grant_id=$2::uuid)
   AND g.rate_decision_digest=$4 AND g.fee_model_version=$5
   AND g.policy_version='strata_api_fee_source_signed_review_v1'
   AND g.scope='KXBTC15M:INDEX2' AND c.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'
   AND g.confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'
   AND r1.confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'
   AND r2.confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'
   AND r1.scope=g.scope AND r2.scope=g.scope
   AND r1.fee_model_version=g.fee_model_version
   AND r2.fee_model_version=g.fee_model_version
   AND r1.signed_at<=g.issued_at AND r2.signed_at<=g.issued_at
   AND g.revoked_at IS NULL AND c.revoked_at IS NULL
   AND r1.revoked_at IS NULL AND r2.revoked_at IS NULL
   AND g.expires_at>now()+interval '12 seconds'
   AND r1.expires_at>now()+interval '12 seconds'
   AND r2.expires_at>now()+interval '12 seconds'
   AND g.authorized_stages @> ARRAY[$3::text]
   AND EXISTS (
     SELECT 1 FROM auth.users u JOIN private.role_assignments role
       ON lower(btrim(u.email))=lower(btrim(role.email))
     WHERE u.id=g.issuer_admin_id AND role.role='ADMIN'
       AND u.email_confirmed_at IS NOT NULL
   )
   AND EXISTS (
     SELECT 1 FROM auth.users u JOIN private.role_assignments role
       ON lower(btrim(u.email))=lower(btrim(role.email))
     WHERE u.id=r1.reviewer_user_id AND role.role='ADMIN'
       AND u.email_confirmed_at IS NOT NULL
   )
   AND EXISTS (
     SELECT 1 FROM auth.users u JOIN private.role_assignments role
       ON lower(btrim(u.email))=lower(btrim(role.email))
     WHERE u.id=r2.reviewer_user_id AND role.role='ADMIN'
       AND u.email_confirmed_at IS NOT NULL
   )
 FOR SHARE OF g,c,r1,r2
 LIMIT 2
`;
export async function verifyReviewedApiFeeSourceStage(
  ownerUserId:string, stage:ApiFeeStage, expectedSourceUrl?:string,
  exactOrderMarket?:string,
  deps:{db?:Db; probe?:typeof probeCurrentKalshiFeeApi;now?:()=>number}={},
):Promise<VerifiedApiSourceStage> {
 if(!UUID_RE.test(ownerUserId) || !["STEP_9","STEP_11","ORDER_ENTRY"].includes(stage))
   return no("api_fee_owner_or_stage_invalid");
 if(stage==="ORDER_ENTRY" && (!exactOrderMarket || !TICKER.test(exactOrderMarket)))
   return no("exact_order_market_required");
 const parsed=expectedSourceUrl===undefined?null:parseReviewedApiSource(expectedSourceUrl);
 if(expectedSourceUrl!==undefined && !parsed) return no("api_fee_source_url_invalid");
 // Only valid LIVE provider-origin market evidence qualifies; no PDF request.
 const observation=await (deps.probe??probeCurrentKalshiFeeApi)(
   globalThis.fetch,deps.now??Date.now,exactOrderMarket);
 const candidate=preparePdfFreeApiFeePolicyReview(observation,(deps.now??Date.now)());
 if(!candidate.ok) return no(candidate.reason);
 if(exactOrderMarket && candidate.marketTicker!==exactOrderMarket)
   return no("api_fee_order_market_mismatch");
 let records:Record<string,unknown>[];
 try {
  const db=deps.db??pool;
  const loaded=await db.query(READ_API_FEE_STAGE_SQL,[
   ownerUserId,parsed?.grantId??null,stage,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
  ]);
  records=loaded.rows;
 }catch{return no("api_fee_database_review_unavailable");}
 if(records.length!==1)return no("api_fee_independent_reviews_missing_or_ambiguous");
 const r=records[0]!;
 const stages=Array.isArray(r.authorized_stages)?r.authorized_stages.filter(
   (x):x is ApiFeeStage=>x==="STEP_9"||x==="STEP_11"||x==="ORDER_ENTRY"):[];
 const grantId=txt(r.grant_id);
 const evidence:ApiFeeGrantEvidence={
  stage,nowMs:(deps.now??Date.now)(),ownerUserId,candidate,
  grant:{
   grantId,ownerUserId:txt(r.owner_user_id),issuerAdminId:txt(r.issuer_admin_id),
   rateDecisionDigest:txt(r.rate_decision_digest),
   feeModelVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
   policyVersion:API_POLICY_SIGNED_REVIEW_V1,
   scope:"KXBTC15M:INDEX2",issuedAtMs:ms(r.issued_at),expiresAtMs:ms(r.expires_at),
   revokedAtMs:r.revoked_at==null?null:ms(r.revoked_at),authorizedStages:stages,
  },
  consent:{grantId,ownerUserId:txt(r.consent_owner),confirmedAtMs:ms(r.confirmed_at),
   revokedAtMs:r.consent_revoked_at==null?null:ms(r.consent_revoked_at)},
  reviews:[
   {reviewId:txt(r.first_review_id),reviewerUserId:txt(r.first_reviewer),
    currentlyAdmin:true,rateDecisionDigest:txt(r.first_digest),
    feeModelVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:"KXBTC15M:INDEX2",
    signedAtMs:ms(r.first_signed),expiresAtMs:ms(r.first_expires),
    revokedAtMs:r.first_revoked==null?null:ms(r.first_revoked)},
   {reviewId:txt(r.second_review_id),reviewerUserId:txt(r.second_reviewer),
    currentlyAdmin:true,rateDecisionDigest:txt(r.second_digest),
    feeModelVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:"KXBTC15M:INDEX2",
    signedAtMs:ms(r.second_signed),expiresAtMs:ms(r.second_expires),
    revokedAtMs:r.second_revoked==null?null:ms(r.second_revoked)},
  ],
 };
 const decision=evaluatePdfFreeApiGrant(evidence);
 if(!decision.ok) return no(decision.reason);
 const sourceUrl=encodeReviewedApiSource(grantId);
 if(!sourceUrl || expectedSourceUrl!==undefined && sourceUrl!==expectedSourceUrl)
   return no("api_fee_source_identity_mismatch");
 return {ok:true,reason:"reviewed_api_fee_source_stage_current",identity:{
  grantId,sourceUrl,digest:candidate.reviewCandidateDigest,
  feePolicyVersion:API_SOURCE_POLICY_VERSION,formulaVersion:API_SOURCE_FORMULA_VERSION,
  marketTicker:candidate.marketTicker,verifiedAtMs:Date.parse(candidate.verifiedAt),
 }};
}
