/**
 * #165 phase 2: owner AAL2 evidence-consent receipt for an eventual V3 fee path.
 * The authenticated JWT supplies the owner. Server obtains the official monetary
 * source and exact deployed SHA. NEVER reinterpret this record as a reviewed V2
 * grant, approved V3 policy, independent exit release or live trading permission.
 */
import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {verifyMonetaryFeeContract, type MonetaryFeeEvidenceContract} from "./monetaryFeeContract";

export const OWNER_V3_FEE_CONFIRM=
  "I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
type Row=Record<string,unknown>;
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:Row[]}>;release:()=>void};
type Db={connect:()=>Promise<Client>};
type FeeCheck=()=>Promise<MonetaryFeeEvidenceContract>;
type Deps={db?:Db;check?:FeeCheck;sha?:()=>string;now?:()=>number};
type Receipt={
  ok:boolean;reason:string;receiptId?:string;expiresAt?:string;
  evidenceRecorded:boolean;grantIssued:false;policyMigrated:false;
  protectiveExitReleased:false;ordersSubmitted:false;tradingAuthorized:false;
};
const denied=(reason:string):Receipt=>({ok:false,reason,evidenceRecorded:false,
  grantIssued:false,policyMigrated:false,protectiveExitReleased:false,
  ordersSubmitted:false,tradingAuthorized:false});
const value=(x:unknown)=>typeof x==="string"?x:"";

/** AAL2 is enforced by the existing authenticated user router middleware. */
export async function recordOwnerV3FeeEvidence(
  ownerId:string,raw:unknown,deps:Deps={},
):Promise<Receipt>{
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 if(!UUID.test(ownerId)||b.confirmation!==OWNER_V3_FEE_CONFIRM)
   return denied("explicit_authenticated_owner_v3_fee_consent_required");
 const sha=(deps.sha??deployedGitSha)().toLowerCase();
 if(!SHA.test(sha))return denied("exact_deployed_backend_sha_unavailable");
 const start=(deps.now??Date.now)();
 if(!Number.isSafeInteger(start)||start<=0)return denied("owner_fee_v3_clock_invalid");
 let fee:MonetaryFeeEvidenceContract;
 try{fee=await (deps.check??(()=>verifyMonetaryFeeContract("STEP_9")))();}
 catch{return denied("official_fee_source_unavailable");}
 if(!fee.ok||fee.monetaryFeeAuthorized!==true||fee.stage!=="STEP_9"||
   !DIGEST.test(value(fee.sourceDigest))||!MARKET.test(value(fee.marketTicker)))
   return denied("official_fee_source_unverified");
 if((deps.now??Date.now)()-start>15_000)return denied("official_fee_source_stale");
 const db=deps.db??pool as unknown as Db;
 let tx:Client|null=null,committed=false;
 try{
   tx=await db.connect();
   await tx.query("BEGIN");
   await tx.query("SET LOCAL lock_timeout='1500ms'");
   await tx.query("SET LOCAL statement_timeout='8000ms'");
   // Lock the owner's account to serialize competing consent/migration attempts.
   const a=await tx.query(`
     SELECT a.id,a.execution_enabled,a.kill_switch,a.cash_precision_verified,
            l.state AS lease_state
     FROM public.v13_production_account a
     LEFT JOIN private.kalshi_account_worker_lease l
       ON l.execution_account_id=a.id AND l.owner_user_id=a.owner_user_id
     WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
     FOR UPDATE OF a
   `,[ownerId]);
   if(a.rows.length!==1)return denied("owner_account_missing_or_ambiguous");
   const row=a.rows[0]!;
   if(row.execution_enabled!==false||row.kill_switch!==true)
     return denied("stop_and_disarm_before_owner_fee_v3_consent");
   if(row.lease_state==="owned")return denied("signed_stale_worker_recovery_required");
   if(row.cash_precision_verified!==true)return denied("cash_precision_unverified");
   if((deps.now??Date.now)()-start>15_000)
     return denied("official_fee_source_stale");
   const prior=await tx.query(`
     SELECT attestation_id FROM private.strata_owner_fee_evidence_v3
     WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND
       release_commit_sha=$3 AND revoked_at IS NULL AND expires_at>now()
     LIMIT 2
   `,[ownerId,row.id,sha]);
   if(prior.rows.length!==0)return denied("active_owner_fee_v3_evidence_already_exists");
   const id=randomUUID();
   const inserted=await tx.query(`
     INSERT INTO private.strata_owner_fee_evidence_v3
      (attestation_id,owner_user_id,execution_account_id,release_commit_sha,
       source_digest,market_ticker,verification_stage,source_kind,
       owner_confirmation,expires_at)
     VALUES($1,$2::uuid,$3,$4,$5,$6,'STEP_9',
       'official_kalshi_server_verified_v3',$7,now()+interval '2 hours')
     RETURNING attestation_id::text,expires_at::text AS expires_at
   `,[id,ownerId,row.id,sha,fee.sourceDigest,fee.marketTicker,OWNER_V3_FEE_CONFIRM]);
   if(inserted.rows.length!==1)return denied("owner_fee_v3_evidence_not_recorded");
   await tx.query("COMMIT");
   committed=true;
   return {ok:true,reason:"owner_v3_official_fee_consent_recorded_only",
     evidenceRecorded:true,receiptId:value(inserted.rows[0]?.attestation_id),
     expiresAt:value(inserted.rows[0]?.expires_at),
     grantIssued:false,policyMigrated:false,protectiveExitReleased:false,
     ordersSubmitted:false,tradingAuthorized:false};
 }catch{return denied("owner_fee_v3_database_unavailable");}
 finally{if(tx){if(!committed)try{await tx.query("ROLLBACK");}catch{}
   tx.release();}}
}
