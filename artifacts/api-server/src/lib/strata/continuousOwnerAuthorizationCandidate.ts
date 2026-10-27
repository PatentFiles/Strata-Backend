/** Candidate only: a standing grant NEVER substitutes for per-order signed exchange
 * reconciliation, current verified API fees, IOC/exit readiness or fencing.
 * This module is deliberately NOT wired to START or order POST until an
 * authenticated AAL2 enrollment/revoke flow and transactional dispatch tests
 * have been completed. Existing technical release remains mandatory.
 */
export const CONTINUOUS_STANDING_CONFIRM =
  "I_EXPLICITLY_AUTHORIZE_REVOCABLE_SAME_SHA_CONTINUOUS_EXECUTION_V1" as const;

export const CONTINUOUS_STANDING_ELIGIBILITY_SQL = `
 SELECT s.authorization_id::text AS grant_id
 FROM private.strata_continuous_owner_authorizations s
 JOIN public.v13_production_account a
  ON a.id=s.execution_account_id AND a.owner_user_id=s.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id
  AND p.execution_account_id=a.id
 JOIN public.strata_configured_stake stake
  ON stake.execution_account_id=a.id
 JOIN private.strata_owner_sha_approvals oa
  ON oa.approval_id=s.source_owner_approval_id
  AND oa.owner_user_id=s.owner_user_id
  AND oa.execution_account_id=a.id AND oa.release_commit_sha=s.release_commit_sha
 JOIN private.strata_protective_exit_release pr
  ON pr.release_id=s.source_release_id
  AND pr.release_commit_sha=s.release_commit_sha
  AND pr.independent_reviewer_id=s.independent_reviewer_id
  AND pr.operator_approver_id=s.owner_user_id
 JOIN private.strata_protective_release_reviews r
  ON r.review_id=s.source_review_id
  AND r.owner_user_id=s.owner_user_id
  AND r.release_commit_sha=s.release_commit_sha
  AND r.reviewer_user_id=s.independent_reviewer_id
 JOIN auth.users reviewer ON reviewer.id=s.independent_reviewer_id
 JOIN public.profiles rp ON rp.id=reviewer.id
 WHERE s.owner_user_id=$2::uuid AND s.release_commit_sha=$1
  AND s.confirmation='I_EXPLICITLY_AUTHORIZE_REVOCABLE_SAME_SHA_CONTINUOUS_EXECUTION_V1'
  AND s.revoked_at IS NULL AND oa.revoked_at IS NULL AND pr.revoked_at IS NULL
  AND s.owner_user_id<>s.independent_reviewer_id
  AND reviewer.email_confirmed_at IS NOT NULL
  AND rp.role IN ('ADMIN','DEVELOPER')
  AND a.commissioned=true AND a.execution_enabled=true
  AND a.kill_switch=false AND a.blocked_reason IS NULL
  AND p.state='APPROVED' AND p.policy_hash=s.approved_policy_hash
  AND stake.configured_stake_cents=s.approved_stake_cents
  AND p.max_entry_stake_cents>=s.approved_stake_cents
  AND p.max_entry_all_in_cents>=s.approved_all_in_cents
  AND a.cash_precision_verified=true
  AND a.reconciled_at >= now()-interval '15 seconds'
  AND EXISTS (
    SELECT 1 FROM private.strata_api_fee_standing_delegations fd
    JOIN private.strata_api_fee_standing_models fm ON fm.model_id=fd.model_id
    WHERE fd.owner_user_id=s.owner_user_id
      AND fd.release_commit_sha=s.release_commit_sha
      AND fd.policy_hash=p.policy_hash
      AND fd.revoked_at IS NULL AND fm.revoked_at IS NULL
      AND fd.valid_until>now() AND fm.valid_until>now()
      AND fd.lease_expires_at>now()
  )
 LIMIT 2`;

const SHA=/^[0-9a-f]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ContinuousEligibility =
  {ok:true;reason:"standing_continuous_eligibility_verified"} |
  {ok:false;reason:string};
export async function inspectContinuousEligibility(
 db:{query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},
 sha:string,owner:string,
):Promise<ContinuousEligibility>{
 if(!SHA.test(sha)||!UUID.test(owner))
  return {ok:false,reason:"standing_identity_invalid"};
 try{
  const observed=await db.query(CONTINUOUS_STANDING_ELIGIBILITY_SQL,[sha,owner]);
  if(observed.rows.length!==1||!UUID.test(String(observed.rows[0]?.grant_id??"")))
   return {ok:false,reason:"standing_authorization_missing_or_unverified"};
  return {ok:true,reason:"standing_continuous_eligibility_verified"};
 }catch{
  return {ok:false,reason:"standing_database_unavailable"};
 }
}

/** Enrollment/revocation are only candidates until this module is backed by
 * a dedicated authenticated owner AAL2 route. They intentionally do NOT
 * start or arm a worker, authorize an order or alter current fee approvals.
 * The INSERT is a single atomic SELECT over existing human attestations.
 */
export const CONTINUOUS_ENROLL_SQL = `
INSERT INTO private.strata_continuous_owner_authorizations
 (owner_user_id,execution_account_id,release_commit_sha,approved_policy_hash,
  approved_stake_cents,approved_all_in_cents,source_release_id,
  source_review_id,source_owner_approval_id,independent_reviewer_id,confirmation)
SELECT a.owner_user_id,a.id,$2::text,p.policy_hash,
 stake.configured_stake_cents,p.max_entry_all_in_cents,
 v.release_id,r.review_id,oa.approval_id,v.independent_reviewer_id,$5
FROM public.v13_production_account a
JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
JOIN public.strata_configured_stake stake ON stake.execution_account_id=a.id
JOIN private.strata_protective_exit_release v
 ON v.release_id=$3::uuid AND v.release_commit_sha=$2
 AND v.operator_approver_id=a.owner_user_id AND v.revoked_at IS NULL
 AND v.expires_at>now()+interval '20 minutes'
JOIN private.strata_protective_release_reviews r
 ON r.review_id=$4::uuid AND r.owner_user_id=a.owner_user_id
 AND r.release_commit_sha=$2 AND r.reviewer_user_id=v.independent_reviewer_id
 AND r.expires_at>now()+interval '60 seconds'
JOIN private.strata_protective_release_qualification q
 ON q.qualification_id=r.qualification_id
 AND q.owner_user_id=a.owner_user_id AND q.release_commit_sha=$2
JOIN private.strata_owner_sha_approvals oa
 ON oa.owner_user_id=a.owner_user_id AND oa.execution_account_id=a.id
 AND oa.release_commit_sha=$2 AND oa.revoked_at IS NULL
JOIN auth.users reviewed ON reviewed.id=v.independent_reviewer_id
JOIN public.profiles reviewer ON reviewer.id=reviewed.id
WHERE a.owner_user_id=$1::uuid AND a.commissioned=true
 AND a.execution_enabled=true AND a.kill_switch=false AND a.blocked_reason IS NULL
 AND a.cash_precision_verified=true AND a.reconciled_at>now()-interval '15 seconds'
 AND p.state='APPROVED' AND p.policy_hash ~ '^[0-9a-f]{64}$'
 AND stake.configured_stake_cents>=500 AND
     stake.configured_stake_cents<=p.max_entry_stake_cents
 AND a.owner_user_id<>v.independent_reviewer_id
 AND reviewed.email_confirmed_at IS NOT NULL
 AND reviewer.role IN ('ADMIN','DEVELOPER')
 AND EXISTS (SELECT 1 FROM private.strata_api_fee_standing_delegations d
  JOIN private.strata_api_fee_standing_models fm ON fm.model_id=d.model_id
  WHERE d.owner_user_id=$1::uuid AND d.release_commit_sha=$2
   AND d.policy_hash=p.policy_hash AND d.revoked_at IS NULL
   AND fm.revoked_at IS NULL AND d.valid_until>now() AND fm.valid_until>now()
   AND d.lease_expires_at>now())
ON CONFLICT DO NOTHING
RETURNING authorization_id::text AS id`;

export const CONTINUOUS_OWNER_REVOKE_SQL = `
UPDATE private.strata_continuous_owner_authorizations
SET revoked_at=now(),revoked_reason='owner_explicit_revocation'
WHERE owner_user_id=$1::uuid AND release_commit_sha=$2
  AND revoked_at IS NULL
RETURNING authorization_id::text AS id`;

/** Caller must already have validated an authenticated AAL2 owner session.
 * No delegated admin proxy, browser-supplied account selector or silent retry.
 */
export async function enrollContinuousOwnerAuthorization(
 db:{query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},
 owner:string,sha:string,releaseId:string,reviewId:string,confirmation:string,
):Promise<{ok:boolean;reason:string;authorizationId?:string}>{
 if(!UUID.test(owner)||!SHA.test(sha)||!UUID.test(releaseId)||
    !UUID.test(reviewId)||confirmation!==CONTINUOUS_STANDING_CONFIRM)
  return {ok:false,reason:"authenticated_explicit_owner_standing_consent_required"};
 try{
  const v=await db.query(CONTINUOUS_ENROLL_SQL,
   [owner,sha,releaseId,reviewId,confirmation]);
  if(v.rows.length!==1||!UUID.test(String(v.rows[0]?.id??"")))
   return {ok:false,reason:"independent_protective_standing_enrollment_unavailable"};
  return {ok:true,reason:"signed_owner_continuous_consent_recorded",
   authorizationId:String(v.rows[0].id)};
 }catch{return {ok:false,reason:"standing_enrollment_database_unavailable"};}
}
export async function revokeContinuousOwnerAuthorization(
 db:{query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},
 owner:string,sha:string,
):Promise<{ok:boolean;reason:string}>{
 if(!UUID.test(owner)||!SHA.test(sha))
  return {ok:false,reason:"owner_or_sha_invalid"};
 try{
  const r=await db.query(CONTINUOUS_OWNER_REVOKE_SQL,[owner,sha]);
  return r.rows.length>0
   ?{ok:true,reason:"owner_continuous_authorization_revoked"}
   :{ok:false,reason:"active_owner_continuous_authorization_missing"};
 }catch{return {ok:false,reason:"standing_revocation_database_unavailable"};}
}
