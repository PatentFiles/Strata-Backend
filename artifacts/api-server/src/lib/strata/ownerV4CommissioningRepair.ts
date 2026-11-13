/**
 * Explicit AAL2 owner-only repair for an existing V4 provisional commissioning hold.
 * A real V4 monetary grant, an unchanged official issuer PDF+API observation,
 * signed full Kalshi history, exchange cash parity, zero exposure, immutable
 * policy identity, safe worker state and explicit consent are mandatory.
 * Does not change policies, risk limits, existing trades or kill switches.
 */
import {createHash,randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {loadedMaterial,PROVISIONAL_REPAIR_CONFIRM} from "./inAppProtectiveRelease";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import {migrationFlatHistoryCheck} from "./ownerApiFeePolicyMigration";
import {observeDynamicKalshiFees,computeDynamicFeeModelDigest,type DynamicFeeResult} from "./dynamicOfficialFeeSchedule";
import {approvedDynamicStakeSnapshot} from "./approvedDynamicStakeSnapshot";
import type {Identity,Request} from "../v13-production/types";

export const OWNER_V4_REPAIR_CONFIRM="I_APPROVE_MY_VERIFIED_V4_COMMISSIONING_HOLD_REPAIR";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/i,HASH=/^[a-f0-9]{64}$/i, POLICY=/^[a-zA-Z0-9_:.\\-]{8,160}$/;
const TICKER=/^KXBTC15M-[a-zA-Z0-9-]+$/;
const VERSION="strata_owner_provider_dynamic_fee_v4";
type Row=Record<string,unknown>;
type Conn={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>;release():void};
type Db={connect():Promise<Conn>};
type Deps={db?:Db;now?:()=>number;sha?:()=>string;read?:typeof readOwnedKalshiFeeds;
 material?:typeof loadedMaterial;observe?:(ticker:string)=>Promise<DynamicFeeResult>};
const no=(reason:string)=>({ok:false as const,reason,repaired:false as const,
 tradingAuthorized:false as const,ordersSubmitted:false as const,killSwitchChanged:false as const});
const txt=(v:unknown)=>typeof v==="string"?v:"";
const ts=(v:unknown)=>v instanceof Date?v.getTime():Date.parse(String(v??""));
const cash=(v:unknown)=>/^(0|[1-9]\d*)$/.test(String(v??""));
const accountSql=[
 "SELECT a.*,p.state AS state,p.policy_hash,p.fee_policy_version,",
 "p.max_entry_stake_cents,p.max_entry_all_in_cents,p.capital_limit_cents,",
 "p.max_daily_loss_cents,p.max_total_loss_cents,",
 "s.configured_stake_cents,s.risk_capital_cents,s.risk_preset_id,s.risk_preset_revision",
 "FROM public.v13_production_account a",
 "JOIN public.v13_live_money_policy p ON p.id=a.policy_id",
 "AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text",
 "JOIN public.strata_configured_stake s ON s.execution_account_id=a.id",
 "WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2"
].join(" ");
const historySql="SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id";
const decode=(rows:Row[]):Request[]=>rows.map(r=>{
 const obj=typeof r.request==="string"?JSON.parse(r.request):r.request;
 if(!obj||typeof obj!=="object"||Array.isArray(obj))throw Error("invalid_intent");
 return obj as Request;
});
const fresh=(a:Row,now:number)=>a.cash_precision_verified===true&&
 Number.isSafeInteger(now)&&Number.isFinite(ts(a.reconciled_at))&&
 ts(a.reconciled_at)<=now&&now-ts(a.reconciled_at)<=900_000;
export async function previewOwnerV4CommissioningRepair(ownerId:string,deps:Deps={}){
 if(!UUID.test(ownerId))return no("owner_identity_invalid");
 let c:Conn|null=null;
 try{
  c=await (deps.db??pool).connect();
  const rs=await c.query(accountSql,[ownerId]);
  if(rs.rows.length!==1)return no("owned_policy_missing_or_ambiguous");
  const a=rs.rows[0]!;
  if(a.commissioned!==true||a.state!=="APPROVED"||
     a.fee_policy_version!==VERSION||!approvedDynamicStakeSnapshot(a).ok)
   return no("approved_owner_v4_policy_required");
  if(a.blocked_reason!=="awaiting_account_commissioning")
   return no(a.blocked_reason==null?"provisional_hold_already_cleared":"unrelated_risk_freeze");
  if(a.kill_switch!==true)return no("stop_and_disarm_required");
  if(!fresh(a,(deps.now??Date.now)()))return no("fresh_cash_reconciliation_required");
  if(!POLICY.test(txt(a.policy_id))||!HASH.test(txt(a.policy_hash))||
    !Number.isSafeInteger(Number(a.revision)))
   return no("approved_policy_identity_invalid");
  const sha=(deps.sha??deployedGitSha)().toLowerCase();
  if(!SHA.test(sha))return no("runtime_deployed_sha_unverified");
  const grants=await c.query([
    "SELECT g.authority_id::text,g.expires_at",
    "FROM private.strata_wallet_v4_fee_authority g",
    "JOIN private.strata_wallet_v4_fee_evidence e ON e.evidence_id=g.evidence_id",
    "WHERE g.owner_user_id=$1::uuid AND g.execution_account_id=$2",
    "AND g.deployed_sha=$3 AND g.policy_hash=$4 AND g.policy_version=$5",
    "AND g.revoked_at IS NULL AND g.aal2_verified_at IS NOT NULL",
    "AND g.confirmation='I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4'",
    "AND 'ORDER_ENTRY'=ANY(g.authorized_stages)",
    "AND g.expires_at>now()+interval '90 seconds'",
    "AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id",
    "AND e.model_digest=g.model_digest AND e.deployed_sha=g.deployed_sha",
    "AND e.revoked_at IS NULL AND e.expires_at>now()+interval '90 seconds'",
    "LIMIT 2"].join(" "),[ownerId,a.id,sha,a.policy_hash,VERSION]);
  if(grants.rows.length!==1||!UUID.test(txt(grants.rows[0]?.authority_id)))
   return no("owner_v4_current_fee_grant_required");
  return {ok:true as const,reason:"owner_v4_repair_preview_only",
   expectedPolicyId:txt(a.policy_id),expectedPolicyHash:txt(a.policy_hash),
   expectedRevision:Number(a.revision),authorityId:txt(grants.rows[0]?.authority_id),
   expectedDeployedSha:sha,grantExpiresAt:String(grants.rows[0]?.expires_at),
   repaired:false as const,
   tradingAuthorized:false as const,ordersSubmitted:false as const,killSwitchChanged:false as const};
 }catch{return no("owner_v4_repair_preview_unavailable");}
 finally{c?.release();}
}
export async function repairOwnerV4CommissioningHold(ownerId:string,raw:unknown,deps:Deps={}){
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 if(!UUID.test(ownerId)||b.confirmation!==OWNER_V4_REPAIR_CONFIRM||
  b.provisionalRepairConfirmation!==PROVISIONAL_REPAIR_CONFIRM||
  !UUID.test(txt(b.authorityId))||!POLICY.test(txt(b.expectedPolicyId))||
  !HASH.test(txt(b.expectedPolicyHash))||!Number.isSafeInteger(b.expectedRevision)||
  !SHA.test(txt(b.expectedDeployedSha)))return no("explicit_owner_v4_repair_confirmation_required");
 const sha=(deps.sha??deployedGitSha)().toLowerCase();
 if(sha!==txt(b.expectedDeployedSha).toLowerCase())return no("deployed_sha_changed");
 const db=deps.db??pool;
 const preview=await previewOwnerV4CommissioningRepair(ownerId,deps);
 if(!preview.ok)return no(preview.reason);
 if(preview.expectedPolicyId!==b.expectedPolicyId||
    preview.expectedPolicyHash!==b.expectedPolicyHash||
    preview.expectedRevision!==b.expectedRevision)return no("account_policy_changed");
 let pre:Row,requests:Request[],material:Awaited<ReturnType<typeof loadedMaterial>>=null;
 let c:Conn|null=null;
 try{
  c=await db.connect();
  const rs=await c.query(accountSql,[ownerId]);
  if(rs.rows.length!==1)return no("owned_account_changed");
  pre=rs.rows[0]!;
  if(Number(pre.revision)!==b.expectedRevision||pre.policy_id!==b.expectedPolicyId||
   pre.policy_hash!==b.expectedPolicyHash||pre.kill_switch!==true||
   pre.blocked_reason!=="awaiting_account_commissioning")return no("account_policy_changed");
  const hist=await c.query(historySql,[pre.id]);
  requests=decode(hist.rows);
  material=await(deps.material??loadedMaterial)(c as never,{...pre,owner_id:ownerId});
  if(!material)return no("owner_restricted_signer_unavailable");
 }catch{return no("owner_signed_preflight_unavailable");}
 finally{c?.release();c=null;}
 const start=(deps.now??Date.now)();
 let feeds:Awaited<ReturnType<typeof readOwnedKalshiFeeds>>;
 try{feeds=await(deps.read??readOwnedKalshiFeeds)(material,start);}
 catch{return no("authenticated_exchange_preflight_unavailable");}
 finally{material=null;}
 if(!feeds.ok)return no(feeds.reason);
 if(feeds.observedAtMs!==start||(deps.now??Date.now)()-start>45_000||
    (deps.now??Date.now)()<start)return no("exchange_preflight_stale");
 const id:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:txt(pre!.key_fingerprint)};
 const mapped=personalAccountSnapshot(id,feeds,requests!);
 if(!("identity" in mapped))return no(mapped.reason);
 const flat=migrationFlatHistoryCheck(mapped,requests!);
 if(!flat.ok)return no(flat.reason);
 if(!cash(pre!.cash_micros)||txt(String(pre!.cash_micros))!==feeds.cashMicros||
    String(pre!.reserved_micros)!=="0")return no("signed_cash_or_reservation_mismatch");
 // Exact AAL2 owner-approved V4 evidence, not API-only metadata or an ADMIN
 // impersonation. Read grant before issuer I/O, then lock and recheck below.
 let grant:Row;let lookup:Conn|null=null;
 try{
  lookup=await db.connect();
  const rs=await lookup.query([
   "SELECT e.market_ticker,e.model_digest,e.official_source_digest",
   "FROM private.strata_wallet_v4_fee_authority g",
   "JOIN private.strata_wallet_v4_fee_evidence e ON e.evidence_id=g.evidence_id",
   "WHERE g.authority_id=$1::uuid AND g.owner_user_id=$2::uuid",
   "AND g.execution_account_id=$3 AND g.deployed_sha=$4 AND g.policy_hash=$5",
   "AND g.policy_version=$6 AND g.revoked_at IS NULL",
   "AND g.expires_at>now()+interval '90 seconds'",
   "AND g.confirmation='I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4'",
   "AND g.aal2_verified_at IS NOT NULL AND 'ORDER_ENTRY'=ANY(g.authorized_stages)",
   "AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id",
   "AND e.model_digest=g.model_digest AND e.deployed_sha=g.deployed_sha",
   "AND e.revoked_at IS NULL AND e.expires_at>now()+interval '90 seconds'",
   "LIMIT 2"].join(" "),[b.authorityId,ownerId,pre!.id,sha,pre!.policy_hash,VERSION]);
  if(rs.rows.length!==1)return no("owner_v4_fee_grant_unavailable");
  grant=rs.rows[0]!;
  if(!TICKER.test(txt(grant.market_ticker))||
    !HASH.test(txt(grant.model_digest))||!HASH.test(txt(grant.official_source_digest)))
   return no("fee_grant_identity_invalid");
 }catch{return no("owner_v4_grant_database_unavailable");}
 finally{lookup?.release();}
 let observed:DynamicFeeResult;
 try{observed=await(deps.observe??observeDynamicKalshiFees)(txt(grant!.market_ticker));}
 catch{return no("issuer_fee_reobservation_unavailable");}
 if(!observed.ok)return no("issuer_fee_"+observed.reason);
 const now=(deps.now??Date.now)(),feeAt=ts(observed.model.observedAt);
 if(observed.model.marketTicker!==grant!.market_ticker||
    observed.model.modelDigest!==grant!.model_digest||
    observed.model.publicationDigest!==grant!.official_source_digest||
    observed.model.tradingAuthorized!==false||observed.model.requiresVersionedReview!==true||
    computeDynamicFeeModelDigest(observed.model)!==grant!.model_digest||
    !Number.isFinite(feeAt)||feeAt>now||now-feeAt>15_000||
    now-start>45_000||now-start<0)return no("issuer_monetary_fee_changed_or_stale");
 let tx:Conn|null=null,committed=false;
 try{
  tx=await db.connect();
  await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const accounts=await tx.query(
   "SELECT * FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE",[ownerId]);
  if(accounts.rows.length!==1)return no("account_identity_changed");
  const a=accounts.rows[0]!,nowTx=(deps.now??Date.now)();
  if(a.id!==pre!.id||Number(a.revision)!==b.expectedRevision||
     a.policy_id!==b.expectedPolicyId||a.blocked_reason!=="awaiting_account_commissioning"||
     a.commissioned!==true||a.kill_switch!==true||!fresh(a,nowTx)||
     a.key_fingerprint!==pre!.key_fingerprint||
     a.kalshi_connection_id!==pre!.kalshi_connection_id||
     !cash(a.cash_micros)||String(a.cash_micros)!==feeds.cashMicros||
     String(a.reserved_micros)!=="0"||nowTx-start>45_000||nowTx-start<0)
   return no("locked_account_cash_or_revision_changed");
  const history=await tx.query(historySql,[a.id]);
  if(JSON.stringify(decode(history.rows))!==JSON.stringify(requests!))
   return no("exchange_intent_history_changed");
  const risk=await tx.query([
   "SELECT",
   "(SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND terminal IS DISTINCT FROM TRUE) intents,",
   "(SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,",
   "(SELECT count(*)::int FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND (state='owned' OR arm_requested IS DISTINCT FROM FALSE)) workers,",
   "(SELECT count(*)::int FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits"
   ].join(" "),[a.id]);
  const riskRow=risk.rows[0];
  if(risk.rows.length!==1||[riskRow?.intents,riskRow?.positions,riskRow?.workers,riskRow?.exits].some(v=>v!==0))
   return no("worker_intents_positions_or_exits_unresolved");
  const policy=await tx.query([
   "SELECT p.*,s.configured_stake_cents,s.risk_capital_cents,s.risk_preset_id,s.risk_preset_revision",
   "FROM public.v13_live_money_policy p",
   "JOIN public.strata_configured_stake s ON s.execution_account_id=p.execution_account_id",
   "WHERE p.id=$1 AND p.execution_account_id=$2 AND p.created_by=$3",
   "AND p.state='APPROVED' AND p.policy_hash=$4 AND p.fee_policy_version=$5",
   "FOR SHARE OF p,s"].join(" "),[a.policy_id,a.id,ownerId,b.expectedPolicyHash,VERSION]);
  if(policy.rows.length!==1||!approvedDynamicStakeSnapshot(policy.rows[0]!).ok)
   return no("locked_policy_or_stake_changed");
  const authority=await tx.query([
   "SELECT g.authority_id FROM private.strata_wallet_v4_fee_authority g",
   "JOIN private.strata_wallet_v4_fee_evidence e ON e.evidence_id=g.evidence_id",
   "WHERE g.authority_id=$1::uuid AND g.owner_user_id=$2::uuid AND g.execution_account_id=$3",
   "AND g.deployed_sha=$4 AND g.policy_hash=$5 AND g.model_digest=$6",
   "AND g.policy_version=$7 AND g.revoked_at IS NULL AND g.aal2_verified_at IS NOT NULL",
   "AND g.confirmation='I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4'",
   "AND g.expires_at>now()+interval '45 seconds'",
   "AND 'ORDER_ENTRY'=ANY(g.authorized_stages)",
   "AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id",
   "AND e.deployed_sha=g.deployed_sha AND e.model_digest=g.model_digest",
   "AND e.official_source_digest=$8 AND e.revoked_at IS NULL",
   "AND e.expires_at>now()+interval '45 seconds' FOR SHARE OF g,e"
   ].join(" "),[b.authorityId,ownerId,a.id,sha,b.expectedPolicyHash,
    grant!.model_digest,VERSION,grant!.official_source_digest]);
  if(authority.rows.length!==1)return no("locked_fee_authority_expired_or_changed");
  const updated=await tx.query([
   "UPDATE public.v13_production_account SET blocked_reason=NULL,revision=revision+1",
   "WHERE id=$1 AND owner_user_id=$2::uuid AND policy_id=$3 AND revision=$4",
   "AND commissioned=true AND kill_switch=true",
   "AND blocked_reason='awaiting_account_commissioning' RETURNING id"
  ].join(" "),[a.id,ownerId,b.expectedPolicyId,b.expectedRevision]);
  if(updated.rows.length!==1)return no("account_repair_concurrency_conflict");
  await tx.query([
   "UPDATE private.strata_owner_sha_approvals SET revoked_at=now()",
   "WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND revoked_at IS NULL"
  ].join(" "),[ownerId,a.id]);
  const event={accountId:a.id,ownerId,sha,policyId:a.policy_id,
   policyHash:b.expectedPolicyHash,authorityId:b.authorityId,
   monetarySourceDigest:grant!.official_source_digest,modelDigest:grant!.model_digest,
   signedAt:new Date(start).toISOString(),priorHold:"awaiting_account_commissioning",
   killOn:true,tradingAuthorized:false};
  const digest=createHash("sha256").update(JSON.stringify(event)).digest("hex");
  await tx.query([
   "INSERT INTO public.v13_production_observation (id,account_id,kind,payload,digest)",
   "VALUES($1,$2,'OWNER_V4_PROVISIONAL_HOLD_REPAIR',$3::jsonb,$4)"
  ].join(" "),[randomUUID(),a.id,JSON.stringify(event),digest]);
  await tx.query("COMMIT");committed=true;
  return {ok:true as const,reason:"owner_v4_hold_repaired_new_exit_and_sha_release_still_required",
   repaired:true as const,tradingAuthorized:false as const,
   ordersSubmitted:false as const,killSwitchChanged:false as const};
 }catch{return no("v4_repair_transaction_failed");}
 finally{if(tx){if(!committed)try{await tx.query("ROLLBACK");}catch{}tx.release();}}
}
