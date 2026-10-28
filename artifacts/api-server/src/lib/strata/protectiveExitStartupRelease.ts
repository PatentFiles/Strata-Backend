/**
 * Safe, read-only first fence for personal production START. A worker must
 * never open NEW inventory unless its ONE-USE signed protective EXIT path
 * is available and independently released for the exact deployed binary.
 *
 * This verifies no human claims: it consumes existing immutable review rows.
 * The last signed POST repeats a stronger transactional check.
 */
export const PROTECTIVE_STARTUP_RELEASE_SQL = `
 SELECT v.release_id
 FROM private.strata_protective_exit_release v
 WHERE v.release_commit_sha=$1::text
   AND v.state='approved'
   AND v.revoked_at IS NULL
   AND v.created_at<=now() AND v.expires_at>now()+interval '20 minutes'
   AND v.independent_reviewer_id <> $2::uuid
   AND v.operator_approver_id <> v.independent_reviewer_id
 LIMIT 2 FOR SHARE OF v`;
/** Owner-scoped durable code approval for the exact deployed commit. */
export const OWNER_SHA_STARTUP_RELEASE_SQL = `
 SELECT oa.approval_id::text AS release_id
 FROM private.strata_owner_sha_approvals oa
 JOIN public.v13_production_account a
  ON a.id=oa.execution_account_id AND a.owner_user_id=oa.owner_user_id
 WHERE oa.owner_user_id=$2::uuid AND oa.release_commit_sha=$1
  AND oa.revoked_at IS NULL AND a.commissioned=true
  AND a.blocked_reason IS NULL
  AND a.execution_enabled=true AND a.kill_switch=false
 LIMIT 2 FOR SHARE OF oa
`;
const SHA=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Queryable={query(text:string, params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
export type ProtectiveStartupDecision={ok:true;reason:"protective_exit_release_verified"}|
  {ok:false;reason:string};

/** Test-only runtimes are isolated from Railway. No live-transport release is
 * ever enabled by this function; a false positive here does NOT override
 * signed-order final release, position, fee, lease or kill checks.
 */
export async function verifyProtectiveExitStartupRelease(
 db:Queryable,ownerId:string,
 env:NodeJS.ProcessEnv=process.env,
):Promise<ProtectiveStartupDecision>{
 const hosted=Boolean(env.RAILWAY_PROJECT_ID||env.RAILWAY_SERVICE_ID||env.RAILWAY_ENVIRONMENT_ID);
 if(env.NODE_ENV==="test"&&!hosted){
   return {ok:true,reason:"protective_exit_release_verified"};
 }
 // Production START requires an explicit signed-exit capability opt-in.
 // Absent, empty, misspelled and false values must all fail closed.
 if(env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=="true"){
   return {ok:false,reason:"protective_exit_release_disabled"};
 }
 const sha=env.RAILWAY_GIT_COMMIT_SHA;
 if(!sha||!SHA.test(sha))return {ok:false,reason:"protective_exit_release_version_unknown"};
 if(!UUID.test(ownerId))return {ok:false,reason:"protective_exit_owner_unverified"};
 try{
  // Step 12 owner AAL2 consent is a MANDATORY account-specific START gate.
  // It is separate from, and cannot substitute for, independent technical
  // approval of the protective-exit implementation at this exact SHA.
  // A missing schema, missing approval or query outage is NOT legacy authority.
  let own:{rows:Record<string,unknown>[]};
  try { own=await db.query(OWNER_SHA_STARTUP_RELEASE_SQL,[sha,ownerId]); }
  catch {return {ok:false,reason:"owner_code_approval_evidence_unavailable"};}
  if(own.rows.length>1)return {ok:false,reason:"duplicate_owner_code_approval"};
  if(own.rows.length!==1)return {ok:false,reason:"owner_code_approval_missing"};
  if(typeof own.rows[0]?.release_id!=="string"||
     !UUID.test(own.rows[0].release_id))
    return {ok:false,reason:"owner_code_approval_unverified"};
  const evidence=await db.query(PROTECTIVE_STARTUP_RELEASE_SQL,[sha,ownerId]);
  if(evidence.rows.length!==1||
     typeof evidence.rows[0]?.release_id!=="string"||
     !UUID.test(evidence.rows[0].release_id))
    return {ok:false,reason:"protective_exit_exact_deployed_version_approval_missing"};
 }catch{
  return {ok:false,reason:"protective_exit_release_evidence_unavailable"};
 }
 return {ok:true,reason:"protective_exit_release_verified"};
}
