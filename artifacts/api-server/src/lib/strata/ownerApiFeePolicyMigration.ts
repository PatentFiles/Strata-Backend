import {createHash,randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {computeV13LiveMoneyPolicyHash} from "../v13LiveMoneyRisk";
import {digest as auditDigest} from "../v13-production/types";
import {approvedFromRow} from "./ownerStakePolicyAmendment";
import {verifyReviewedApiFeeSourceStage,API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from "./apiFeeSourceStage";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import type {Identity,Request} from "../v13-production/types";
import {loadedMaterial,PROVISIONAL_REPAIR_CONFIRM} from "./inAppProtectiveRelease";

/** Owner AAL2 route only. Never switches a live/armed account or fabricates fee provenance. */
export const OWNER_API_FEE_MIGRATION_CONFIRM="I_APPROVE_MIGRATING_MY_ACCOUNT_TO_REVIEWED_API_FEES_V2";
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
type Inputs={db?:Db;verify?:typeof verifyReviewedApiFeeSourceStage;read?:typeof readOwnedKalshiFeeds;now?:()=>number};
const txt=(x:unknown)=>typeof x==="string"?x:"";
const safeTime=(x:unknown)=>{const n=Date.parse(String(x??""));return Number.isFinite(n)?n:NaN;};

/** GET preview has zero mutation and exposes only eligibility, never credentials. */
export async function previewOwnedApiFeeMigration(ownerId:string,deps:Inputs={}):Promise<Result>{
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
  if(a.fee_policy_version===API_SOURCE_POLICY_VERSION)return fail("already_using_reviewed_api_fee_policy");
  // Provide exact immutable expected prior-policy identity for the owner
  // to review and for the confirm endpoint to compare atomically.
  if(!POLICY_ID.test(txt(a.policy_id))||!SHA.test(txt(a.policy_hash))||
     !Number.isSafeInteger(Number(a.version))||Number(a.version)<1)
    return fail("previous_policy_identity_unverified");
  if(a.execution_enabled!==false||a.kill_switch!==true)return fail("stop_and_disarm_before_fee_migration");
  if(a.blocked_reason!==null&&a.blocked_reason!==undefined&&a.blocked_reason!=="awaiting_account_commissioning")
   return fail("unresolved_account_risk_freeze");
  if(a.cash_precision_verified!==true||Date.now()-safeTime(a.reconciled_at)>15*60_000)
   return fail("fresh_cash_reconciliation_required");
  return {ok:true,reason:"owner_fee_migration_preview_only",policyMigrated:false,tradingAuthorized:false,
   expectedPolicyId:txt(a.policy_id),expectedPolicyHash:txt(a.policy_hash),
   expectedPolicyVersion:Number(a.version),
    requiresCommissioningRepair:a.blocked_reason==='awaiting_account_commissioning'};
 }catch{return fail("fee_migration_preview_unavailable");}
 finally{tx?.release();}
}
/** Explicit owner mutation. Transaction fences account, policies, fee grant and in-flight orders. */
export async function migrateOwnedApiFeePolicy(ownerId:string,raw:unknown,deps:Inputs={}):Promise<Result>{
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 if(!UUID.test(ownerId)||b.confirmation!==OWNER_API_FEE_MIGRATION_CONFIRM||
    !POLICY_ID.test(txt(b.expectedPolicyId))||!SHA.test(txt(b.expectedPolicyHash))||
    !Number.isSafeInteger(b.expectedPolicyVersion)||Number(b.expectedPolicyVersion)<1)
   return fail("explicit_owner_fee_migration_version_confirmation_required");
 const verify=deps.verify??verifyReviewedApiFeeSourceStage;
 const first=await verify(ownerId,"STEP_9");
 if(!first.ok)return fail("reviewed_api_fee_"+first.reason);
 const db=deps.db??pool;
 let tx:Awaited<ReturnType<Db["connect"]>>|null=null,done=false;
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
  if(a.execution_enabled!==false||a.kill_switch!==true)return fail("stop_and_disarm_before_fee_migration");
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
  const exposure=await tx.query(`SELECT
   (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND state IN ('DISPATCHED','UNKNOWN')) intents,
   (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
   (SELECT count(*)::int FROM private.kalshi_account_worker_lease
      WHERE execution_account_id=$1 AND state='owned') workers,
   (SELECT count(*)::int FROM private.strata_emergency_exit_reservations
      WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits`,[id]);
  const ex=exposure.rows[0];
  if(exposure.rows.length!==1||[ex?.intents,ex?.positions,ex?.workers,ex?.exits].some(n=>n!==0))
   return fail("orders_positions_workers_or_exits_not_proven_empty");
  const material=await loadedMaterial(tx as never,{
   ...a,owner_id:ownerId
  });
  if(!material)return fail("restricted_signer_unavailable");
  const feeds=await (deps.read??readOwnedKalshiFeeds)(material,now);
  if(!feeds.ok)return fail(feeds.reason);
  if(feeds.observedAtMs!==now||(deps.now??Date.now)()-now>45_000||
     String(feeds.cashMicros)!==String(a.cash_micros)||
     [feeds.orders,feeds.fills,feeds.positions,feeds.settlements].some(x=>x.length!==0))
   return fail("authenticated_exchange_flat_cash_proof_required");
  const rs=await tx.query(`SELECT * FROM public.v13_live_money_policy
   WHERE id=$1 AND execution_account_id=$2 AND created_by=$3
    AND state='APPROVED' FOR UPDATE`,[a.policy_id,id,ownerId]);
  const old=rs.rows.length===1?approvedFromRow(rs.rows[0]!):null;
  if(!old||old.policyHash!==computeV13LiveMoneyPolicyHash(old)||
     old.policyHash!==b.expectedPolicyHash||old.version!==b.expectedPolicyVersion)
   return fail("approved_policy_hash_or_version_changed");
  if(old.feePolicyVersion===API_SOURCE_POLICY_VERSION)return fail("already_using_reviewed_api_fee_policy");
  const fresh=await verify(ownerId,"STEP_9",first.identity.sourceUrl);
  if(!fresh.ok||fresh.identity.grantId!==first.identity.grantId||
    fresh.identity.digest!==first.identity.digest)return fail("reviewed_api_fee_grant_changed");
  const g=await tx.query(`SELECT g.grant_id FROM private.strata_api_fee_source_grants g
    JOIN private.strata_api_fee_owner_consents c ON c.grant_id=g.grant_id
      AND c.owner_user_id=g.owner_user_id
    JOIN private.strata_api_fee_rate_reviews r ON r.owner_user_id=g.owner_user_id
      AND r.reviewer_user_id=g.issuer_admin_id AND r.rate_decision_digest=g.rate_decision_digest
    WHERE g.grant_id=$1::uuid AND g.owner_user_id=$2::uuid
      AND g.policy_version=$3 AND g.scope='KXBTC15M:INDEX2'
      AND g.revoked_at IS NULL AND g.expires_at>now()+interval '45 seconds'
      AND c.revoked_at IS NULL AND c.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'
      AND r.revoked_at IS NULL AND r.expires_at>now()+interval '45 seconds'
      AND g.issuer_admin_id<>g.owner_user_id
      AND g.authorized_stages @> ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[]
      FOR SHARE OF g,c,r`,[fresh.identity.grantId,ownerId,API_SOURCE_POLICY_VERSION]);
  if(g.rows.length!==1)return fail("reviewed_fee_source_grant_expired_or_revoked");
  const versions=await tx.query(`SELECT COALESCE(MAX(version),0)::int last_version
    FROM public.v13_live_money_policy WHERE execution_account_id=$1`,[id]);
  const nextVersion=Number(versions.rows[0]?.last_version)+1;
  if(!Number.isSafeInteger(nextVersion)||nextVersion<=old.version)return fail("policy_version_unverified");
  const policyId=randomUUID(),at=new Date();
  const next={...old,id:policyId,version:nextVersion,supersedesPolicyId:old.id,
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
     p.capital_limit_cents,p.max_entry_stake_cents,p.max_entry_all_in_cents,p.max_open_positions,
     p.max_daily_loss_cents,p.max_total_loss_cents,p.max_quote_age_ms,p.max_fee_evidence_age_ms,
     $3,$4,$5,p.require_full_depth,p.entry_time_in_force,p.entry_limit_source,$6,$7,$8
   FROM public.v13_live_money_policy p WHERE p.id=$9 AND p.state='REVOKED'
    AND p.execution_account_id=$10 RETURNING id`,[
   policyId,nextVersion,next.feePolicyVersion,next.feeSourceUrl,next.feeFormulaVersion,
   next.policyHash,ownerId,at.toISOString(),old.id,id]);
  if(inserted.rows.length!==1)return fail("replacement_policy_insert_failed");
  const commissioningDigest=createHash("sha256").update(JSON.stringify({
    accountId:id,fingerprint:txt(a.key_fingerprint),fee:fresh.identity.digest,policyId
  })).digest("hex");
  const linked=await tx.query(`UPDATE public.v13_production_account
    SET policy_id=$1,fee_artifact_digest=$2,commissioning_digest=$3,revision=revision+1,
      blocked_reason=CASE WHEN blocked_reason='awaiting_account_commissioning'
        AND $7::boolean THEN NULL ELSE blocked_reason END
    WHERE id=$4 AND owner_user_id=$5::uuid AND policy_id=$6
      AND execution_enabled=false AND kill_switch=true AND commissioned=true
      AND (blocked_reason IS NULL OR ($7::boolean AND blocked_reason='awaiting_account_commissioning'))
    RETURNING id`,[policyId,fresh.identity.digest,commissioningDigest,id,ownerId,old.id,repairing]);
  if(linked.rows.length!==1)return fail("account_policy_switch_conflict");
  await tx.query(`UPDATE private.strata_owner_sha_approvals
    SET revoked_at=now() WHERE owner_user_id=$1::uuid
      AND execution_account_id=$2 AND revoked_at IS NULL`,[ownerId,id]);
  const event={accountId:id,ownerId,oldPolicyId:old.id,newPolicyId:policyId,
   oldPolicyHash:old.policyHash,newPolicyHash:next.policyHash,feeDigest:fresh.identity.digest,
   grantId:fresh.identity.grantId,reason:"owner_authorized_pdf_to_reviewed_api_source",
   staleActivationRequiresFreshRequest:true,staleCommissioningFreezeRepaired:repairing};
  await tx.query(`INSERT INTO public.v13_production_observation
     (id,account_id,kind,payload,digest)
     VALUES($1,$2,'OWNER_API_FEE_POLICY_MIGRATION',$3::jsonb,$4)`,
    [randomUUID(),id,JSON.stringify(event),auditDigest(event)]);
  await tx.query("COMMIT");done=true;
  return {ok:true,reason:"owner_api_fee_policy_migrated_requires_new_activation_request_and_sha_release",
   policyMigrated:true,tradingAuthorized:false,newPolicyId:policyId,newVersion:nextVersion};
 }catch{return fail("fee_migration_transaction_failed");}
 finally{if(tx){if(!done)try{await tx.query("ROLLBACK");}catch{}tx.release();}}
}
