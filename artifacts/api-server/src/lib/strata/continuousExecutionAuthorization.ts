import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { deployedGitSha } from "./deployedGitSha";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
export const CONTINUOUS_OWNER_CONFIRM =
  "I_AUTHORIZE_REVOCABLE_CONTINUOUS_EXECUTION_FOR_MY_REVIEWED_EXACT_SHA_V1";
export const CONTINUOUS_OWNER_REVOKE =
  "I_REVOKE_MY_CONTINUOUS_EXECUTION_GRANT_AND_BLOCK_NEW_ENTRIES_V1";
type Row=Record<string,unknown>;
type Conn={query(sql:string,params?:unknown[]):Promise<{rows:Row[]}>;release():void};
type Db={connect():Promise<Conn>;query:Conn["query"]};
const denied=(reason:string)=>({ok:false as const,reason,workerStarted:false as const,ordersSubmitted:false as const});
const hash=(proof:unknown)=>createHash("sha256").update(JSON.stringify(proof)).digest("hex");
const truth=(v:unknown)=>v===true||v==="t";

/** A new, explicit AAL2 owner consent is required before automatic renewal.
 * Neither the existing human technical release nor its signatures are copied.
 * The account, policy hash, original distinct reviewer and deployed SHA
 * are immutable scope boundaries of the standing grant.
 */
export async function enrollContinuousGrant(ownerId:string,raw:unknown,
 deps:{db?:Db;sha?:()=>string}={}){
 const d=raw&&typeof raw==="object"?raw as Row:{};
 const sha=(deps.sha??deployedGitSha)();
 if(!UUID.test(ownerId)||!SHA.test(sha)||d.confirmation!==CONTINUOUS_OWNER_CONFIRM||d.expectedSha!==sha)
   return denied("explicit_authenticated_standing_owner_consent_required");
 const db=deps.db??pool;
 let c:Conn|null=null,committed=false;
 try{
  c=await db.connect();await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout='1500ms'");
  await c.query("SET LOCAL statement_timeout='12000ms'");
  const ac=await c.query(`
   SELECT a.id,a.owner_user_id,a.commissioned,a.execution_enabled,a.kill_switch,
     a.blocked_reason,p.policy_hash,p.state AS policy_state
   FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id
     AND p.execution_account_id=a.id
   WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
   FOR UPDATE OF a`,[ownerId]);
  const a=ac.rows[0];
  if(ac.rows.length!==1||!a||!truth(a.commissioned)||
    !truth(a.execution_enabled)||truth(a.kill_switch)||
    a.blocked_reason!==null||a.policy_state!=="APPROVED"||
    !DIGEST.test(String(a.policy_hash)))
    return denied("standing_owner_account_policy_not_ready");
  if(d.accountId!==a.id||d.policyHash!==a.policy_hash)return denied("standing_owner_scope_changed");
  const authorized=await c.query(`
   SELECT oa.approval_id FROM private.strata_owner_sha_approvals oa
   WHERE oa.owner_user_id=$1::uuid AND oa.execution_account_id=$2
     AND oa.release_commit_sha=$3 AND oa.revoked_at IS NULL LIMIT 2`,
    [ownerId,a.id,sha]);
  if(authorized.rows.length!==1)return denied("standing_owner_exact_sha_approval_missing");
  const technical=await c.query(`
   SELECT r.release_id,r.independent_reviewer_id
   FROM private.strata_standing_execution_reviews r
   WHERE r.release_commit_sha=$1 AND r.state='approved'
     AND r.revoked_at IS NULL AND r.created_at<=now()
     AND r.independent_reviewer_id<>$2::uuid
     AND r.owner_user_id=$2::uuid AND r.execution_account_id=$3 AND r.policy_hash=$4
   ORDER BY r.created_at DESC LIMIT 2 FOR SHARE`,[sha,ownerId,a.id,a.policy_hash]);
  if(technical.rows.length!==1)return denied("standing_independent_release_not_current");
  const reviewer=String(technical.rows[0]?.independent_reviewer_id);
  if(!UUID.test(reviewer))return denied("standing_independent_reviewer_identity_invalid");
  const prior=await c.query(`
   SELECT grant_id FROM private.strata_continuous_execution_grants
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2
     AND release_commit_sha=$3 AND revoked_at IS NULL FOR UPDATE`,
   [ownerId,a.id,sha]);
  if(prior.rows.length>1)return denied("standing_duplicate_grants");
  if(prior.rows.length===1)return denied("standing_grant_already_exists");
  const grantId=randomUUID();
  const added=await c.query(`
   INSERT INTO private.strata_continuous_execution_grants
    (grant_id,owner_user_id,execution_account_id,release_commit_sha,policy_hash,
     reviewed_release_id,independent_reviewer_id,owner_confirmation)
   VALUES ($1,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8)
   RETURNING grant_id`,
   [grantId,ownerId,a.id,sha,a.policy_hash,technical.rows[0]?.release_id,
    reviewer,CONTINUOUS_OWNER_CONFIRM]);
  if(added.rows.length!==1)return denied("standing_grant_not_recorded");
  await c.query(`
   INSERT INTO private.strata_continuous_execution_audit
     (grant_id,execution_account_id,kind,reason)
   VALUES($1::uuid,$2,'GRANT_AUTHORIZED','authenticated_owner_opt_in')`,[grantId,a.id]);
  await c.query("COMMIT");committed=true;
  return {ok:true as const,reason:"standing_owner_grant_recorded",
    grantId,releaseCommitSha:sha,workerStarted:false as const,ordersSubmitted:false as const};
 }catch{return denied("standing_grant_database_unavailable")}
 finally{if(c){if(!committed)try{await c.query("ROLLBACK")}catch{};c.release()}}
}

export async function revokeContinuousGrant(ownerId:string,raw:unknown,
 deps:{db?:Db;sha?:()=>string}={}){
 const d=raw&&typeof raw==="object"?raw as Row:{};
 const sha=(deps.sha??deployedGitSha)();
 if(!UUID.test(ownerId)||!SHA.test(sha)||d.confirmation!==CONTINUOUS_OWNER_REVOKE||d.expectedSha!==sha)
  return denied("explicit_authenticated_standing_revocation_required");
 const db=deps.db??pool;let c:Conn|null=null,committed=false;
 try{
  c=await db.connect();await c.query("BEGIN");
  const r=await c.query(`
   UPDATE private.strata_continuous_execution_grants g
    SET revoked_at=now(),revocation_reason='owner_revoked'
   WHERE g.owner_user_id=$1::uuid AND g.release_commit_sha=$2
    AND g.revoked_at IS NULL
   RETURNING grant_id,execution_account_id`,[ownerId,sha]);
  if(r.rows.length!==1)return denied("no_unique_active_standing_grant");
  await c.query(`
   INSERT INTO private.strata_continuous_execution_audit
    (grant_id,execution_account_id,kind,reason)
   VALUES($1::uuid,$2,'GRANT_REVOKED','owner_authenticated_revocation')`,
   [r.rows[0]?.grant_id,r.rows[0]?.execution_account_id]);
  await c.query("COMMIT");committed=true;
  return {ok:true as const,reason:"standing_grant_revoked_new_entries_disabled",
   workerStarted:false as const,ordersSubmitted:false as const};
 }catch{return denied("standing_revocation_unavailable")}
 finally{if(c){if(!committed)try{await c.query("ROLLBACK")}catch{};c.release()}}
}

/** Cheap read-only eligibility gate. A 5-minute lease is REQUIRED even though
 * owner consent itself has no timed expiry. No valid signed proof -> no ENTRY.
 * Use separately from existing hard STOP/KILL and per-order proof gates.
 */
export const CONTINUOUS_ENTRY_AUTHORIZATION_SQL=`
 SELECT g.grant_id
 FROM private.strata_continuous_execution_grants g
 JOIN private.strata_continuous_execution_technical_lease l
   ON l.grant_id=g.grant_id AND l.execution_account_id=g.execution_account_id
 JOIN private.kalshi_account_worker_lease w
   ON w.execution_account_id=g.execution_account_id AND w.owner_user_id=g.owner_user_id
     AND w.fencing_token=l.fencing_token
 JOIN private.strata_standing_execution_reviews r
   ON r.release_id=g.reviewed_release_id
 JOIN public.v13_production_account a
   ON a.id=g.execution_account_id AND a.owner_user_id=g.owner_user_id
 JOIN public.v13_live_money_policy p
   ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN private.strata_owner_sha_approvals oa
   ON oa.owner_user_id=g.owner_user_id
     AND oa.execution_account_id=g.execution_account_id
     AND oa.release_commit_sha=g.release_commit_sha
 WHERE g.owner_user_id=$1::uuid AND g.release_commit_sha=$2
   AND g.revoked_at IS NULL AND oa.revoked_at IS NULL
   AND g.policy_hash=p.policy_hash AND p.state='APPROVED'
   AND r.release_commit_sha=g.release_commit_sha AND r.state='approved'
   AND r.revoked_at IS NULL
   AND r.created_at<=now()
   AND r.owner_user_id=g.owner_user_id AND r.execution_account_id=g.execution_account_id
   AND r.policy_hash=g.policy_hash
   AND r.independent_reviewer_id=g.independent_reviewer_id
   AND g.independent_reviewer_id<>g.owner_user_id
   AND a.commissioned=true AND a.execution_enabled=true
   AND a.kill_switch=false AND a.blocked_reason IS NULL
   AND w.state='owned' AND w.arm_requested=true AND w.account_kill=false
   AND w.heartbeat_at>now()-interval '15 seconds'
   AND l.observed_at<=now() AND l.expires_at>now()+interval '20 seconds'
 LIMIT 2 FOR SHARE OF g,oa,r,w,l,p`;
/** Read-only preliminary reuse; no human/technical expiry is extended. */
export const CONTINUOUS_CURRENT_LEASE_SQL=CONTINUOUS_ENTRY_AUTHORIZATION_SQL.replace(
 "LIMIT 2 FOR SHARE OF g,oa,r,w,l,p",
 `AND g.execution_account_id=$3 AND g.policy_hash=$4
  AND a.cash_micros=$5::bigint AND w.fencing_token=$6::bigint
  AND l.expires_at>now()+interval '120 seconds'
  AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations ex
    WHERE ex.execution_account_id=g.execution_account_id
      AND ex.state IN ('PREPARED','DISPATCHED','UNKNOWN'))
  LIMIT 2`);
export async function checkContinuousEligibility(db:Pick<Db,"query">,ownerId:string,sha:string){
 if(!UUID.test(ownerId)||!SHA.test(sha))return false;
 try{
  const r=await db.query(CONTINUOUS_ENTRY_AUTHORIZATION_SQL,[ownerId,sha]);
  return r.rows.length===1;
 }catch{return false}
}

/** START bootstrap checks durable owner consent and independently reviewed SHA
 * but deliberately does not grant ENTRY eligibility: signed refresh is still
 * required before the worker can submit a new position.
 */
export const CONTINUOUS_STARTUP_GRANT_SQL=`
 SELECT g.grant_id FROM private.strata_continuous_execution_grants g
 JOIN private.strata_standing_execution_reviews r ON r.release_id=g.reviewed_release_id
 JOIN public.v13_production_account a ON a.id=g.execution_account_id
   AND a.owner_user_id=g.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id
   AND p.execution_account_id=a.id
 JOIN private.strata_owner_sha_approvals oa
   ON oa.owner_user_id=g.owner_user_id AND oa.execution_account_id=a.id
   AND oa.release_commit_sha=g.release_commit_sha
 WHERE g.owner_user_id=$1::uuid AND g.release_commit_sha=$2
   AND g.revoked_at IS NULL AND oa.revoked_at IS NULL
   AND g.policy_hash=p.policy_hash AND p.state='APPROVED'
   AND r.release_commit_sha=g.release_commit_sha AND r.state='approved'
   AND r.revoked_at IS NULL
   AND r.created_at<=now()
   AND r.owner_user_id=g.owner_user_id AND r.execution_account_id=g.execution_account_id
   AND r.policy_hash=g.policy_hash
   AND r.independent_reviewer_id=g.independent_reviewer_id
   AND g.independent_reviewer_id<>g.owner_user_id
   AND a.commissioned=true AND a.execution_enabled=true
   AND a.kill_switch=false AND a.blocked_reason IS NULL
 LIMIT 2`;
export async function checkContinuousBootstrap(db:Pick<Db,"query">,ownerId:string,sha:string){
 if(!UUID.test(ownerId)||!SHA.test(sha))return false;
 try {const r=await db.query(CONTINUOUS_STARTUP_GRANT_SQL,[ownerId,sha]);
  return r.rows.length===1;}catch{return false}
}

/** Must be invoked ONLY by the server AFTER its signed/complete account
 * exchange read and reconciliation, with a current fenced worker token.
 * Human approvals are immutable; the worker only renews short technical
 * evidence, and every rollover is auditable.
 */
export async function renewContinuousTechnicalLease(input:{
 ownerId:string;accountId:string;releaseSha:string;policyHash:string;
 observedAtMs:number;cashMicros:string;fencingToken:string;
 authenticated:boolean;complete:boolean;unexplainedCashActivity:boolean;
 providerEvidence:unknown;
},deps:{db?:Db;now?:()=>number}={}){
 if(!UUID.test(input.ownerId)||!SHA.test(input.releaseSha)||
  !DIGEST.test(input.policyHash)||!Number.isSafeInteger(input.observedAtMs)||
  input.authenticated!==true||input.complete!==true||
  input.unexplainedCashActivity!==false||
  !/^\d+$/.test(input.cashMicros)||!/^[1-9]\d*$/.test(input.fencingToken))
  return denied("standing_signed_exchange_proof_invalid");
 const now=(deps.now??Date.now)();
 if(input.observedAtMs>now||now-input.observedAtMs>15_000)
  return denied("standing_signed_exchange_proof_stale");
 const db=deps.db??pool;let c:Conn|null=null,committed=false;
 try{
  // Reconciliation has already committed fresh signed account evidence. While
  // its existing lease has ample time left, revalidate all scope/revocation,
  // cash, fence and exit-hold predicates in one read instead of opening the
  // multi-round-trip renewal transaction on every worker tick. This preliminary
  // result never replaces the locked final entry/exit authorization.
  const current=await db.query(CONTINUOUS_CURRENT_LEASE_SQL,
    [input.ownerId,input.releaseSha,input.accountId,input.policyHash,input.cashMicros,input.fencingToken]);
  if(current.rows.length===1)return {ok:true as const,reason:"standing_short_technical_lease_current",
    ordersSubmitted:false as const,workerStarted:false as const};
  if(current.rows.length>1)return denied("standing_duplicate_technical_lease");
  c=await db.connect();await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout='1000ms'");
  await c.query("SET LOCAL statement_timeout='5000ms'");
  // Use the same account-first lock order as final entry dispatch.
  await c.query('SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',
   [input.accountId,input.ownerId]);
  const r=await c.query(`
   SELECT g.grant_id,a.cash_micros::text AS cash_micros,
     w.state,w.arm_requested,w.account_kill,w.fencing_token::text AS fencing_token
   FROM private.strata_continuous_execution_grants g
   JOIN public.v13_production_account a
     ON a.id=g.execution_account_id AND a.owner_user_id=g.owner_user_id
   JOIN public.v13_live_money_policy p
     ON p.id=a.policy_id AND p.execution_account_id=a.id
   JOIN private.kalshi_account_worker_lease w
     ON w.execution_account_id=a.id AND w.owner_user_id=g.owner_user_id
   JOIN private.strata_standing_execution_reviews r ON r.release_id=g.reviewed_release_id
   JOIN private.strata_owner_sha_approvals oa
     ON oa.owner_user_id=g.owner_user_id AND oa.execution_account_id=a.id
       AND oa.release_commit_sha=g.release_commit_sha
   WHERE g.owner_user_id=$1::uuid AND g.execution_account_id=$2
     AND g.release_commit_sha=$3 AND g.policy_hash=$4
     AND g.revoked_at IS NULL AND oa.revoked_at IS NULL
     AND r.state='approved' AND r.revoked_at IS NULL
     AND r.release_commit_sha=g.release_commit_sha
     AND r.independent_reviewer_id=g.independent_reviewer_id
     AND r.independent_reviewer_id<>g.owner_user_id
     AND r.created_at<=now()
   AND r.owner_user_id=g.owner_user_id AND r.execution_account_id=g.execution_account_id
   AND r.policy_hash=g.policy_hash
     AND a.commissioned=true AND a.execution_enabled=true
     AND a.kill_switch=false AND a.blocked_reason IS NULL
     AND p.policy_hash=g.policy_hash AND p.state='APPROVED'
     AND w.state='owned' AND w.arm_requested=true
     AND w.account_kill=false AND w.heartbeat_at>now()-interval '15 seconds'
   FOR UPDATE OF g,w FOR SHARE OF r,oa,p,a`,
   [input.ownerId,input.accountId,input.releaseSha,input.policyHash]);
  const v=r.rows[0];
  if(r.rows.length!==1||!v||
     String(v.cash_micros)!==input.cashMicros||
     String(v.fencing_token)!==input.fencingToken)
    return denied("standing_fencing_account_or_cash_mismatch");
  // Independent order/exit and fee checks are separate entry gates.
  const hold=await c.query(`
   SELECT 1 FROM private.strata_emergency_exit_reservations
   WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')
   LIMIT 1`,[input.accountId]);
  if(hold.rows.length)return denied("standing_unresolved_protective_exit");
  // Avoid a write on each 2.5-second heartbeat. Rotate only as the
  // five-minute signed technical lease approaches its two-minute margin.
  const existing=await c.query(`
   SELECT expires_at,fencing_token::text AS fencing_token FROM private.strata_continuous_execution_technical_lease
   WHERE grant_id=$1 FOR UPDATE`,[v.grant_id]);
  if(existing.rows.length>1)return denied("standing_duplicate_technical_lease");
  if(existing.rows.length===1&&
     String(existing.rows[0]?.fencing_token)===input.fencingToken&&
     Date.parse(String(existing.rows[0]?.expires_at))>now+120_000){
    await c.query("COMMIT");committed=true;
    return {ok:true as const,reason:"standing_short_technical_lease_current",
     ordersSubmitted:false as const,workerStarted:false as const};
  }
  const dg=hash({owner:input.ownerId,account:input.accountId,sha:input.releaseSha,
   policy:input.policyHash,observedAtMs:input.observedAtMs,cash:input.cashMicros,
   token:input.fencingToken,provider:input.providerEvidence});
  const lease=await c.query(`
   INSERT INTO private.strata_continuous_execution_technical_lease
    (grant_id,execution_account_id,observed_at,expires_at,evidence_digest,fencing_token,generation)
   VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '5 minutes',$4,$5::bigint,1)
   ON CONFLICT(grant_id) DO UPDATE SET
     observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,
     evidence_digest=EXCLUDED.evidence_digest,fencing_token=EXCLUDED.fencing_token,
     generation=private.strata_continuous_execution_technical_lease.generation+1
   RETURNING grant_id`,[v.grant_id,input.accountId,new Date(input.observedAtMs),dg,input.fencingToken]);
  if(lease.rows.length!==1)return denied("standing_lease_not_committed");
  await c.query(`
   INSERT INTO private.strata_continuous_execution_audit
    (grant_id,execution_account_id,kind,evidence_digest,reason)
   VALUES($1,$2,'LEASE_RENEWED',$3,'signed_owned_reconciliation')`,
    [v.grant_id,input.accountId,dg]);
  await c.query("COMMIT");committed=true;
  return {ok:true as const,reason:"standing_short_technical_lease_renewed",
   ordersSubmitted:false as const,workerStarted:false as const};
 }catch{return denied("standing_lease_renewal_unavailable")}
 finally{if(c){if(!committed)try{await c.query("ROLLBACK")}catch{};c.release()}}
}

/** An opt-in (including a revoked opt-in) selects standing authority for this
 * scope. It must never fall back to a still-current legacy release. Missing
 * schema or database failure is unknown authority, not "no grant".
 */
export async function hasContinuousGrantHistory(db:Pick<Db,"query">,ownerId:string,sha:string){
 if(!UUID.test(ownerId)||!SHA.test(sha))throw new Error("standing_scope_invalid");
 const rows=await db.query(`SELECT grant_id FROM private.strata_continuous_execution_grants
   WHERE owner_user_id=$1::uuid AND release_commit_sha=$2 FOR SHARE`,[ownerId,sha]);
 return rows.rows.length>0;
}
