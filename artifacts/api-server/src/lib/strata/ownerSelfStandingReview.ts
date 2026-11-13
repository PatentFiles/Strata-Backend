import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';
import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
type Scope={ownerId:string;accountId:string};
type Deps={db?:{connect:()=>Promise<Client>};sha?:()=>string;scope?:()=>Scope|undefined};
export const OWNER_SELF_REVOKE_CONFIRM='I_REVOKE_MY_OWNER_ONLY_STANDING_EXECUTION_REVIEW_V1';
function configuredScope():Scope|undefined{
 const ownerId=process.env.STRATA_OWNER_SELF_RELEASE_OWNER_ID,accountId=process.env.STRATA_OWNER_SELF_RELEASE_ACCOUNT_ID;
 return ownerId&&accountId?{ownerId,accountId}:undefined;
}
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>,release:(error?:Error)=>void};
const note='The authenticated account owner authorizes this exact deployed release after the application signed technical qualification. This is owner consent, not an independent review or a claim of machine attestation.';
/** Existing product qualification + explicit authenticated owner approval. No
 * machine issuer, unrelated reviewer, freeze clearance, ARM or START. */
export async function recordOwnerSelfStandingReview(owner:string,raw:unknown,deps:Deps={}){
 const no=(reason:string)=>({ok:false,reason,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,independentHumanReview:false});
 const b=raw as Record<string,unknown>,sha=(deps.sha??deployedGitSha)(),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if(!uuid.test(owner)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==5||Object.keys(b).some(k=>!['expectedSha','accountId','policyHash','qualificationId','confirmation'].includes(k))||b.confirmation!==OWNER_SELF_REVIEW_CONFIRM||b.expectedSha!==sha||!/^[a-f0-9]{40}$/.test(sha)||!uuid.test(String(b.qualificationId)))return no('explicit_owner_self_review_required');
 const scope=(deps.scope??configuredScope)();
 if(!scope||!uuid.test(scope.ownerId)||!scope.accountId||scope.ownerId!==owner||scope.accountId!==b.accountId)return no('owner_self_account_not_enabled');
 let tx:Client|undefined,commitAttempted=false,done=false,discard:Error|undefined;
 try{
  tx=await(deps.db??pool).connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  const r=await tx.query(`SELECT a.id,p.policy_hash,q.evidence_digest FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text
   JOIN private.strata_protective_release_qualification q ON q.execution_account_id=a.id AND q.owner_user_id=a.owner_user_id
   JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
   WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.subaccount=1 AND a.exchange_index=2
   AND a.commissioned=true AND a.blocked_reason IS NULL AND p.state='APPROVED'
   AND w.state='released' AND w.arm_requested=false AND w.account_kill=false
   AND q.qualification_id=$3::uuid AND q.release_commit_sha=$4 AND q.observed_at<=now() AND q.expires_at>now()+interval '60 seconds'
   FOR SHARE OF a,p,q,w`,[owner,b.accountId,b.qualificationId,sha]);
  if(r.rows.length!==1||r.rows[0].policy_hash!==b.policyHash)return no('owner_self_fresh_qualification_or_stopped_scope_required');
  const a=r.rows[0],url=`https://github.com/PatentFiles/Strata-Backend/commit/${sha}`;
  const digest=createHash('sha256').update(JSON.stringify({actor:owner,owner,sha,qid:b.qualificationId,account:a.id,policy:a.policy_hash,qualification:a.evidence_digest,note,url,scope:OWNER_SELF_REVIEW_CONFIRM})).digest('hex');
  const added=await tx.query(`INSERT INTO private.strata_standing_execution_reviews
   (owner_user_id,execution_account_id,release_commit_sha,policy_hash,independent_reviewer_id,owner_authorizer_id,review_authority,qualification_id,evidence_digest,review_url,review_note,confirmation)
   VALUES($1::uuid,$2,$3,$4,NULL,$1::uuid,'OWNER_SELF_V1',$5::uuid,$6,$7,$8,$9) RETURNING release_id`,[owner,a.id,sha,a.policy_hash,b.qualificationId,digest,url,note,OWNER_SELF_REVIEW_CONFIRM]);
  if(added.rows.length!==1)return no('owner_self_review_not_recorded');
  commitAttempted=true;await tx.query('COMMIT');done=true;
  return {...no('owner_self_review_recorded'),ok:true,reviewId:added.rows[0].release_id,reviewAuthority:'OWNER_SELF_V1',ownerAuthorizerId:owner};
 }catch{if(commitAttempted){discard=Error('owner_self_commit_unknown');return {...no('owner_self_review_outcome_unknown'),outcomeUnknown:true,retryAuthorized:false};}return no('owner_self_review_not_recorded');}
 finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK');}catch{discard=Error('owner_self_rollback_unknown');}tx.release(discard);}}
}

/** Revocation remains available to the authenticated owner even if enrollment
 * is subsequently disabled. It never converts/revokes an independent review. */
export async function revokeOwnerSelfStandingReview(owner:string,raw:unknown,deps:Omit<Deps,'scope'>={}){
 const no=(reason:string)=>({ok:false,reason,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false});
 const b=raw as Record<string,unknown>,sha=(deps.sha??deployedGitSha)(),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if(!uuid.test(owner)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==4||Object.keys(b).some(k=>!['expectedSha','accountId','reviewId','confirmation'].includes(k))||b.confirmation!==OWNER_SELF_REVOKE_CONFIRM||b.expectedSha!==sha||!/^[a-f0-9]{40}$/.test(sha)||!uuid.test(String(b.reviewId))||typeof b.accountId!=='string'||!b.accountId)return no('explicit_owner_self_revocation_required');
 let tx:Client|undefined,commitAttempted=false,done=false,discard:Error|undefined;
 try{
  tx=await(deps.db??pool).connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
  const r=await tx.query(`UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='authenticated_owner_self_revoked'
   WHERE release_id=$1::uuid AND owner_user_id=$2::uuid AND owner_authorizer_id=$2::uuid
   AND execution_account_id=$3 AND release_commit_sha=$4 AND review_authority='OWNER_SELF_V1'
   AND independent_reviewer_id IS NULL AND revoked_at IS NULL RETURNING release_id`,[b.reviewId,owner,b.accountId,sha]);
  if(r.rows.length!==1)return no('owner_self_review_not_found_or_already_revoked');
  commitAttempted=true;await tx.query('COMMIT');done=true;
  return {...no('owner_self_review_revoked'),ok:true,reviewId:b.reviewId};
 }catch{if(commitAttempted){discard=Error('owner_self_revoke_commit_unknown');return {...no('owner_self_revocation_outcome_unknown'),outcomeUnknown:true,retryAuthorized:false};}return no('owner_self_revocation_unavailable');}
 finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK');}catch{discard=Error('owner_self_rollback_unknown');}tx.release(discard);}}
}
