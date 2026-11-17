import {pool} from '@workspace/db';
import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
type Query={query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const noAuthority={ordersSubmitted:false as const,workerStarted:false as const,tradingAuthorized:false as const,retryAuthorized:false as const};
/** Historical receipt only. Neither current eligibility nor permission to retry.
 * Missing/ambiguous records must not erase a client-side pending journal. */
export async function ownerSelfReviewOutcome(owner:string,raw:unknown,db:Query=pool){
 const unknown=()=>({outcome:'UNKNOWN' as const,...noAuthority});
 const b=raw as Record<string,unknown>;
 if(!UUID.test(owner)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==4||
  Object.keys(b).some(k=>!['expectedSha','accountId','policyHash','qualificationId'].includes(k))||
  typeof b.expectedSha!=='string'||!/^[a-f0-9]{40}$/.test(b.expectedSha)||
  typeof b.accountId!=='string'||!b.accountId||b.accountId.length>200||
  typeof b.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(b.policyHash)||
  typeof b.qualificationId!=='string'||!UUID.test(b.qualificationId))return unknown();
 try{
  const result=await db.query(`SELECT r.release_id,r.owner_user_id::text,r.execution_account_id,
   r.release_commit_sha,r.policy_hash,r.qualification_id::text,r.owner_authorizer_id::text,
   r.review_authority,r.independent_reviewer_id,r.confirmation,r.state,r.revoked_at
   FROM private.strata_standing_execution_reviews r
   JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
   JOIN private.strata_protective_release_qualification q ON q.qualification_id=r.qualification_id
    AND q.owner_user_id=r.owner_user_id AND q.execution_account_id=r.execution_account_id
    AND q.release_commit_sha=r.release_commit_sha
   WHERE r.owner_user_id=$1::uuid AND r.owner_authorizer_id=$1::uuid
    AND r.execution_account_id=$2 AND r.release_commit_sha=$3 AND r.policy_hash=$4
    AND r.qualification_id=$5::uuid AND r.review_authority='OWNER_SELF_V1'
    AND r.independent_reviewer_id IS NULL AND r.confirmation=$6
    AND r.state='approved' AND r.created_at<=now()
   LIMIT 2`,[owner,b.accountId,b.expectedSha,b.policyHash,b.qualificationId,OWNER_SELF_REVIEW_CONFIRM]);
  if(result.rows.length!==1)return unknown();
  const r=result.rows[0]!;
  if(typeof r.release_id!=='string'||!UUID.test(r.release_id)||r.owner_user_id!==owner||
   r.owner_authorizer_id!==owner||r.execution_account_id!==b.accountId||r.release_commit_sha!==b.expectedSha||
   r.policy_hash!==b.policyHash||r.qualification_id!==b.qualificationId||r.review_authority!=='OWNER_SELF_V1'||
   r.independent_reviewer_id!==null||r.confirmation!==OWNER_SELF_REVIEW_CONFIRM||r.state!=='approved')return unknown();
  return {outcome:'RECORDED' as const,...noAuthority,ownerId:owner,accountId:b.accountId,
   sha:b.expectedSha,policyHash:b.policyHash,qualificationId:b.qualificationId,
   reviewId:r.release_id,ownerAuthorizerId:owner,reviewAuthority:'OWNER_SELF_V1' as const,revoked:r.revoked_at!==null};
 }catch{return unknown();}
}
