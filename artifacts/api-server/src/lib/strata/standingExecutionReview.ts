import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed,type OwnerSelfEnrollmentScope} from './ownerSelfReviewMode';
import {standingAuthoritySql} from './ownerSelfReviewMode';
import {pool} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
export const STANDING_REVIEW_CONFIRM='I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1';
export const STANDING_REVIEW_REVOKE='I_REVOKE_MY_STANDING_EXECUTION_TECHNICAL_REVIEW_V1';
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Db=Query&{connect():Promise<Query&{release():void}>};
const deny=(reason:string)=>({ok:false as const,reason,ordersSubmitted:false as const});
/** Retired for new approvals. Historical immutable reviews remain readable
 * and revocable; no caller can create another independent standing review. */
export async function recordStandingExecutionReview(_actor:string,_role:string,_raw:unknown,
 _deps:{db?:Db;sha?:()=>string}={}){
 return deny('independent_review_enrollment_retired_use_owner_self');
}
export async function revokeStandingExecutionReview(actor:string,role:string,raw:unknown,
 deps:{db?:Db;sha?:()=>string}={}){
 const b=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 const sha=(deps.sha??deployedGitSha)();
 if(!UUID.test(actor)||!UUID.test(String(b.reviewId))||!['ADMIN','DEVELOPER'].includes(role)||
  !SHA.test(sha)||b.expectedSha!==sha||b.confirmation!==STANDING_REVIEW_REVOKE)
  return deny('standing_review_revocation_confirmation_required');
 try{
  const r=await (deps.db??pool).query(`UPDATE private.strata_standing_execution_reviews
   SET revoked_at=now(),revocation_reason='independent_reviewer_revoked'
   WHERE release_id=$1::uuid AND independent_reviewer_id=$2::uuid
     AND release_commit_sha=$3 AND revoked_at IS NULL RETURNING release_id`,[b.reviewId,actor,sha]);
  return {ok:r.rows.length===1,reason:r.rows.length===1?'standing_review_revoked':'standing_review_not_found',ordersSubmitted:false as const};
 }catch{return deny('standing_review_revocation_unavailable')}
}
/** Locked in the final protective transaction; no entry consent/lease is
 * borrowed for a risk-reducing exit. No policy/SHA drift or revoked review.
 */
export const STANDING_EXIT_REVIEW_SQL=`SELECT r.release_id
 FROM private.strata_standing_execution_reviews r
 JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE r.owner_user_id=$1::uuid AND r.execution_account_id=$2 AND r.release_commit_sha=$3
   AND r.policy_hash=p.policy_hash AND p.state='APPROVED'
   AND ${standingAuthoritySql('r','r.owner_user_id')} AND r.state='approved'
   AND r.created_at<=now() AND r.revoked_at IS NULL
 LIMIT 2 FOR SHARE OF r,p`;
export async function hasStandingReviewHistory(db:Query,owner:string,account:string,sha:string){
 const r=await db.query(`SELECT release_id FROM private.strata_standing_execution_reviews
  WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3 FOR SHARE`,[owner,account,sha]);
 return r.rows.length>0;
}
export async function checkStandingExitReview(db:Query,owner:string,account:string,sha:string){
 const r=await db.query(STANDING_EXIT_REVIEW_SQL,[owner,account,sha]);return r.rows.length===1;
}
export async function standingExecutionStatus(owner:string,deps:{db?:Query;sha?:()=>string;scope?:()=>OwnerSelfEnrollmentScope|undefined}={}){
 const sha=(deps.sha??deployedGitSha)();
 if(!UUID.test(owner)||!SHA.test(sha))return deny('standing_scope_unavailable');
 const db=deps.db??pool;
 try{
  const a=await db.query(`SELECT a.id,p.policy_hash FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
   WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 AND p.state='APPROVED'`,[owner]);
  if(a.rows.length!==1)return deny('standing_account_policy_unavailable');
  const account=a.rows[0]!;
  const reviews=await db.query(`SELECT release_id,qualification_id,independent_reviewer_id,to_jsonb(r)->>'review_authority' AS review_authority,to_jsonb(r)->>'owner_authorizer_id' AS owner_authorizer_id FROM private.strata_standing_execution_reviews r
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
   AND policy_hash=$4 AND revoked_at IS NULL AND created_at<=now()`,[owner,account.id,sha,account.policy_hash]);
  const grants=await db.query(`SELECT grant_id,revoked_at,policy_hash,reviewed_release_id FROM private.strata_continuous_execution_grants
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
   ORDER BY consented_at DESC,grant_id DESC LIMIT 1`,[owner,account.id,sha]);
  const q=await db.query(`SELECT qualification_id FROM private.strata_protective_release_qualification
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
   AND expires_at>now()+interval '60 seconds' ORDER BY observed_at DESC LIMIT 1`,[owner,account.id,sha]);
  return {ok:true as const,reason:'standing_status',sha,ownerId:owner,accountId:account.id,policyHash:account.policy_hash,
   ownerSelfAvailable:ownerSelfEnrollmentAllowed(owner,account.id,(deps.scope??configuredOwnerSelfScope)()),
   reviewId:reviews.rows.length===1?reviews.rows[0]?.release_id:null,
   reviewQualificationId:reviews.rows.length===1?reviews.rows[0]?.qualification_id:null,
   reviewerId:reviews.rows.length===1?reviews.rows[0]?.independent_reviewer_id:null,
   reviewAuthority:reviews.rows.length===1?(reviews.rows[0]?.review_authority??'INDEPENDENT_V1'):null,
   ownerAuthorizerId:reviews.rows.length===1?reviews.rows[0]?.owner_authorizer_id:null,
   grantExists:grants.rows.length===1&&grants.rows[0]?.revoked_at===null,
   grantActive:grants.rows.length===1&&grants.rows[0]?.revoked_at===null&&grants.rows[0]?.policy_hash===account.policy_hash&&
    reviews.rows.length===1&&grants.rows[0]?.reviewed_release_id===reviews.rows[0]?.release_id,
   grantRevoked:grants.rows.length===1&&grants.rows[0]?.revoked_at!==null,
   qualificationId:q.rows[0]?.qualification_id??null,ordersSubmitted:false as const};
 }catch{return deny('standing_status_unavailable')}
}
