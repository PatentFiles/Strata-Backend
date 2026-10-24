/** #165 V3 owner-scoped transactional migration. Default disabled; exchange proof
 * and safe stopped/fenced worker required; NEVER clears active nonhistorical blocks.
 * No legacy reviewed V2 human signatures are invented or updated.
 */
import {createHash,randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {computeV13LiveMoneyPolicyHash} from "../v13LiveMoneyRisk";
import {digest as auditDigest} from "../v13-production/types";
import {approvedFromRow} from "./ownerStakePolicyAmendment";
import {verifyOwnerV3FeeAuthority,parseV3FeeSource,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from "./ownerFeeV3Authority";
import {TEST_TWENTY_PERCENT_PRESET_ID} from "./sharedPresets";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import type {Identity,Request,Snapshot} from "../v13-production/types";
import {loadedMaterial,PROVISIONAL_REPAIR_CONFIRM} from "./inAppProtectiveRelease";

/** Owner AAL2 route only. STOP is the kill switch ON, not the
 * durable execution eligibility bit. A killed, disarmed lease can be
 * migrated only after authenticated exchange flatness, without ARM/START. */
export const OWNER_V3_POLICY_MIGRATION_CONFIRM="I_APPROVE_MIGRATING_MY_OWN_ACCOUNT_TO_OFFICIAL_MONETARY_FEES_V3";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
// V13 execution-account IDs are opaque strings; historical policy IDs need not be UUIDs.
const POLICY_ID=/^[a-zA-Z0-9_:.\-]{8,160}$/;
type Row=Record<string,unknown>;
type Q={query(sql:string,args?:unknown[]):Promise<{rows:Row[];rowCount?:number|null}>};
type Db={connect():Promise<Q&{release():void}>};
type Failure={ok:false;reason:string;policyMigrated:false;tradingAuthorized:false};
const fail=(reason:string):Failure=>({ok:false,reason,policyMigrated:false,tradingAuthorized:false});
type Result=Failure|{ok:true;reason:string;policyMigrated:boolean;tradingAuthorized:false;
 expectedPolicyId?:string;expectedPolicyHash?:string;expectedPolicyVersion?:number;requiresCommissioningRepair?:boolean;newPolicyId?:string;newVersion?:number};
type Inputs={db?:Db;verify?:typeof verifyOwnerV3FeeAuthority;
 read?:typeof readOwnedKalshiFeeds;now?:()=>number;enabled?:()=>boolean};
const v3Enabled=(deps:Inputs)=>(deps.enabled??(()=>process.env.STRATA_OWNER_FEE_V3_MIGRATION_ENABLED==="true"))();
const txt=(x:unknown)=>typeof x==="string"?x:"";
const safeTime=(x:unknown)=>{const n=Date.parse(String(x??""));return Number.isFinite(n)?n:NaN;};

/** Fail-closed flatness predicate over a complete, authenticated and
 * reconciled exchange snapshot. Historical terminal trades are immutable
 * evidence, not pending exposure. */
export function v3MigrationFlatHistoryCheck(snapshot:Snapshot,requests:Request[]):{ok:true}|{ok:false;reason:string}{
 if(!snapshot.authenticated||!snapshot.complete||!snapshot.cashExact||
    snapshot.unexplainedCashActivity)
  return {ok:false,reason:"authenticated_exchange_history_incomplete"};
 const local=requests.map(r=>r.clientOrderId);
 if(local.some(x=>!x)||new Set(local).size!==local.length||
    snapshot.orders.length!==requests.length)
  return {ok:false,reason:"exchange_and_ledger_history_incomplete"};
 if(snapshot.positions.length!==0||snapshot.orders.some(o=>!o.terminal))
  return {ok:false,reason:"authenticated_exchange_not_flat"};
 // A terminal order alone is NOT proof that all exchange fills were captured.
 // Match every order's reported filled quantity against unique mapped trades;
 // historical archived endpoints can be incomplete even if pagination finishes.
 const orderIds=new Set(snapshot.orders.map(order=>order.orderId));
 const totals=new Map<string,bigint>();
 for(const fill of snapshot.fills){
  if(!orderIds.has(fill.orderId)||!/^\d+$/.test(fill.quantityHundredths))
   return {ok:false,reason:"authenticated_exchange_fills_unreconciled"};
  totals.set(fill.orderId,(totals.get(fill.orderId)??0n)+BigInt(fill.quantityHundredths));
 }
 for(const order of snapshot.orders){
  if(!/^\d+$/.test(order.filledHundredths)||
     (totals.get(order.orderId)??0n)!==BigInt(order.filledHundredths))
    return {ok:false,reason:"authenticated_exchange_fills_unreconciled"};
 }
 return {ok:true};
}
/** GET preview has zero mutation and exposes only eligibility, never credentials. */
export async function previewOwnedV3FeeMigration(ownerId:string,deps:Inputs={}):Promise<Result>{
 if(!UUID.test(ownerId))return fail("owner_identity_invalid");
 const db=deps.db??pool;
 let tx:Awaited<ReturnType<Db["connect"]>>|null=null;
 try{
  tx=await db.connect();
  const rs=await tx.query(`SELECT a.id,a.execution_enabled,a.kill_switch,a.blocked_reason,
    a.commissioned,a.reconciled_at,a.cash_precision_verified,a.policy_id,
    p.state,p.fee_source_url,p.fee_policy_version,p.policy_hash,p.version
    FROM public.v13_production_account a
    JOIN public.v13_live_money_policy p ON p.id=a.policy_id
      AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text
    WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`,[ownerId]);
  if(rs.rows.length!==1)return fail("owned_policy_not_unique");
  const a=rs.rows[0]!;
  if(a.state!=="APPROVED"||a.commissioned!==true)return fail("approved_commissioned_policy_required");
  if(a.fee_policy_version===V3_FEE_POLICY_VERSION)return fail("already_using_owner_v3_fee_policy");
  // Provide exact immutable expected prior-policy identity for the owner
  // to review and for the confirm endpoint to compare atomically.
  if(!POLICY_ID.test(txt(a.policy_id))||!SHA.test(txt(a.policy_hash))||
     !Number.isSafeInteger(Number(a.version))||Number(a.version)<1)
    return fail("previous_policy_identity_unverified");
  if(a.kill_switch!==true)return fail("stop_and_disarm_before_fee_migration");
  if(a.blocked_reason!==null&&a.blocked_reason!==undefined&&a.blocked_reason!=="awaiting_account_commissioning")
   return fail("unresolved_account_risk_freeze");
  if(a.cash_precision_verified!==true||Date.now()-safeTime(a.reconciled_at)>15*60_000)
   return fail("fresh_cash_reconciliation_required");
  return {ok:true,reason:"owner_v3_fee_migration_preview_only",policyMigrated:false,tradingAuthorized:false,
   expectedPolicyId:txt(a.policy_id),expectedPolicyHash:txt(a.policy_hash),
   expectedPolicyVersion:Number(a.version),
    requiresCommissioningRepair:a.blocked_reason==='awaiting_account_commissioning'};
 }catch{return fail("fee_migration_preview_unavailable");}
 finally{tx?.release();}
}
/** Explicit owner mutation. Transaction fences account, policies, fee grant and in-flight orders. */
export async function migrateOwnedV3FeePolicy(ownerId:string,raw:unknown,deps:Inputs={}):Promise<Result>{
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 if(!UUID.test(ownerId)||b.confirmation!==OWNER_V3_POLICY_MIGRATION_CONFIRM||
    !POLICY_ID.test(txt(b.expectedPolicyId))||!SHA.test(txt(b.expectedPolicyHash))||
    !Number.isSafeInteger(b.expectedPolicyVersion)||Number(b.expectedPolicyVersion)<1)
   return fail("explicit_owner_fee_migration_version_confirmation_required");
 if(!v3Enabled(deps))return fail("owner_v3_fee_policy_migration_feature_disabled");
 if(!parseV3FeeSource(txt(b.expectedV3SourceUrl)))
   return fail("owner_v3_exact_fee_authority_identity_required");
 const verify=deps.verify??verifyOwnerV3FeeAuthority;
 const first=await verify(ownerId,"STEP_9",txt(b.expectedV3SourceUrl));
 if(!first.ok)return fail("owner_v3_fee_"+first.reason);
 const db=deps.db??pool;
 // Signed provider reads are intentionally OUTSIDE the serializable write
 // transaction. After the I/O completes, lock and re-check account revision,
 // credentials, policy ID, worker fence, cash and grant before any mutation.
 let tx:Awaited<ReturnType<Db["connect"]>>|null=null,done=false;
 let pre:Row={};let requests:Request[]=[];
 let credentials:Awaited<ReturnType<typeof loadedMaterial>>=null;
 let feedStarted=0;
 let feeds:Awaited<ReturnType<typeof readOwnedKalshiFeeds>>={ok:false,reason:"unverified"};
 try {
   const preTx=await db.connect();
   try{
     const rows=await preTx.query("SELECT * FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2",[ownerId]);
     if(rows.rows.length!==1)return fail("owned_account_not_unique");
     pre=rows.rows[0]!;
     if(pre.commissioned!==true||pre.cash_precision_verified!==true)
       return fail("account_commissioning_unverified");
     if(pre.kill_switch!==true)
       return fail("stop_and_disarm_before_fee_migration");
     if(!txt(pre.id)||txt(pre.policy_id)!==b.expectedPolicyId)
       return fail("policy_concurrency_conflict");
     if(pre.blocked_reason!=null&&pre.blocked_reason!=="awaiting_account_commissioning")
       return fail("unresolved_account_risk_freeze");
     if(pre.blocked_reason==="awaiting_account_commissioning"&&
        b.provisionalRepairConfirmation!==PROVISIONAL_REPAIR_CONFIRM)
       return fail("explicit_owner_commissioning_repair_confirmation_required");
     credentials=await loadedMaterial(preTx as never,{...pre,owner_id:ownerId});
     if(!credentials)return fail("restricted_signer_unavailable");
     const intentRows=await preTx.query("SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id",[pre.id]);
     requests=[];
     for(const row of intentRows.rows){
       const request=typeof row.request==="string"?JSON.parse(row.request):row.request;
       if(!request||typeof request!=="object"||Array.isArray(request))
         return fail("financial_intent_unreadable");
       requests.push(request as Request);
     }
   }finally{preTx.release();}
   // Release the DB connection BEFORE awaiting any external Kalshi requests.
   // Never monopolize pool capacity while an exchange call stalls or retries.
   if(!credentials)return fail("restricted_signer_unavailable");
   feedStarted=(deps.now??Date.now)();
   feeds=await (deps.read??readOwnedKalshiFeeds)(credentials,feedStarted);
 }catch{return fail("authenticated_exchange_preflight_unavailable");}
 finally{credentials=null;}
 if(!feeds.ok)return fail(feeds.reason);
 const feedAge=(deps.now??Date.now)()-feedStarted;
 if(feeds.observedAtMs!==feedStarted||feedAge<0||feedAge>45_000)
   return fail("authenticated_exchange_preflight_stale");
 const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:txt(pre.key_fingerprint)};
 const mapped=personalAccountSnapshot(identity,feeds,requests);
 if(!("identity" in mapped))return fail(mapped.reason);
 const flat=v3MigrationFlatHistoryCheck(mapped,requests);
 if(!flat.ok)return fail(flat.reason);
 const fresh=await verify(ownerId,"STEP_9",first.identity.sourceUrl);
 if(!fresh.ok||fresh.identity.authorityId!==first.identity.authorityId||
   fresh.identity.sourceDigest!==first.identity.sourceDigest||
   fresh.identity.releaseCommitSha!==first.identity.releaseCommitSha)return fail("owner_v3_fee_authority_changed");
 try{
  tx=await db.connect();
  await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const accounts=await tx.query(`SELECT * FROM public.v13_production_account
   WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE`,[ownerId]);
  if(accounts.rows.length!==1)return fail("owned_account_not_unique");
  const a=accounts.rows[0]!,id=txt(a.id);
  if(a.commissioned!==true||a.cash_precision_verified!==true)return fail("account_commissioning_unverified");
  if(a.kill_switch!==true)return fail("stop_and_disarm_before_fee_migration");
  if(a.blocked_reason!=null&&a.blocked_reason!=="awaiting_account_commissioning")
   return fail("unresolved_account_risk_freeze");
  const repairing=a.blocked_reason==="awaiting_account_commissioning";
  if(repairing&&b.provisionalRepairConfirmation!==PROVISIONAL_REPAIR_CONFIRM)
   return fail("explicit_owner_commissioning_repair_confirmation_required");
  if(!repairing&&b.provisionalRepairConfirmation!==undefined)
   return fail("commissioning_repair_confirmation_not_applicable");
  if(!id||id!==txt(pre.id)||String(a.revision)!==String(pre.revision)||
     txt(a.key_fingerprint)!==txt(pre.key_fingerprint)||
     txt(a.kalshi_connection_id)!==txt(pre.kalshi_connection_id)||
     txt(a.policy_id)!==b.expectedPolicyId)return fail("policy_concurrency_conflict");
  const reconciled=safeTime(a.reconciled_at),now=(deps.now??Date.now)();
  if(!Number.isFinite(reconciled)||reconciled>now+10_000||now-reconciled>15*60_000)
   return fail("fresh_cash_reconciliation_required");
  const funds=BigInt(String(a.cash_micros)),reserved=BigInt(String(a.reserved_micros));
  if(funds<0n||reserved!==0n||String(feeds.cashMicros)!==String(a.cash_micros))return fail("cash_or_reservations_unverified");
  // The account revision fences policy/cash changes. A separate re-read
  // fingerprints the financial intent history so newly inserted terminal
  // events cannot escape because they did not bump the account revision.
  const lockedHistory=await tx.query(
    "SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id",[id]);
  const stableHistory=(rows:Row[])=>JSON.stringify(rows.map(row=>
    typeof row.request==="string"?JSON.parse(row.request):row.request));
  if(stableHistory(lockedHistory.rows)!==JSON.stringify(requests))
    return fail("financial_history_changed_during_migration");
  const exposure=await tx.query(`SELECT
   (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND terminal IS DISTINCT FROM TRUE) intents,
   (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
   (SELECT count(*)::int FROM private.kalshi_account_worker_lease
      WHERE execution_account_id=$1 AND (state='owned' OR arm_requested IS DISTINCT FROM FALSE)) workers,
   (SELECT count(*)::int FROM private.strata_emergency_exit_reservations
      WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits`,[id]);
  const ex=exposure.rows[0];
  if(exposure.rows.length!==1||[ex?.intents,ex?.positions,ex?.workers,ex?.exits].some(n=>n!==0))
   return fail("orders_positions_workers_or_exits_not_proven_empty");
  if((deps.now??Date.now)()-feedStarted>45_000)
   return fail("authenticated_exchange_preflight_stale");
  const rs=await tx.query(`SELECT * FROM public.v13_live_money_policy
   WHERE id=$1 AND execution_account_id=$2 AND created_by=$3
    AND state='APPROVED' FOR UPDATE`,[a.policy_id,id,ownerId]);
  const old=rs.rows.length===1?approvedFromRow(rs.rows[0]!):null;
  if(!old||old.policyHash!==computeV13LiveMoneyPolicyHash(old)||
     old.policyHash!==b.expectedPolicyHash||old.version!==b.expectedPolicyVersion)
   return fail("approved_policy_hash_or_version_changed");
  if(old.feePolicyVersion===V3_FEE_POLICY_VERSION)return fail("already_using_owner_v3_fee_policy");
  // The owner V3 grant and original evidence are separate, immutable records.
  // Lock both under account/policy locks; no V2 reviewer or ADMIN impersonation.
  // Expiration, revocation, account, digest and deployed SHA must still match.
  const g=await tx.query(`SELECT g.authority_id
     FROM private.strata_owner_fee_authority_v3 g
     JOIN private.strata_owner_fee_evidence_v3 e
       ON e.attestation_id=g.attestation_id AND e.owner_user_id=g.owner_user_id
       AND e.execution_account_id=g.execution_account_id
     WHERE g.authority_id=$1::uuid AND g.owner_user_id=$2::uuid
       AND g.execution_account_id=$3 AND g.release_commit_sha=$4
       AND g.official_source_digest=$5
       AND g.policy_version=$6 AND g.formula_version=$7
       AND g.scope='KXBTC15M:INDEX2:SUBACCOUNT1'
       AND g.official_source_url='https://kalshi.com/docs/kalshi-fee-schedule.pdf'
       AND g.revoked_at IS NULL AND g.expires_at>now()+interval '45 seconds'
       AND e.revoked_at IS NULL AND e.expires_at>now()+interval '45 seconds'
       AND e.source_digest=g.official_source_digest
       AND e.release_commit_sha=g.release_commit_sha
       AND g.authorized_stages @> ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]
       FOR SHARE OF g,e`,[
     fresh.identity.authorityId,ownerId,id,fresh.identity.releaseCommitSha,
     fresh.identity.sourceDigest,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION]);
  if(g.rows.length!==1)return fail("v3_fee_authority_expired_revoked_or_changed");
  const stake=await tx.query(`SELECT configured_stake_cents,risk_preset_id,
        risk_capital_cents,risk_preset_revision
      FROM public.strata_configured_stake
      WHERE execution_account_id=$1 FOR UPDATE`,[id]);
  if(stake.rows.length!==1||
     stake.rows[0]?.configured_stake_cents!==500||
     stake.rows[0]?.risk_preset_id!==TEST_TWENTY_PERCENT_PRESET_ID||
     Number(stake.rows[0]?.risk_capital_cents)!==2500)
    return fail("owner_approved_five_dollar_twenty_percent_preset_required");
  // Upgrade the *new* immutable policy rather than requiring the legacy
  // $1.50/$2 caps to authorize a $5 stake. All-in exposure (including fees)
  // remains bounded to 20% of the verified $25 risk capital. A nominal $5
  // entry with additional fees is therefore NOT automatically affordable.
  const proposedStakeCents=500,proposedAllInCents=500;
  if(old.capitalLimitCents<2500||funds<25_000_000n||
     !Number.isSafeInteger(old.maxEntryStakeCents)||
     !Number.isSafeInteger(old.maxEntryAllInCents)||
     old.maxEntryStakeCents<=0||old.maxEntryAllInCents<old.maxEntryStakeCents)
    return fail("approved_fee_inclusive_risk_limits_inadequate");
  const leases=await tx.query(`SELECT state,arm_requested,account_kill
     FROM private.kalshi_account_worker_lease
     WHERE execution_account_id=$1 AND owner_user_id=$2::uuid
     FOR UPDATE`,[id,ownerId]);
  if(leases.rows.length>1)return fail("worker_lease_ambiguous");
  if(leases.rows.length===1){
    const lease=leases.rows[0]!;
    if(lease.arm_requested!==false||
      !((lease.state==="killed"&&lease.account_kill===true)||
        (lease.state==="released"&&lease.account_kill===false)))
      return fail("owner_worker_not_safely_disarmed");
  }
  const versions=await tx.query(`SELECT COALESCE(MAX(version),0)::int last_version
    FROM public.v13_live_money_policy WHERE execution_account_id=$1`,[id]);
  const nextVersion=Number(versions.rows[0]?.last_version)+1;
  if(!Number.isSafeInteger(nextVersion)||nextVersion<=old.version)return fail("policy_version_unverified");
  const policyId=randomUUID(),at=new Date();
  const next={...old,id:policyId,version:nextVersion,supersedesPolicyId:old.id,
   maxEntryStakeCents:proposedStakeCents,maxEntryAllInCents:proposedAllInCents,
   feePolicyVersion:fresh.identity.feePolicyVersion,feeSourceUrl:fresh.identity.sourceUrl,
   feeFormulaVersion:fresh.identity.formulaVersion,approvedBy:ownerId,approvedAt:at};
  next.policyHash=computeV13LiveMoneyPolicyHash(next);
  const revoked=await tx.query(`UPDATE public.v13_live_money_policy SET state='REVOKED'
    WHERE id=$1 AND execution_account_id=$2 AND policy_hash=$3 AND state='APPROVED'
    RETURNING id`,[old.id,id,old.policyHash]);
  if(revoked.rows.length!==1)return fail("policy_revision_conflict");
  const inserted=await tx.query(`INSERT INTO public.v13_live_money_policy
   (id,version,supersedes_policy_id,state,execution_account_id,created_by,
    strategy_version,strategy_parameter_set_id,strategy_parameter_hash,entry_policy_version,
    champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,
    capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_open_positions,
    max_daily_loss_cents,max_total_loss_cents,max_quote_age_ms,max_fee_evidence_age_ms,
    fee_policy_version,fee_source_url,fee_formula_version,require_full_depth,
    entry_time_in_force,entry_limit_source,policy_hash,approved_by,approved_at)
   SELECT $1,$2,p.id,'APPROVED',p.execution_account_id,p.created_by,
     p.strategy_version,p.strategy_parameter_set_id,p.strategy_parameter_hash,p.entry_policy_version,
     p.champion_selection_review_id,p.champion_selection_evidence_hash,p.champion_selected_by,p.champion_selected_at,
     p.capital_limit_cents,$11::int,$12::int,p.max_open_positions,
     p.max_daily_loss_cents,p.max_total_loss_cents,p.max_quote_age_ms,p.max_fee_evidence_age_ms,
     $3,$4,$5,p.require_full_depth,p.entry_time_in_force,p.entry_limit_source,$6,$7,$8
   FROM public.v13_live_money_policy p WHERE p.id=$9 AND p.state='REVOKED'
    AND p.execution_account_id=$10 RETURNING id`,[
   policyId,nextVersion,next.feePolicyVersion,next.feeSourceUrl,next.feeFormulaVersion,
   next.policyHash,ownerId,at.toISOString(),old.id,id,
   proposedStakeCents,proposedAllInCents]);
  if(inserted.rows.length!==1)return fail("replacement_policy_insert_failed");
  const commissioningDigest=createHash("sha256").update(JSON.stringify({
    accountId:id,fingerprint:txt(a.key_fingerprint),fee:fresh.identity.sourceDigest,policyId
  })).digest("hex");
  const linked=await tx.query(`UPDATE public.v13_production_account
    SET policy_id=$1,fee_artifact_digest=$2,commissioning_digest=$3,revision=revision+1,
      blocked_reason=CASE WHEN blocked_reason='awaiting_account_commissioning'
        AND $7::boolean THEN NULL ELSE blocked_reason END
    WHERE id=$4 AND owner_user_id=$5::uuid AND policy_id=$6
      AND kill_switch=true AND commissioned=true
      AND (blocked_reason IS NULL OR ($7::boolean AND blocked_reason='awaiting_account_commissioning'))
    RETURNING id`,[policyId,fresh.identity.sourceDigest,commissioningDigest,id,ownerId,old.id,repairing]);
  if(linked.rows.length!==1)return fail("account_policy_switch_conflict");
  await tx.query(`UPDATE private.strata_owner_sha_approvals
    SET revoked_at=now() WHERE owner_user_id=$1::uuid
      AND execution_account_id=$2 AND revoked_at IS NULL`,[ownerId,id]);
  const event={accountId:id,ownerId,oldPolicyId:old.id,newPolicyId:policyId,
   oldPolicyHash:old.policyHash,newPolicyHash:next.policyHash,feeDigest:fresh.identity.sourceDigest,
   grantId:fresh.identity.authorityId,reason:"owner_authorized_pdf_to_owner_v3_source",
   staleActivationRequiresFreshRequest:true,staleCommissioningFreezeRepaired:repairing};
  await tx.query(`INSERT INTO public.v13_production_observation
     (id,account_id,kind,payload,digest)
     VALUES($1,$2,'OWNER_V3_FEE_POLICY_MIGRATION',$3::jsonb,$4)`,
    [randomUUID(),id,JSON.stringify(event),auditDigest(event)]);
  await tx.query("COMMIT");done=true;
  return {ok:true,reason:"owner_api_fee_policy_migrated_requires_new_activation_request_and_sha_release",
   policyMigrated:true,tradingAuthorized:false,newPolicyId:policyId,newVersion:nextVersion};
 }catch{return fail("fee_migration_transaction_failed");}
 finally{if(tx){if(!done)try{await tx.query("ROLLBACK");}catch{}tx.release();}}
}
