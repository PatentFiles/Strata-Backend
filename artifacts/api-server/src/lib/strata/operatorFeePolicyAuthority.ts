import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { inspectOperatorFeeCandidate } from "./operatorFeeCandidateRead";
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";
import { FEE_SOURCE_DECISION_TEXT,FEE_SOURCE_DECISION_SHA256,
  FEE_SOURCE_REVIEW_CONFIRMATION,FEE_SOURCE_GRANT_CONFIRMATION,
  REVIEWED_OPERATOR_FEE_SHA256 } from "./operatorFeePolicyDecision";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES=["STEP_6","STEP_9","STEP_11","ORDER_ENTRY"] as const;
type PublicResult={ok:boolean;reason:string;reviewId?:string;grantId?:string;expiresAt?:string;
  policyApproved:false;commissioningApproved:false;tradingAuthorized:false};
const no=(reason:string):PublicResult=>({ok:false,reason,
  policyApproved:false,commissioningApproved:false,tradingAuthorized:false});
const ok=(reason:string,detail:Partial<PublicResult>):PublicResult=>({
  ...no(reason),ok:true,...detail,
});
const shaExpected=()=>createHash("sha256").update(FEE_SOURCE_DECISION_TEXT).digest("hex")===
  FEE_SOURCE_DECISION_SHA256;
async function adminVerified(id:string):Promise<boolean>{
  if(!UUID.test(id))return false;
  try{
    const r=await pool.query(`SELECT 1 FROM auth.users u
      JOIN private.role_assignments ra ON lower(btrim(ra.email))=lower(btrim(u.email))
      WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL AND ra.role='ADMIN' LIMIT 1`,[id]);
    return r.rows.length===1;
  }catch{return false;}
}
async function ownerHasAccount(id:string):Promise<boolean>{
  if(!UUID.test(id))return false;
  try{
    const r=await pool.query(`SELECT id FROM public.v13_production_account
       WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 LIMIT 2`,[id]);
    return r.rows.length===1;
  }catch{return false;}
}
const eligibleRelease=async (releaseId:string)=>{
  if(!UUID.test(releaseId))return null;
  const candidate=await inspectOperatorFeeCandidate();
  return candidate.ok&&candidate.releaseId===releaseId&&candidate.expiresAt&&
    Date.parse(candidate.expiresAt ?? '')>Date.now()?candidate:null;
};
type ReviewRequest={releaseId:unknown;ownerUserId:unknown;confirmation:unknown;note:unknown};
export function feeSourcePolicyDocument(){
  return {text:FEE_SOURCE_DECISION_TEXT,sha256:FEE_SOURCE_DECISION_SHA256,
    reviewConfirmation:FEE_SOURCE_REVIEW_CONFIRMATION,
    grantConfirmation:FEE_SOURCE_GRANT_CONFIRMATION,
    policyApproved:false,commissioningApproved:false,tradingAuthorized:false};
}
export async function signIndependentFeePolicyReview(
  adminId:string,raw:unknown,
):Promise<PublicResult>{
  if(!shaExpected())return no("fee_policy_text_hash_invalid");
  if(!await adminVerified(adminId))return no("administrator_required");
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return no("policy_review_body_invalid");
  const r=raw as ReviewRequest;
  if(typeof r.releaseId!=="string"||!UUID.test(r.releaseId)||
     typeof r.ownerUserId!=="string"||!UUID.test(r.ownerUserId)||
     r.confirmation!==FEE_SOURCE_REVIEW_CONFIRMATION||
     typeof r.note!=="string"||r.note.trim().length<100||r.note.trim().length>1600)
     return no("explicit_independent_policy_review_required");
  if(!await ownerHasAccount(r.ownerUserId))return no("owned_account_missing");
  const candidate=await eligibleRelease(r.releaseId);
  if(!candidate)return no("independently_reviewed_release_not_current");
  let client;
  try{
    client=await pool.connect();
    await client.query("BEGIN");
    const reviewId=randomUUID();
    const release=await client.query(`
      SELECT release_id,expires_at FROM public.strata_fee_operator_release_candidates
      WHERE release_id=$1::uuid AND revoked_at IS NULL AND expires_at>now()
        AND content_sha256=$2
        AND evidence_kind='operator_attested_commissioning_candidate'
      FOR SHARE`,[r.releaseId,REVIEWED_OPERATOR_FEE_SHA256]);
    if(release.rows.length!==1)return no("release_changed_during_review");
    const reviewedAt=new Date();
    const ends=new Date(Math.min(reviewedAt.getTime()+15*60_000,
      Date.parse(candidate.expiresAt ?? ''),new Date(release.rows[0]!.expires_at).getTime()));
    if(ends.getTime()<=reviewedAt.getTime())return no("release_expired");
    const inserted=await client.query(`
      INSERT INTO private.strata_fee_source_policy_reviews
      (review_id,release_id,owner_user_id,reviewer_user_id,
       policy_decision_sha256,reviewed_pdf_sha256,confirmation,review_note,reviewed_at,expires_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (release_id,owner_user_id,reviewer_user_id,policy_decision_sha256)
      DO NOTHING RETURNING review_id`,
      [reviewId,r.releaseId,r.ownerUserId,adminId,
       FEE_SOURCE_DECISION_SHA256,REVIEWED_OPERATOR_FEE_SHA256,
       FEE_SOURCE_REVIEW_CONFIRMATION,r.note.trim(),reviewedAt.toISOString(),ends.toISOString()]);
    if(inserted.rows.length!==1)return no("independent_review_already_recorded_no_retry");
    await client.query("COMMIT");
    return ok("independent_fee_source_policy_review_recorded_only",{reviewId,expiresAt:ends.toISOString()});
  }catch{return no("policy_review_not_recorded");}
  finally{if(client){try{await client.query("ROLLBACK");}catch{}client.release();}}
}
type GrantRequest={releaseId:unknown;ownerUserId:unknown;confirmation:unknown};
export async function issueReviewedOwnerFeeSourceGrant(
  adminId:string,raw:unknown,
):Promise<PublicResult>{
  if(!shaExpected())return no("fee_policy_text_hash_invalid");
  if(!await adminVerified(adminId))return no("administrator_required");
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return no("grant_body_invalid");
  const r=raw as GrantRequest;
  if(typeof r.releaseId!=="string"||!UUID.test(r.releaseId)||
     typeof r.ownerUserId!=="string"||!UUID.test(r.ownerUserId)||
     r.confirmation!==FEE_SOURCE_GRANT_CONFIRMATION)
    return no("explicit_grant_issue_confirmation_required");
  if(!await ownerHasAccount(r.ownerUserId))return no("owner_account_invalid");
  const candidate=await eligibleRelease(r.releaseId);
  if(!candidate)return no("independent_operator_release_unavailable");
  const fees=await probeCurrentKalshiFeeApi();
  if(!fees.ok||fees.series!=="KXBTC15M"||fees.exchangeIndex!==2||
     fees.feeType!=="quadratic"||fees.feeMultiplier!=="1"||!fees.metadataDigest)
    return no("live_kalshi_fee_evidence_missing");
  let client;
  let committed=false;
  try{
    client=await pool.connect();
    await client.query("BEGIN");
    const release=await client.query(`
      SELECT release_id,expires_at FROM public.strata_fee_operator_release_candidates
      WHERE release_id=$1::uuid AND revoked_at IS NULL AND expires_at>now()
      AND content_sha256=$2 AND evidence_kind='operator_attested_commissioning_candidate'
      FOR SHARE`,[r.releaseId,REVIEWED_OPERATOR_FEE_SHA256]);
    if(release.rows.length!==1)return no("operator_release_revoked_or_expired");
    const reviewers=await client.query(`
      SELECT p.reviewer_user_id,p.expires_at
      FROM private.strata_fee_source_policy_reviews p
      JOIN auth.users u ON u.id=p.reviewer_user_id
      JOIN private.role_assignments ra ON lower(btrim(ra.email))=lower(btrim(u.email))
      WHERE p.release_id=$1::uuid AND p.owner_user_id=$2::uuid
      AND p.policy_decision_sha256=$3 AND p.reviewed_pdf_sha256=$4
      AND p.revoked_at IS NULL AND p.expires_at>now()
      AND u.email_confirmed_at IS NOT NULL AND ra.role='ADMIN'
      ORDER BY p.reviewer_user_id FOR SHARE OF p`,
      [r.releaseId,r.ownerUserId,FEE_SOURCE_DECISION_SHA256,REVIEWED_OPERATOR_FEE_SHA256]);
    const distinct=new Set(reviewers.rows.map(x=>String(x.reviewer_user_id)));
    if(distinct.size<2||reviewers.rows.length!==2)
      return no("two_independent_current_fee_policy_signers_required");
    const now=Date.now();
    const expiry=Math.min(Date.parse(candidate.expiresAt ?? ''),
      new Date(release.rows[0]!.expires_at).getTime(),
      ...reviewers.rows.map(x=>new Date(x.expires_at).getTime()),now+15*60_000);
    if(!Number.isFinite(expiry)||expiry<=now+10_000)
      return no("release_or_reviews_expire_too_soon");
    // The audit insert is additionally enforced by the database trigger.
    const grantId=randomUUID();
    const added=await client.query(`
      INSERT INTO private.strata_fee_source_grants
      (grant_id,owner_user_id,release_id,reviewed_pdf_sha256,policy_version,
       approved_by_admin_id,policy_decision_sha256,approved_at,expires_at,authorized_stages)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'operator_attested_fee_source_v1',
        $5::uuid,$6,now(),$7::timestamptz,$8::text[])
      ON CONFLICT (owner_user_id,release_id) DO NOTHING RETURNING grant_id`,
      [grantId,r.ownerUserId,r.releaseId,REVIEWED_OPERATOR_FEE_SHA256,
        adminId,FEE_SOURCE_DECISION_SHA256,new Date(expiry).toISOString(),[...STAGES]]);
    if(added.rows.length!==1)return no("source_grant_already_issued_or_invalid");
    await client.query("COMMIT");committed=true;
    return ok("owner_scoped_fee_source_grant_issued_only",{
      grantId,expiresAt:new Date(expiry).toISOString()});
  }catch{return no("source_grant_not_recorded");}
  finally{if(client){if(!committed){try{await client.query("ROLLBACK");}catch{}}client.release();}}
}
export async function revokeReviewedFeeSourceGrant(
  adminId:string,raw:unknown,
):Promise<PublicResult>{
  if(!await adminVerified(adminId))return no("administrator_required");
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return no("revocation_request_invalid");
  const r=raw as Record<string,unknown>;
  if(typeof r.grantId!=="string"||!UUID.test(r.grantId)||
     r.confirmation!=="REVOKE_OWNER_FEE_SOURCE_GRANT"||
     typeof r.reason!=="string"||r.reason.trim().length<8||r.reason.trim().length>300)
    return no("explicit_grant_revocation_required");
  try{
    const changed=await pool.query(`
      UPDATE private.strata_fee_source_grants
      SET revoked_at=now(),revocation_reason=$2
      WHERE grant_id=$1::uuid AND revoked_at IS NULL
      RETURNING grant_id`,[r.grantId,r.reason.trim()]);
    return changed.rows.length===1?ok("fee_source_grant_revoked_only",{}):
      no("grant_not_active_or_unknown");
  }catch{return no("fee_source_grant_revocation_failed");}
}
