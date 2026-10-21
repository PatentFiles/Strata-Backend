import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {readReleaseOwner, loadedMaterial} from "./inAppProtectiveRelease";
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
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[];rowCount?:number|null}>};
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

export async function authorizeOwnerShaRelease(
 ownerId:string,raw:unknown,deps:Dependencies={}
) {
 const args=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 const sha=(deps.sha??deployedGitSha)(),db=deps.db??pool;
 if(!UUID.test(ownerId)||!SHA.test(sha)||args.qualificationId==null||
    !UUID.test(String(args.qualificationId))||args.confirmation!==OWNER_SHA_RELEASE_CONFIRM)
   return reject("owner_identity_sha_qualification_or_confirmation_invalid");
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
  const account=await tx.query(`SELECT id,owner_user_id,commissioned,execution_enabled,kill_switch,
    blocked_reason,cash_precision_verified,cash_micros::text,reserved_micros::text,
    reconciled_at,minimum_exit_micros,key_fingerprint
    FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid
    FOR UPDATE`,[accountId,ownerId]);
  if(account.rows.length!==1)return reject("owned_execution_account_unavailable");
  const current=account.rows[0]!;
  if(!isTrue(current.commissioned)||!isTrue(current.cash_precision_verified)||
     (isTrue(current.execution_enabled)===isTrue(current.kill_switch)))
    return reject("commissioning_or_account_kill_state_invalid");
  const global=await tx.query(`SELECT live_execution_enabled,manual_kill_switch,mode
    FROM public.live_execution_config WHERE id='singleton'`);
  if(global.rows.length!==1||global.rows[0]?.mode!=="V13_PRODUCTION"||
    !isTrue(global.rows[0]?.live_execution_enabled)||isTrue(global.rows[0]?.manual_kill_switch))
    return reject("privileged_global_live_release_required");
  const proof=await tx.query(`SELECT qualification_id::text,evidence_digest
    FROM private.strata_protective_release_qualification
    WHERE qualification_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3
      AND release_commit_sha=$4 AND expires_at>now()+interval '60 seconds'
    FOR SHARE`,[args.qualificationId,ownerId,accountId,sha]);
  if(proof.rows.length!==1)return reject("fresh_authenticated_production_qualification_required");
  const unresolved=await readUnresolvedIntentMode((sql,p)=>tx!.query(sql,p),accountId);
  if(!unresolved.ok||unresolved.mode!=="entries")return reject("unresolved_orders_prevent_owner_release");
  const stake=Number(a.configured_stake_cents),cash=micros(current.cash_micros),reserved=micros(current.reserved_micros);
  if(!Number.isSafeInteger(stake)||stake<150||stake>2_500_000||
    !Number.isSafeInteger(Number(a.max_entry_stake_cents))||
    stake>Number(a.max_entry_stake_cents)||stake>Number(a.max_entry_all_in_cents)||
    cash===null||reserved===null||reserved>cash||
    BigInt(stake)*10000n>cash-reserved) return reject("approved_stake_or_available_cash_unverified");

  if(current.blocked_reason!=null&&current.blocked_reason!=="awaiting_account_commissioning")
    return reject("account_frozen_for_independent_remediation");
  if(current.blocked_reason==="awaiting_account_commissioning"){
    // Repair only the known stale commissioning flag, never an arbitrary freeze.
    // A completely empty exchange AND local financial ledger must be proved
    // by a fresh signed GET within this transaction before the owner release.
    const counts=await tx.query(`SELECT
     (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1) intents,
     (SELECT count(*)::int FROM public.v13_production_event WHERE account_id=$1) events,
     (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) positions,
     (SELECT count(*)::int FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1) reservations`,[accountId]);
    const c=counts.rows[0]!;
    if(counts.rows.length!==1||["intents","events","positions","reservations"].some(k=>Number(c[k])!==0))
      return reject("commissioning_repair_requires_zero_financial_history");
    const material=await loadedMaterial(tx,a);
    if(!material)return reject("account_restricted_signer_unavailable");
    const now=(deps.now??Date.now)();
    const feeds=await(deps.readFeeds??readOwnedKalshiFeeds)(material,now);
    if(!feeds.ok||feeds.observedAtMs!==now||Date.now()-now>15_000||
      String(feeds.cashMicros)!==String(current.cash_micros)||
      feeds.orders.length!==0||feeds.fills.length!==0||
      feeds.positions.length!==0||feeds.settlements.length!==0)
      return reject("fresh_exchange_zero_exposure_unverified");
    const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(a.key_fingerprint)};
    const snapshot=personalAccountSnapshot(identity,feeds,[]);
    if(!("identity" in snapshot)||snapshot.orders.length||snapshot.fills.length||
      snapshot.positions.length||snapshot.settlements.length)
      return reject("commissioning_repair_snapshot_mismatch");
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

  const existing=await tx.query(`SELECT approval_id::text FROM private.strata_owner_sha_approvals
    WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
    AND revoked_at IS NULL FOR UPDATE`,[ownerId,accountId,sha]);
  if(existing.rows.length>1)return reject("duplicate_owner_sha_approval");
  let approvalId=existing.rows.length===1?String(existing.rows[0]?.approval_id):null;
  if(!approvalId){
    const saved=await tx.query(`INSERT INTO private.strata_owner_sha_approvals
      (owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest)
      VALUES($1::uuid,$2,$3,$4::uuid,$5) RETURNING approval_id::text`,[
      ownerId,accountId,sha,args.qualificationId,proof.rows[0]?.evidence_digest]);
    if(saved.rows.length!==1)return reject("owner_release_evidence_not_recorded");
    approvalId=String(saved.rows[0]?.approval_id);
  }
  if(!isTrue(current.execution_enabled)){
    const enabled=await tx.query(`UPDATE public.v13_production_account
      SET execution_enabled=true,kill_switch=false,revision=revision+1
      WHERE id=$1 AND owner_user_id=$2::uuid AND execution_enabled=false
        AND kill_switch=true AND commissioned=true AND blocked_reason IS NULL
      RETURNING id`,[accountId,ownerId]);
    if(enabled.rows.length!==1)return reject("owner_account_activation_fence_failed");
  }
  const record={ownerId,accountId,sha,approvalId,qualificationId:String(args.qualificationId)};
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
     (SELECT count(*)::int FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND state='owned') running`,[accountId]);
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
