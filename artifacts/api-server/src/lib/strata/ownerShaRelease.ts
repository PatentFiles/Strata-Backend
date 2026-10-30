import {migrationFlatHistoryCheck} from "./ownerApiFeePolicyMigration";
import { V13_MIN_ENTRY_STAKE_CENTS } from "../v13LiveMoneyRisk";
import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {readReleaseOwner, loadedMaterial, PROVISIONAL_REPAIR_CONFIRM} from "./inAppProtectiveRelease";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import {readUnresolvedIntentMode} from "./workerUncertainOrderGate";
import {digest as v13Digest,type Identity} from "../v13-production/types";

/**
 * A single owner (AAL2 checked by the Strata authentication middleware)
 * authorizes only their own commissioned execution account.
 * No order is submitted or worker started here; platform kill stays privileged.
 */
export const OWNER_SHA_RELEASE_CONFIRM =
  "I_AUTHORIZE_MY_ACCOUNT_FOR_THIS_EXACT_SHA_AFTER_AUTHENTICATED_PRODUCTION_QUALIFICATION";
export const OWNER_SHA_REVOKE_CONFIRM = "I_REVOKE_MY_OWN_SHA_APPROVAL_WITH_ZERO_EXPOSURE";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[];rowCount?:number}>};
type Client=Query&{release():void};
type Db=Query&{connect():Promise<Client>};
type Dependencies={db?:Db;sha?:()=>string;readFeeds?:typeof readOwnedKalshiFeeds;now?:()=>number};
const reject=(reason:string)=>({ok:false,reason,ordersSubmitted:false as const});
const isTrue=(v:unknown)=>v===true||v==="t";
const micros=(v:unknown):bigint|null=>{
 try {if(typeof v==="string"&&/^\d+$/.test(v))return BigInt(v);
      if(typeof v==="bigint"&&v>=0n)return v;
      return null;}catch{return null;}
};

export async function ownerShaApprovalStatus(ownerId:string,sha:string,db:Query=pool) {
 if(!UUID.test(ownerId)||!SHA.test(sha))return {available:false,active:false,approvalId:null};
 try{
  const found=await db.query(`SELECT approval_id::text FROM private.strata_owner_sha_approvals
    WHERE owner_user_id=$1::uuid AND release_commit_sha=$2 AND revoked_at IS NULL
    ORDER BY confirmed_at DESC LIMIT 2`,[ownerId,sha]);
  return {available:true,active:found.rows.length===1,
    approvalId:found.rows.length===1?String(found.rows[0]?.approval_id):null};
 }catch{return {available:false,active:false,approvalId:null};}
}

// This projection never grants entry authority. Only the explicit restore POST
// may reuse existing consent after fresh signed proof and locked revalidation.
async function restoreReviewCurrent(db:Query,owner:string,account:string,sha:string,policyHash:unknown,lock=false,required=false){
 const reviews=await db.query(`SELECT release_id,state,revoked_at,policy_hash,independent_reviewer_id,
  (created_at<=now()) AS created_current FROM private.strata_standing_execution_reviews
  WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
  ${lock?"FOR SHARE":""}`,[owner,account,sha]);
 if(!reviews.rows.length)return !required;
 return reviews.rows.filter(r=>r.state==="approved"&&r.revoked_at===null&&r.policy_hash===policyHash&&
  r.created_current===true&&UUID.test(String(r.independent_reviewer_id))&&r.independent_reviewer_id!==owner).length===1;
}
export async function ownerRestoreStatus(ownerId:string,sha:string,db:Query=pool){
 let scope:Record<string,string>={sha};
 const no=(reason:string)=>({available:false,reason,...scope});
 if(!UUID.test(ownerId)||!SHA.test(sha))return no("owner_restore_identity_invalid");
 try{
  const owner=await readReleaseOwner(db,ownerId);
  if(!owner.ok)return no(owner.reason);
  const a=owner.account;
  scope={sha,accountId:String(a.id),policyId:String(a.policy_id),policyHash:String(a.policy_hash)};
  if(isTrue(a.execution_enabled)||!isTrue(a.kill_switch)||a.blocked_reason!=null)
   return no("owner_restore_requires_disabled_unfrozen_account");
  const approvals=await db.query(`SELECT approval_id FROM private.strata_owner_sha_approvals
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
   AND revoked_at IS NULL`,[ownerId,a.id,sha]);
  if(approvals.rows.length!==1)return no("owner_restore_existing_sha_approval_required");
  const history=await db.query(`SELECT grant_id FROM private.strata_continuous_execution_grants
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3`,[ownerId,a.id,sha]);
  if(!await restoreReviewCurrent(db,ownerId,String(a.id),sha,a.policy_hash,false,history.rows.length>0))
   return no("owner_restore_current_standing_review_required");
  return {available:true,reason:"owner_restore_explicit_consent_and_fresh_proof_required",sha,
   accountId:String(a.id),policyId:String(a.policy_id),policyHash:String(a.policy_hash)};
 }catch{return no("owner_restore_status_unavailable");}
}

export async function authorizeOwnerShaRelease(
 ownerId:string,raw:unknown,deps:Dependencies={}
) {
 const args=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 const sha=(deps.sha??deployedGitSha)(),db=deps.db??pool;
 const restoring=args.restoreExistingApproval===true;
 if(args.restoreExistingApproval!==undefined&&args.restoreExistingApproval!==true)
  return reject("owner_restore_mode_invalid");
 if(restoring&&args.expectedSha!==sha)return reject("owner_restore_exact_sha_required");
 if(!UUID.test(ownerId)||!SHA.test(sha)||args.qualificationId==null||
    !UUID.test(String(args.qualificationId))||args.confirmation!==OWNER_SHA_RELEASE_CONFIRM)
   return reject("owner_identity_sha_qualification_or_confirmation_invalid");
 // Preflight the owner and, if necessary, obtain signed exchange evidence
 // BEFORE opening the 12-second write transaction. The old implementation
 // performed multiple paginated Kalshi GETs while holding FOR UPDATE,
 // causing lock starvation and transaction timeouts on Step 12.
 let preflight:null|{accountId:string;policyId:string;fingerprint:string;
   cashMicros:string;revision:string;observedAtMs:number}=null;
 try{
  const visible=await readReleaseOwner(db,ownerId);
  if(!visible.ok)return reject(visible.reason);
  const a=visible.account;
  if(restoring&&(args.expectedAccountId!==a.id||args.expectedPolicyId!==a.policy_id||
    args.expectedPolicyHash!==a.policy_hash))return reject("owner_restore_account_policy_scope_changed");
  const repair=a.blocked_reason==="awaiting_account_commissioning";
  const alreadyEnabled=isTrue(a.execution_enabled)&&!isTrue(a.kill_switch);
  // A provisioned account may have durable eligibility but be stopped.
  // Still require authenticated, signed, zero-exposure reconciliation.
  const stagedStopped=isTrue(a.execution_enabled)&&isTrue(a.kill_switch);
  if(repair&&args.provisionalRepairConfirmation!==PROVISIONAL_REPAIR_CONFIRM)
    return reject("explicit_owner_commissioning_repair_confirmation_required");
  if(!repair&&args.provisionalRepairConfirmation!==undefined)
    return reject("commissioning_repair_confirmation_not_applicable");
  if(restoring&&(repair||alreadyEnabled||stagedStopped))return reject("owner_restore_requires_disabled_unfrozen_account");
  if(restoring||repair||alreadyEnabled||stagedStopped){
    const material=await loadedMaterial(db,a);
    if(!material)return reject("account_restricted_signer_unavailable");
    const observedAtMs=(deps.now??Date.now)();
    const feeds=await (deps.readFeeds??readOwnedKalshiFeeds)(material,observedAtMs);
    if(!feeds.ok||feeds.observedAtMs!==observedAtMs||
       (deps.now??Date.now)()-observedAtMs>15_000||
       String(feeds.cashMicros)!==String(a.cash_micros)||
       (!restoring&&(feeds.orders.length!==0||feeds.fills.length!==0||feeds.settlements.length!==0)))
      return reject("fresh_exchange_zero_exposure_unverified");
    const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(a.key_fingerprint)};
    const history=restoring?(await db.query("SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id",[a.id])).rows.map(r=>typeof r.request==="string"?JSON.parse(r.request):r.request):[];
    const snapshot=personalAccountSnapshot(identity,feeds,history);
    if(!("identity" in snapshot)||(restoring
      ? feeds.historicalCoverageComplete!==true||!migrationFlatHistoryCheck(snapshot,history).ok
      : snapshot.orders.length||snapshot.fills.length||snapshot.positions.length||snapshot.settlements.length))
      return reject("owner_release_snapshot_mismatch");
    preflight={accountId:String(a.id),policyId:String(a.policy_id),
      fingerprint:String(a.key_fingerprint),cashMicros:String(a.cash_micros),
      revision:String(a.revision),observedAtMs};
  }
 }catch{return reject("owner_release_preflight_unavailable");}
 let tx:Client|null=null,done=false;
 try{
  tx=await db.connect();
  await tx.query("BEGIN");
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const owner=await readReleaseOwner(tx,ownerId);
  if(!owner.ok)return reject(owner.reason);
  const a=owner.account;
  const accountId=String(a.id);
  if(restoring&&(args.expectedAccountId!==a.id||args.expectedPolicyId!==a.policy_id||
    args.expectedPolicyHash!==a.policy_hash))return reject("owner_restore_account_policy_scope_changed");
  const account=await tx.query(`SELECT id,owner_user_id,commissioned,execution_enabled,kill_switch,
    blocked_reason,cash_precision_verified,cash_micros::text,reserved_micros::text,
    reconciled_at,minimum_exit_micros,key_fingerprint,revision,policy_id
    FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid
    FOR UPDATE`,[accountId,ownerId]);
  if(account.rows.length!==1)return reject("owned_execution_account_unavailable");
  const current=account.rows[0]!;
  if(!isTrue(current.commissioned)||!isTrue(current.cash_precision_verified)||
     (!isTrue(current.execution_enabled)&&!isTrue(current.kill_switch)))
    return reject("commissioning_or_account_kill_state_invalid");
  // A previously commissioned account's stale provisioner marker can be
  // repaired by its AAL2 owner after an authenticated zero-exposure proof.
  // Require a *separate* owner confirmation; never silently clear a freeze.
  const repairing=current.blocked_reason==="awaiting_account_commissioning";
   // Legacy accounts could already be enabled before exact-SHA approvals existed.
   // Require authenticated zero-exposure and no active worker lease before
   // honoring a first owner consent. Never grandfather live authority.
   const legacyEnabled=isTrue(current.execution_enabled)&&!isTrue(current.kill_switch);
   const stagedStopped=isTrue(current.execution_enabled)&&isTrue(current.kill_switch);
  if(repairing && args.provisionalRepairConfirmation!==PROVISIONAL_REPAIR_CONFIRM)
    return reject("explicit_owner_commissioning_repair_confirmation_required");
  if(!repairing && args.provisionalRepairConfirmation!==undefined)
    return reject("commissioning_repair_confirmation_not_applicable");
  const global=await tx.query(`SELECT live_execution_enabled,manual_kill_switch,mode
    FROM public.live_execution_config WHERE id='singleton' ${restoring?"FOR SHARE":""}`);
  // Exact-SHA owner consent can be recorded while global trading remains killed.
  // Final entry still requires a separate privileged global release, independent
  // protective-exit proof, current signed cash/fees and per-order admission.
  const globalLive=isTrue(global.rows[0]?.live_execution_enabled);
  const globalKilled=isTrue(global.rows[0]?.manual_kill_switch);
  if(global.rows.length!==1||global.rows[0]?.mode!=="V13_PRODUCTION"||
    globalLive===globalKilled)
    return reject("global_execution_kill_state_inconsistent");
  const proof=await tx.query(`SELECT qualification_id::text,evidence_digest
    FROM private.strata_protective_release_qualification
    WHERE qualification_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3
      AND release_commit_sha=$4 AND expires_at>now()+interval '60 seconds'
      ${restoring?"AND observed_at<=now() AND observed_at>now()-interval '60 seconds'":""}
    FOR SHARE`,[args.qualificationId,ownerId,accountId,sha]);
  if(proof.rows.length!==1)return reject("fresh_authenticated_production_qualification_required");
  const unresolved=await readUnresolvedIntentMode((sql,p)=>tx!.query(sql,p),accountId);
  if(!unresolved.ok||unresolved.mode!=="entries")return reject("unresolved_orders_prevent_owner_release");
  const stake=Number(a.configured_stake_cents),cash=micros(current.cash_micros),reserved=micros(current.reserved_micros);
  if(!Number.isSafeInteger(stake)||stake<V13_MIN_ENTRY_STAKE_CENTS||stake>2_500_000||
    !Number.isSafeInteger(Number(a.max_entry_stake_cents))||
    stake>Number(a.max_entry_stake_cents)||stake>Number(a.max_entry_all_in_cents)||
    cash===null||reserved===null||reserved>cash||
    BigInt(stake)*10000n>cash-reserved) return reject("approved_stake_or_available_cash_unverified");

  if(current.blocked_reason!=null&&current.blocked_reason!=="awaiting_account_commissioning")
    return reject("account_frozen_for_independent_remediation");
  if(repairing || legacyEnabled || stagedStopped){
     // A stale marker repair or adoption of a pre-enabled legacy account
     // requires a fresh, fully empty authenticated exchange and local ledger.
    const counts=await tx.query(`SELECT
     (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1) intents,
     (SELECT count(*)::int FROM public.v13_production_event WHERE account_id=$1) events,
     (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) positions,
     (SELECT count(*)::int FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1) reservations,
     (SELECT count(*)::int FROM private.kalshi_account_worker_lease
       WHERE execution_account_id=$1 AND state='owned'
         AND heartbeat_at>now()-interval '30 seconds') running_leases`,[accountId]);
    const c=counts.rows[0]!;
    if(counts.rows.length!==1||["intents","events","positions","reservations","running_leases"].some(k=>Number(c[k])!==0))
      return reject("owner_release_requires_zero_financial_history_or_worker_lease");
    // Revalidate the external snapshot against the locked account and
    // current revocable evidence. No external I/O is permitted inside BEGIN.
    if(!preflight||preflight.accountId!==accountId||
       preflight.policyId!==String(a.policy_id)||
       preflight.fingerprint!==String(current.key_fingerprint)||
       preflight.cashMicros!==String(current.cash_micros)||
       preflight.revision!==String(current.revision)||
       (deps.now??Date.now)()-preflight.observedAtMs>15_000)
      return reject("fresh_exchange_preflight_stale_or_account_changed");
    const now=preflight.observedAtMs;
     if(repairing){
     const repaired=await tx.query(`UPDATE public.v13_production_account
      SET blocked_reason=NULL,revision=revision+1
      WHERE id=$1 AND owner_user_id=$2::uuid
      AND blocked_reason='awaiting_account_commissioning'
      AND commissioned=true AND reserved_micros=0
      AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=$1)
      AND NOT EXISTS(SELECT 1 FROM public.v13_production_event WHERE account_id=$1)
      RETURNING id`,[accountId,ownerId]);
    if(repaired.rows.length!==1)return reject("commissioning_repair_fence_failed");
    const audit={ownerId,accountId,sha,providerReadAtMs:now,
      qualificationId:String(args.qualificationId),qualificationDigest:proof.rows[0]?.evidence_digest};
    await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
      VALUES($1,$2,'OWNER_COMMISSIONING_FREEZE_REPAIR',$3::jsonb,$4)`,
      [randomUUID(),accountId,JSON.stringify(audit),v13Digest(audit)]);
     }
   }
   if(restoring){
    if(current.policy_id!==args.expectedPolicyId)return reject("owner_restore_account_policy_scope_changed");
    if(isTrue(current.execution_enabled)||!isTrue(current.kill_switch)||current.blocked_reason!=null||
       reserved!==0n||!preflight||preflight.accountId!==accountId||
       preflight.policyId!==String(a.policy_id)||preflight.fingerprint!==String(current.key_fingerprint)||
       preflight.cashMicros!==String(current.cash_micros)||preflight.revision!==String(current.revision)||
       (deps.now??Date.now)()<preflight.observedAtMs||(deps.now??Date.now)()-preflight.observedAtMs>5000)
      return reject("owner_restore_fresh_flat_account_proof_required");
    const lease=await tx.query(`SELECT state,arm_requested,credential_fingerprint
      FROM private.kalshi_account_worker_lease
      WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[accountId,ownerId]);
    if(lease.rows.length!==1||lease.rows[0]?.state!=="released"||lease.rows[0]?.arm_requested!==false||
       lease.rows[0]?.credential_fingerprint!==current.key_fingerprint)
      return reject("owner_restore_worker_must_be_released_and_disarmed");
    const flat=await tx.query(`SELECT
      (SELECT count(*)::text FROM public.v13_production_intent WHERE account_id=$1 AND
       (NOT terminal OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)) intents,
      (SELECT count(*)::text FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
      (SELECT count(*)::text FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1
        AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits`,[accountId]);
    if(flat.rows.length!==1||!["intents","positions","exits"].every(k=>flat.rows[0]?.[k]==="0"))
      return reject("owner_restore_local_exposure_or_uncertainty");
    // Standing history is sticky: revoked or missing standing scope cannot
    // fall back to the initial owner-only approval path.
    const policy=await tx.query(`SELECT policy_hash FROM public.v13_live_money_policy
      WHERE id=$1 AND execution_account_id=$2 AND state='APPROVED' FOR SHARE`,[a.policy_id,accountId]);
    if(policy.rows.length!==1||policy.rows[0]?.policy_hash!==args.expectedPolicyHash)
      return reject("owner_restore_account_policy_scope_changed");
    const history=await tx.query(`SELECT grant_id FROM private.strata_continuous_execution_grants
      WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3 FOR UPDATE`,[ownerId,accountId,sha]);
    // Restore readiness, never standing financial authority. A revoked grant
    // stays revoked; START still requires a separately consented active grant.
    if(!await restoreReviewCurrent(tx,ownerId,accountId,sha,a.policy_hash,true,history.rows.length>0))
      return reject("owner_restore_current_standing_review_required");
   }
   const existing=await tx.query(`SELECT approval_id::text FROM private.strata_owner_sha_approvals
    WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
    AND revoked_at IS NULL FOR UPDATE`,[ownerId,accountId,sha]);
  if(existing.rows.length>1)return reject("duplicate_owner_sha_approval");
  let approvalId=existing.rows.length===1?String(existing.rows[0]?.approval_id):null;
  if(restoring&&!approvalId)return reject("owner_restore_existing_sha_approval_required");
  if(!approvalId){
    const saved=await tx.query(`INSERT INTO private.strata_owner_sha_approvals
      (owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest)
      VALUES($1::uuid,$2,$3,$4::uuid,$5) RETURNING approval_id::text`,[
      ownerId,accountId,sha,args.qualificationId,proof.rows[0]?.evidence_digest]);
    if(saved.rows.length!==1)return reject("owner_release_evidence_not_recorded");
    approvalId=String(saved.rows[0]?.approval_id);
  }
  if(!isTrue(current.execution_enabled)){
    // A stopped platform can record durable eligibility without opening the
    // account kill. Never infer permission to trade from this owner consent.
    const enabled=await tx.query(`UPDATE public.v13_production_account
      SET execution_enabled=true,kill_switch=$3::boolean,revision=revision+1
      WHERE id=$1 AND owner_user_id=$2::uuid AND execution_enabled=false
        ${restoring?"AND clock_timestamp() BETWEEN to_timestamp($4::double precision/1000) AND to_timestamp($4::double precision/1000)+interval '5 seconds'":""}
        AND kill_switch=true AND commissioned=true AND blocked_reason IS NULL
      RETURNING id`,restoring?[accountId,ownerId,globalKilled,preflight!.observedAtMs]:[accountId,ownerId,globalKilled]);
    if(enabled.rows.length!==1)return reject("owner_account_activation_fence_failed");
   } else {
     // Already eligible but stopped: owner authorization is a recorded
     // receipt only. Never silently clear the account kill switch here.
     // A later protected ARM flow must requalify the technical exit release.
     if(!legacyEnabled&&!stagedStopped)return reject("owner_account_activation_state_invalid");
     const stillEnabled=await tx.query(`SELECT id FROM public.v13_production_account
       WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true
         AND execution_enabled=true AND kill_switch=$3
         AND blocked_reason IS NULL AND reserved_micros=0`,
       [accountId,ownerId,stagedStopped]);
     if(stillEnabled.rows.length!==1)return reject("preenabled_account_fence_failed");
   }
   const record={ownerId,accountId,sha,approvalId,qualificationId:String(args.qualificationId),restoreExistingApproval:restoring};
  await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
    VALUES($1,$2,'OWNER_SHA_RELEASE_AUTHORIZATION',$3::jsonb,$4)`,
    [randomUUID(),accountId,JSON.stringify(record),v13Digest(record)]);
  await tx.query("COMMIT");done=true;
  return {ok:true,reason:"owner_sha_approved_account_enabled_worker_stopped",sha,approvalId,ordersSubmitted:false as const};
 }catch{return reject("owner_sha_release_transaction_failed");}
 finally{if(tx){if(!done)try{await tx.query("ROLLBACK");}catch{} tx.release();}}
}

export async function revokeOwnerShaRelease(ownerId:string,raw:unknown,deps:Dependencies={}) {
 const args=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 const sha=(deps.sha??deployedGitSha)(),db=deps.db??pool;
 if(!UUID.test(ownerId)||!SHA.test(sha)||args.confirmation!==OWNER_SHA_REVOKE_CONFIRM)
  return reject("owner_sha_revoke_confirmation_required");
 let tx:Client|null=null,done=false;
 try {
  tx=await db.connect();await tx.query("BEGIN");
  const a=await tx.query(`SELECT id FROM public.v13_production_account
    WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE`,[ownerId]);
  if(a.rows.length!==1)return reject("owned_account_missing");
  const accountId=String(a.rows[0]?.id);
  const counts=await tx.query(`SELECT
     (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) positions,
     (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND state NOT IN ('TERMINAL','BLOCKED')) unresolved,
     (SELECT count(*)::int FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND state='owned' AND heartbeat_at > now()-interval '30 seconds') running`,[accountId]);
  const c=counts.rows[0]!;
  if(counts.rows.length!==1||Number(c.positions)!==0||Number(c.unresolved)!==0||Number(c.running)!==0)
    return reject("cannot_revoke_protection_while_exposure_or_worker_active");
  const affected=await tx.query(`UPDATE private.strata_owner_sha_approvals
    SET revoked_at=now() WHERE owner_user_id=$1::uuid AND execution_account_id=$2
    AND release_commit_sha=$3 AND revoked_at IS NULL RETURNING approval_id`,[ownerId,accountId,sha]);
  if(affected.rows.length!==1)return reject("active_owner_sha_approval_not_found");
  const stopped=await tx.query(`UPDATE public.v13_production_account
    SET execution_enabled=false,kill_switch=true,revision=revision+1
    WHERE id=$1 AND owner_user_id=$2::uuid RETURNING id`,[accountId,ownerId]);
  if(stopped.rows.length!==1)return reject("account_kill_not_set");
  await tx.query("COMMIT");done=true;
  return {ok:true,reason:"owner_sha_revoked_entries_disabled",ordersSubmitted:false as const};
 }catch{return reject("owner_sha_revoke_transaction_failed");}
 finally{if(tx){if(!done)try{await tx.query("ROLLBACK");}catch{} tx.release();}}
}
