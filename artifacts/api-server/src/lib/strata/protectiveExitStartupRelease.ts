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
 LIMIT 2`;
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
 if(env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE==="false"){
   return {ok:false,reason:"protective_exit_release_disabled"};
 }
 const sha=env.RAILWAY_GIT_COMMIT_SHA;
 if(!sha||!SHA.test(sha))return {ok:false,reason:"protective_exit_release_version_unknown"};
 if(!UUID.test(ownerId))return {ok:false,reason:"protective_exit_owner_unverified"};
 try{
  const evidence=await db.query(PROTECTIVE_STARTUP_RELEASE_SQL,[sha,ownerId]);
  if(evidence.rows.length!==1||
     typeof evidence.rows[0]?.release_id!=="string"||
     !UUID.test(evidence.rows[0].release_id)){
    return {ok:false,reason:"protective_exit_exact_deployed_version_approval_missing"};
  }
 }catch{
  return {ok:false,reason:"protective_exit_release_evidence_unavailable"};
 }
 return {ok:true,reason:"protective_exit_release_verified"};
}
