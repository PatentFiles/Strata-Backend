/**
 * Issue #165: explicit AAL2 single-owner V3 fee authority.
 *
 * This version does NOT reuse V2 reviewer/admin grant tables or relax V2
 * constraints. Only a real current server-verified official PDF monetary
 * model, exact-market API observation, owner self-consent, and an immutable
 * prior consent attestation can issue a bounded revocable authority record.
 *
 * NOT a trading authorization or protective-exit release. A separate
 * account migration and exact-SHA final-order/exit admission still apply.
 */
import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {verifyMonetaryFeeContract,type MonetaryFeeEvidenceContract} from "./monetaryFeeContract";
import type {ApiFeeStage} from "./apiFeeGrantEligibility";

export const V3_FEE_GRANT_CONFIRM="I_APPROVE_MY_OWN_VERIFIED_MONETARY_FEE_GRANT_V3";
export const V3_FEE_POLICY_VERSION="strata_owner_official_monetary_fee_v3" as const;
export const V3_FEE_FORMULA_VERSION="standard-quadratic-0.07-v1" as const;
export const V3_FEE_PUBLICATION_URL="https://kalshi.com/docs/kalshi-fee-schedule.pdf" as const;
export const V3_FEE_AUTHORITY_SCOPE="KXBTC15M:INDEX2:SUBACCOUNT1" as const;
export const V3_FEE_GRANT_MAX_AGE_MS=15*60_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const SRC=/^strata-owner-fee-v3:\/\/kxbtc15m\/([0-9a-f-]{36})$/;
type Row=Record<string,unknown>;
type Q={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Client=Q&{release():void};
type Db=Q&{connect():Promise<Client>};
type Check=(stage:ApiFeeStage,exactMarketTicker?:string)=>Promise<MonetaryFeeEvidenceContract>;
export type Deps={db?:Db;sha?:()=>string;clock?:()=>number;check?:Check;enabled?:()=>boolean};
const str=(x:unknown)=>typeof x==="string"?x:"";
const numTime=(x:unknown)=>x instanceof Date?x.getTime():Date.parse(String(x??""));
const current=(x:unknown,now:number,minRemaining=0)=>Number.isFinite(numTime(x))&&numTime(x)>now+minRemaining;
const gate=(deps:Deps)=> (deps.enabled??(()=>process.env.STRATA_OWNER_FEE_V3_GRANTS_ENABLED==="true"))();
const check=(deps:Deps,stage:ApiFeeStage,market?:string)=>(deps.check??verifyMonetaryFeeContract)(stage,market);
const denied=(reason:string)=>({ok:false as const,reason,
  grantIssued:false as const,policyMigrated:false as const,
  tradingAuthorized:false as const,ordersSubmitted:false as const});
export function encodeV3FeeSource(authorityId:string):string|null{
 return UUID.test(authorityId)?`strata-owner-fee-v3://kxbtc15m/${authorityId.toLowerCase()}`:null;
}
export function parseV3FeeSource(source:string):string|null{
 const m=SRC.exec(source);
 return m&&UUID.test(m[1]!)?m[1]!:null;
}

/** AAL2 identity is supplied ONLY by requireUser middleware in routes. */
export async function issueOwnerV3FeeAuthority(ownerId:string,raw:unknown,deps:Deps={}){
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Row:{};
 if(!UUID.test(ownerId)||b.confirmation!==V3_FEE_GRANT_CONFIRM||
    !UUID.test(str(b.evidenceAttestationId))||!SHA.test(str(b.expectedDeployedSha)))
   return denied("v3_owner_confirmation_and_evidence_identity_required");
 if(!gate(deps))return denied("v3_authority_feature_disabled");
 const sha=(deps.sha??deployedGitSha)().toLowerCase();
 if(!SHA.test(sha)||sha!==b.expectedDeployedSha)return denied("v3_current_sha_mismatch");
 const clock=deps.clock??Date.now,started=clock();
 if(!Number.isSafeInteger(started)||started<=0)return denied("v3_clock_unverified");
 let fee:MonetaryFeeEvidenceContract;
 try{fee=await check(deps,"STEP_9");}
 catch{return denied("v3_official_fee_provider_unavailable");}
 if(!fee.ok||fee.stage!=="STEP_9"||fee.monetaryFeeAuthorized!==true||
    !HASH.test(str(fee.sourceDigest))||!MARKET.test(str(fee.marketTicker))||
    !Number.isFinite(Date.parse(str(fee.verifiedAt))) ||
    Date.parse(str(fee.verifiedAt))>clock()+1000 ||
    clock()-Date.parse(str(fee.verifiedAt))>15_000 ||
    clock()-started>15_000)
   return denied("v3_genuine_current_monetary_fee_evidence_required");
 const db=deps.db??pool as unknown as Db;
 let tx:Client|null=null,committed=false;
 try{
  tx=await db.connect();
  await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='10000ms'");
  const owner=await tx.query(`SELECT a.id,a.commissioned,a.kill_switch,
    a.cash_precision_verified,l.state AS lease_state,l.arm_requested,
    l.account_kill
    FROM public.v13_production_account a
    LEFT JOIN private.kalshi_account_worker_lease l
     ON l.execution_account_id=a.id AND l.owner_user_id=a.owner_user_id
    WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
    FOR UPDATE OF a,l`,[ownerId]);
  if(owner.rows.length!==1)return denied("v3_owned_account_missing_or_ambiguous");
  const a=owner.rows[0]!;
  if(a.commissioned!==true||a.kill_switch!==true||
     a.cash_precision_verified!==true)return denied("v3_safe_commissioned_stop_required");
  if(a.lease_state==="owned"||a.arm_requested===true)
    return denied("v3_worker_lease_or_arm_not_stopped");
  if(a.lease_state!=null &&
     !(a.arm_requested===false &&
        (a.lease_state==="killed"&&a.account_kill===true ||
         a.lease_state==="released"&&a.account_kill===false)))
    return denied("v3_worker_state_unknown");
  // The evidence attestation remains immutable and independent from the new
  // grant. It must be for the same owner, scoped account, SHA and source bytes.
  const receipt=await tx.query(`SELECT attestation_id::text,expires_at,source_digest,
      market_ticker,release_commit_sha
    FROM private.strata_owner_fee_evidence_v3
    WHERE attestation_id=$1::uuid AND owner_user_id=$2::uuid
      AND execution_account_id=$3 AND revoked_at IS NULL
      AND expires_at>now()+interval '60 seconds'
      AND source_kind='official_kalshi_server_verified_v3'
      AND verification_stage='STEP_9'
      AND owner_confirmation='I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3'
    FOR SHARE`,[b.evidenceAttestationId,ownerId,a.id]);
  if(receipt.rows.length!==1)return denied("v3_active_evidence_consent_missing");
  const proof=receipt.rows[0]!;
  if(proof.release_commit_sha!==sha||
     proof.source_digest!==fee.sourceDigest||
     proof.market_ticker!==fee.marketTicker ||
     !current(proof.expires_at,clock(),60_000))
    return denied("v3_issuer_source_digest_or_sha_changed");
  if(clock()-started>15_000)return denied("v3_provider_proof_expired_before_grant");
  const existing=await tx.query(`SELECT authority_id FROM private.strata_owner_fee_authority_v3
    WHERE attestation_id=$1::uuid LIMIT 2 FOR UPDATE`,[b.evidenceAttestationId]);
  if(existing.rows.length!==0)return denied("v3_consent_already_used_for_authority");
  const id=randomUUID();
  const written=await tx.query(`INSERT INTO private.strata_owner_fee_authority_v3
    (authority_id,attestation_id,owner_user_id,execution_account_id,
     release_commit_sha,official_source_digest,official_source_url,
     policy_version,formula_version,scope,authorized_stages,
     confirmation,expires_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,
           ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],$11,
           LEAST(now()+interval '15 minutes',$12::timestamptz))
    RETURNING authority_id::text,expires_at::text`,
   [id,b.evidenceAttestationId,ownerId,a.id,sha,fee.sourceDigest,
    V3_FEE_PUBLICATION_URL,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,
    V3_FEE_AUTHORITY_SCOPE,V3_FEE_GRANT_CONFIRM,proof.expires_at]);
  if(written.rows.length!==1)return denied("v3_authority_write_failed");
  await tx.query("COMMIT");committed=true;
  return {ok:true as const,reason:"v3_owner_monetary_authority_recorded_without_live_release",
    authorityId:id,sourceUrl:encodeV3FeeSource(id),
    expiresAt:written.rows[0]?.expires_at,
    grantIssued:true as const,policyMigrated:false as const,
    tradingAuthorized:false as const,ordersSubmitted:false as const};
 }catch{return denied("v3_authority_transaction_failed");}
 finally{if(tx){if(!committed)try{await tx.query("ROLLBACK");}catch{}tx.release();}}
}
export type VerifiedOwnerV3FeeAuthority=
 | {ok:false;reason:string}
 | {ok:true;reason:"v3_current_owner_monetary_authority";
    identity:{authorityId:string;sourceUrl:string;sourceDigest:string;
      feePolicyVersion:typeof V3_FEE_POLICY_VERSION;
      formulaVersion:typeof V3_FEE_FORMULA_VERSION;
      marketTicker:string;releaseCommitSha:string}};
/**
 * No privileged authority comes from the browser; verify the immutable
 * owner record, current SHA, scoped account, source publication and stage.
 * Caller must also re-lock policy/account+grant at its financial boundary.
 */
export async function verifyOwnerV3FeeAuthority(
 ownerId:string,stage:ApiFeeStage,sourceUrl:string,marketTicker?:string,deps:Deps={}
):Promise<VerifiedOwnerV3FeeAuthority>{
 const reject=(reason:string):VerifiedOwnerV3FeeAuthority=>({ok:false,reason});
 const id=parseV3FeeSource(sourceUrl);
 const sha=(deps.sha??deployedGitSha)().toLowerCase();
 if(!gate(deps))return reject("v3_authority_feature_disabled");
 if(!UUID.test(ownerId)||!id||!SHA.test(sha)||
    !["STEP_9","STEP_11","ORDER_ENTRY"].includes(stage)||
    (stage==="ORDER_ENTRY"&&!MARKET.test(str(marketTicker))))
   return reject("v3_authority_identity_or_stage_invalid");
 const db=deps.db??pool as unknown as Db;
 let c:Client|null=null;
 try{
  c=await db.connect();
  const rows=await c.query(`SELECT g.authority_id::text,g.execution_account_id,
     g.official_source_digest,g.release_commit_sha,g.expires_at,
     e.source_digest AS consent_digest,e.release_commit_sha AS consent_sha,
     e.market_ticker AS consent_market
    FROM private.strata_owner_fee_authority_v3 g
    JOIN private.strata_owner_fee_evidence_v3 e
     ON e.attestation_id=g.attestation_id
     AND e.owner_user_id=g.owner_user_id
     AND e.execution_account_id=g.execution_account_id
    JOIN public.v13_production_account a ON a.id=g.execution_account_id
      AND a.owner_user_id=g.owner_user_id
      AND a.subaccount=1 AND a.exchange_index=2
    WHERE g.authority_id=$1::uuid AND g.owner_user_id=$2::uuid
      AND g.release_commit_sha=$3 AND g.revoked_at IS NULL
      AND g.expires_at>now()+interval '30 seconds'
      AND g.issued_at<=now()
      AND g.policy_version=$4 AND g.formula_version=$5
      AND g.official_source_url=$6 AND g.scope=$7
      AND g.authorized_stages @> ARRAY[$8]::text[]
      AND g.confirmation=$9
      AND e.revoked_at IS NULL AND e.expires_at>now()+interval '30 seconds'
      AND e.verification_stage='STEP_9'
      AND e.source_kind='official_kalshi_server_verified_v3'
      AND e.owner_confirmation='I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3'
    LIMIT 2`,
   [id,ownerId,sha,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,
    V3_FEE_PUBLICATION_URL,V3_FEE_AUTHORITY_SCOPE,stage,V3_FEE_GRANT_CONFIRM]);
  if(rows.rows.length!==1)return reject("v3_authority_missing_revoked_or_expired");
  const r=rows.rows[0]!;
  if(r.official_source_digest!==r.consent_digest||
     r.release_commit_sha!==r.consent_sha||
     !HASH.test(str(r.official_source_digest)))
    return reject("v3_authority_consistency_failure");
  const start=(deps.clock??Date.now)();
  let fee:MonetaryFeeEvidenceContract;
  try{fee=await check(deps,stage,marketTicker);}
  catch{return reject("v3_current_official_fee_proof_unavailable");}
  if(!fee.ok||!fee.monetaryFeeAuthorized||fee.stage!==stage||
     fee.sourceDigest!==r.official_source_digest ||
     !MARKET.test(str(fee.marketTicker))||
     (marketTicker!=null&&fee.marketTicker!==marketTicker)||
     (deps.clock??Date.now)()-start>15_000)
    return reject("v3_official_fee_model_changed_or_stale");
  return {ok:true,reason:"v3_current_owner_monetary_authority",
    identity:{authorityId:id,sourceUrl,sourceDigest:str(fee.sourceDigest),
      feePolicyVersion:V3_FEE_POLICY_VERSION,
      formulaVersion:V3_FEE_FORMULA_VERSION,
      marketTicker:str(fee.marketTicker),releaseCommitSha:sha}};
 }catch{return reject("v3_authority_database_unavailable");}
 finally{c?.release();}
}
