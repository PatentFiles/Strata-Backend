/**
 * Wallets-only V4 official Kalshi fee evidence -> owner AAL2 consent.
 *
 * These calls can create/revoke scoped fee AUTHORITY RECORDS, but NEVER approve
 * a live trading policy, ARM, START, submit a Kalshi order or change a kill.
 * The final signed POST remains fail-closed until a separately validated
 * transactional V4 execution gate is released.
 */
import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {observeDynamicKalshiFees,type DynamicFeeResult} from "./dynamicOfficialFeeSchedule";
import {approvedDynamicStakeSnapshot} from "./approvedDynamicStakeSnapshot";

export const WALLET_V4_EVIDENCE_CONFIRM="I_RECORD_MY_OFFICIAL_KALSHI_DYNAMIC_FEE_EVIDENCE_V4";
export const WALLET_V4_CONSENT_CONFIRM="I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4";
export const WALLET_V4_REVOKE_CONFIRM="I_REVOKE_MY_WALLET_DYNAMIC_FEE_AUTHORITY_V4";
const VERSION="strata_owner_provider_dynamic_fee_v4";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const TICKER=/^KXBTC15M-[a-zA-Z0-9-]+$/;
type Row=Record<string,unknown>;
type Q={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Client=Q&{release():void};
type Db=Q&{connect():Promise<Client>};
type Observe=(ticker:string)=>Promise<DynamicFeeResult>;
export type WalletV4ConsentDeps={db?:Db;sha?:()=>string;now?:()=>number;
 observe?:Observe;enabled?:()=>boolean};
const denied=(reason:string)=>({ok:false as const,reason,
 evidenceRecorded:false as const,grantIssued:false as const,
 tradingAuthorized:false as const,ordersSubmitted:false as const});
const field=(x:unknown)=>typeof x==="string"?x:"";
const body=(x:unknown):Row=>x&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
const flag=(d:WalletV4ConsentDeps)=> (d.enabled??(()=>process.env.STRATA_WALLET_V4_OWNER_CONSENT_ENABLED==="true"))();
const now=(d:WalletV4ConsentDeps)=> (d.now??Date.now)();
const sha=(d:WalletV4ConsentDeps)=> (d.sha??deployedGitSha)().toLowerCase();
const observe=(d:WalletV4ConsentDeps,ticker:string)=>(d.observe??(x=>observeDynamicKalshiFees(x)))(ticker);
const date=(v:unknown)=>v instanceof Date?v.getTime():Date.parse(String(v??""));
const runTx=async<T>(db:Db,action:(c:Client)=>Promise<T>):Promise<T>=>{
 const c=await db.connect();let committed=false;
 try{
  await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await c.query("SET LOCAL lock_timeout='1500ms'");
  await c.query("SET LOCAL statement_timeout='10000ms'");
  const outcome=await action(c);
  // Rejected operations must not commit any partial read/write side effects.
  if(outcome&&typeof outcome==="object"&&"ok" in outcome&&outcome.ok===false)return outcome;
  await c.query("COMMIT");committed=true;
  return outcome;
 }finally{if(!committed)try{await c.query("ROLLBACK");}catch{}c.release();}
};
/** Freeze account and lease state while binding evidence to a real owner.
 * No "accountId" supplied by the browser is trusted.
 */
async function safeAccount(c:Client,ownerId:string){
 const owned=await c.query(
  "SELECT id,commissioned,kill_switch,execution_enabled,cash_precision_verified FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE",
  [ownerId]);
 if(owned.rows.length!==1)return {ok:false as const,reason:"wallet_v4_owner_account_missing_or_ambiguous"};
 const a=owned.rows[0]!;
 // execution_enabled is durable eligibility, NOT permission to place an order.
 // Kill switch ON and non-owned, unarmed lease are the safety authority.
 if(a.commissioned!==true||a.kill_switch!==true||
    a.cash_precision_verified!==true)
   return {ok:false as const,reason:"wallet_v4_safe_commissioned_stop_required"};
 const lease=await c.query("SELECT state,arm_requested,account_kill FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE",[a.id,ownerId]);
 if(lease.rows.length>1)return {ok:false as const,reason:"wallet_v4_worker_lease_ambiguous"};
 const l=lease.rows[0];
 if(l&&(
  l.arm_requested!==false||
  !(l.state==="killed"&&l.account_kill===true||
    l.state==="released"&&l.account_kill===false)
 ))return {ok:false as const,reason:"wallet_v4_worker_not_safely_disarmed"};
 return {ok:true as const,accountId:String(a.id)};
}
const fresh=(r:DynamicFeeResult,ticker:string,started:number,current:number)=>
 r.ok&&r.model.marketTicker===ticker&&
 HASH.test(r.model.modelDigest)&&HASH.test(r.model.publicationDigest)&&
 HASH.test(r.model.metadataDigest)&&
 r.model.feeType==="quadratic"&&r.model.feeMultiplier==="1"&&
 date(r.model.observedAt)<=current&&current-date(r.model.observedAt)<=15_000&&
 current>=started&&current-started<=15_000;

export async function recordWalletV4FeeEvidence(ownerId:string,raw:unknown,deps:WalletV4ConsentDeps={}){
 const b=body(raw),ticker=field(b.marketTicker),expectedSha=field(b.expectedDeployedSha),
 expectedModel=field(b.expectedModelDigest);
 if(!UUID.test(ownerId)||!TICKER.test(ticker)||!SHA.test(expectedSha)||
    !HASH.test(expectedModel)||b.confirmation!==WALLET_V4_EVIDENCE_CONFIRM)
  return denied("wallet_v4_owner_evidence_confirmation_required");
 if(!flag(deps))return denied("wallet_v4_consent_feature_disabled");
 const currentSha=sha(deps);
 if(!SHA.test(currentSha)||currentSha!==expectedSha)return denied("wallet_v4_deployed_sha_changed");
 const start=now(deps);
 if(!Number.isSafeInteger(start))return denied("wallet_v4_clock_invalid");
 let proof:DynamicFeeResult;
 try{proof=await observe(deps,ticker);}catch{return denied("wallet_v4_official_provider_unavailable");}
 if(!fresh(proof,ticker,start,now(deps))||!proof.ok||proof.model.modelDigest!==expectedModel)
  return denied("wallet_v4_provider_model_changed_or_unverified");
 const db=deps.db??pool as unknown as Db;
 try{
  return await runTx(db,async c=>{
   const a=await safeAccount(c,ownerId);
   if(!a.ok)return denied(a.reason);
   if(now(deps)-start>15_000)return denied("wallet_v4_provider_observation_expired");
   const id=randomUUID(),m=proof.model;
   const observationAt=new Date(now(deps));
   const expiry=new Date(observationAt.getTime()+10*60_000);
   const row=await c.query(
    `INSERT INTO private.strata_wallet_v4_fee_evidence
    (evidence_id,owner_user_id,execution_account_id,deployed_sha,
     market_ticker,model_digest,official_source_digest,market_metadata_digest,
     effective_at,fee_type,taker_coefficient_ppm,observed_at,expires_at)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::timestamptz,
      'quadratic',$10,$11::timestamptz,$12::timestamptz)
    RETURNING evidence_id::text`,
    [id,ownerId,a.accountId,currentSha,ticker,m.modelDigest,m.publicationDigest,
     m.metadataDigest,m.effectiveDate,m.takerRatePpm,observationAt.toISOString(),expiry.toISOString()]);
   if(row.rows.length!==1)return denied("wallet_v4_evidence_insert_not_confirmed");
   return {ok:true as const,reason:"wallet_v4_official_evidence_recorded_without_trading",
     evidenceId:id,modelDigest:m.modelDigest,deployedSha:currentSha,
     expiresAt:expiry.toISOString(),evidenceRecorded:true as const,
     grantIssued:false as const,tradingAuthorized:false as const,ordersSubmitted:false as const};
  });
 }catch{return denied("wallet_v4_evidence_transaction_failed");}
}

export async function authorizeWalletV4FeeModel(ownerId:string,raw:unknown,deps:WalletV4ConsentDeps={}){
 const b=body(raw),evidenceId=field(b.evidenceId),
 expectedSha=field(b.expectedDeployedSha),expectedModel=field(b.expectedModelDigest);
 if(!UUID.test(ownerId)||!UUID.test(evidenceId)||!SHA.test(expectedSha)||
    !HASH.test(expectedModel)||b.confirmation!==WALLET_V4_CONSENT_CONFIRM)
  return denied("wallet_v4_explicit_owner_consent_required");
 if(!flag(deps))return denied("wallet_v4_consent_feature_disabled");
 const currentSha=sha(deps);
 if(currentSha!==expectedSha||!SHA.test(currentSha))
  return denied("wallet_v4_owner_sha_changed");
 const start=now(deps);
 if(!Number.isSafeInteger(start))return denied("wallet_v4_clock_invalid");
 const db=deps.db??pool as unknown as Db;
 let ticker:string,sourceDigest:string;
 try{
  const r=await db.query(
   "SELECT market_ticker,official_source_digest FROM private.strata_wallet_v4_fee_evidence WHERE evidence_id=$1::uuid AND owner_user_id=$2::uuid AND deployed_sha=$3 AND model_digest=$4 AND revoked_at IS NULL AND observed_at<=now() AND expires_at>now()+interval '60 seconds' LIMIT 2",
   [evidenceId,ownerId,currentSha,expectedModel]);
  if(r.rows.length!==1)return denied("wallet_v4_owner_evidence_missing_or_expired");
  ticker=field(r.rows[0]!.market_ticker);sourceDigest=field(r.rows[0]!.official_source_digest);
  if(!TICKER.test(ticker)||!HASH.test(sourceDigest))return denied("wallet_v4_evidence_identity_invalid");
 }catch{return denied("wallet_v4_evidence_read_failed");}
 let observed:DynamicFeeResult;
 try{observed=await observe(deps,ticker);}catch{return denied("wallet_v4_current_fee_provider_unavailable");}
 if(!fresh(observed,ticker,start,now(deps))||!observed.ok||
    observed.model.modelDigest!==expectedModel||
    observed.model.publicationDigest!==sourceDigest)
  return denied("wallet_v4_model_changed_before_owner_consent");
 try{
  return await runTx(db,async c=>{
   const a=await safeAccount(c,ownerId);
   if(!a.ok)return denied(a.reason);
   if(now(deps)-start>15_000)return denied("wallet_v4_consent_quote_expired");
   const e=await c.query(
    `SELECT evidence_id,market_ticker,model_digest,official_source_digest,expires_at
     FROM private.strata_wallet_v4_fee_evidence
     WHERE evidence_id=$1::uuid AND owner_user_id=$2::uuid
       AND execution_account_id=$3 AND deployed_sha=$4 AND model_digest=$5
       AND revoked_at IS NULL AND expires_at>now()+interval '60 seconds'
     FOR SHARE`,
     [evidenceId,ownerId,a.accountId,currentSha,expectedModel]);
   if(e.rows.length!==1||e.rows[0]!.market_ticker!==ticker||
      e.rows[0]!.official_source_digest!==sourceDigest)
    return denied("wallet_v4_model_evidence_changed_during_lock");
   const policies=await c.query(
    `SELECT p.policy_hash,p.fee_policy_version,p.state,p.capital_limit_cents,
       p.max_entry_stake_cents,p.max_entry_all_in_cents,p.max_daily_loss_cents,
       p.max_total_loss_cents,s.configured_stake_cents,s.risk_capital_cents,
       s.risk_preset_id,s.risk_preset_revision
     FROM public.v13_production_account a
     JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
     JOIN public.strata_configured_stake s ON s.execution_account_id=a.id
     WHERE a.id=$1 AND a.owner_user_id=$2::uuid
     FOR SHARE OF p,s`,[a.accountId,ownerId]);
   if(policies.rows.length!==1)return denied("wallet_v4_approved_policy_not_found");
   const p=policies.rows[0]!;
   // The backend-verified owner risk preset and saved versioned policy, not a
   // global fixed stake, determine the permitted fee-consent scope.
   // Actual final order submission remains separately fail-closed.
   if(!approvedDynamicStakeSnapshot(p).ok)
    return denied("wallet_v4_matching_approved_dynamic_stake_policy_required");
   const old=await c.query(
    "SELECT authority_id FROM private.strata_wallet_v4_fee_authority WHERE evidence_id=$1::uuid FOR UPDATE",
    [evidenceId]);
   if(old.rows.length>0)return denied("wallet_v4_evidence_already_authorized");
   const id=randomUUID();
   const expiresAt=new Date(Math.min(date(e.rows[0]!.expires_at),
     now(deps)+10*60_000));
   if(expiresAt.getTime()-now(deps)<60_000)return denied("wallet_v4_consent_expires_too_soon");
   const result=await c.query(
    `INSERT INTO private.strata_wallet_v4_fee_authority
    (authority_id,evidence_id,owner_user_id,execution_account_id,
      deployed_sha,model_digest,policy_hash,policy_version,confirmation,
      aal2_verified_at,authorized_stages,expires_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,
      now(),ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],
      $10::timestamptz)
    RETURNING authority_id::text`,
    [id,evidenceId,ownerId,a.accountId,currentSha,expectedModel,
      p.policy_hash,VERSION,WALLET_V4_CONSENT_CONFIRM,expiresAt.toISOString()]);
   if(result.rows.length!==1)return denied("wallet_v4_grant_not_confirmed");
   return {ok:true as const,reason:"wallet_v4_owner_fee_consent_recorded_no_live_order_permission",
    authorityId:id,expiresAt:expiresAt.toISOString(),
    evidenceRecorded:true as const,grantIssued:true as const,
    tradingAuthorized:false as const,ordersSubmitted:false as const};
  });
 }catch{return denied("wallet_v4_owner_consent_transaction_failed");}
}

export async function revokeWalletV4FeeConsent(ownerId:string,raw:unknown,deps:WalletV4ConsentDeps={}){
 const b=body(raw);
 if(!UUID.test(ownerId)||!UUID.test(field(b.authorityId))||
    b.confirmation!==WALLET_V4_REVOKE_CONFIRM)
  return denied("wallet_v4_explicit_revocation_required");
 // Always allow revocation even after feature flag is turned off.
 try{
  const db=deps.db??pool as unknown as Db;
  return await runTx(db,async c=>{
   const rows=await c.query(
    `SELECT g.authority_id FROM private.strata_wallet_v4_fee_authority g
     JOIN public.v13_production_account a
     ON a.id=g.execution_account_id AND a.owner_user_id=g.owner_user_id
     WHERE g.authority_id=$1::uuid AND g.owner_user_id=$2::uuid
       AND a.subaccount=1 AND a.exchange_index=2 AND g.revoked_at IS NULL
     FOR UPDATE OF g`,[b.authorityId,ownerId]);
   if(rows.rows.length!==1)return denied("wallet_v4_active_owned_authority_not_found");
   const updated=await c.query(
    `UPDATE private.strata_wallet_v4_fee_authority
       SET revoked_at=now(),revocation_reason='owner_approved_revocation'
       WHERE authority_id=$1::uuid AND owner_user_id=$2::uuid
         AND revoked_at IS NULL RETURNING authority_id`,[b.authorityId,ownerId]);
   if(updated.rows.length!==1)return denied("wallet_v4_revocation_not_recorded");
   return {ok:true as const,reason:"wallet_v4_fee_consent_revoked",
    evidenceRecorded:false as const,grantIssued:false as const,
    revoked:true as const,tradingAuthorized:false as const,ordersSubmitted:false as const};
  });
 }catch{return denied("wallet_v4_revocation_transaction_failed");}
}
