import { standingAuthoritySql, OWNER_SELF_REVIEW_CONFIRM } from './ownerSelfReviewMode.js';
import { createHash } from "node:crypto";
import { deployedGitSha } from "./deployedGitSha";
import { pool } from "@workspace/db";
import { API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import { PDF_FREE_API_RATE_REVIEW_DECISION_SHA256, PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
  validateConservativeFeeVectors } from "./apiFeeRateReference";
import { readExactEmergencyFeeEvidence } from "./ownerFeeEmergencyExitMarket";

/**
 * A protected EXIT must remain possible after an *owner's short-lived API
 * source grant expires*, without pretending the 429-blocked PDF was fetched.
 * The approved owner's persisted policy binds the original independently
 * signed model. Any revoked model review or changed live provider fee
 * metadata fails closed. This is a source proof, not a trading approval:
 * the one-use signed dispatcher separately requires the account, lease,
 * kill-switch and independently reviewed exact deployed code release.
 */
type DB={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type FeeReader=typeof readExactEmergencyFeeEvidence;
export type ProtectiveExitFeeProof={
 ok:boolean;reason:string;monetaryFeeAuthorized:boolean;
 marketTicker?:string;sourceDigest?:string;verifiedAt?:string;authorityFingerprint?:string;
 policyApproved:false;tradingAuthorized:false;
};
// Private monotonic evidence belongs to the exact successful proof object.
// Never serialize it, derive it from a caller timestamp, or refresh it at send.
const providerFreshness=new WeakMap<object,Readonly<{completedMonotonic:number;remainingMs:number}>>();
export function isReviewedProtectiveExitFeeFresh(proof:unknown):boolean{
 if(!proof||typeof proof!=="object")return false;
 const receipt=providerFreshness.get(proof);
 if(!receipt)return false;
 let current:number;
 try{current=performance.now();}catch{return false;}
 const elapsed=current-receipt.completedMonotonic;
 return Number.isFinite(current)&&current>=0&&Number.isFinite(elapsed)&&elapsed>=0&&
  elapsed<=receipt.remainingMs;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const fail=(reason:string):ProtectiveExitFeeProof=>({
 ok:false,reason,monetaryFeeAuthorized:false,policyApproved:false,tradingAuthorized:false,
});
export const REVIEW_SQL=`
 SELECT g.grant_id::text AS grant_id, r.review_id::text, c.consent_id::text, p.policy_hash, (extract(epoch FROM (r.expires_at-clock_timestamp()))*1000)::float8 AS valid_for_ms, (r.expires_at>clock_timestamp()) AS legacy_valid
 FROM public.v13_production_account a
 JOIN public.v13_live_money_policy p
   ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN private.strata_api_fee_source_grants g
   ON p.fee_source_url=('strata-api-reviewed://kxbtc15m/'||g.grant_id::text)
   AND g.owner_user_id=a.owner_user_id
 JOIN private.strata_api_fee_rate_reviews r
   ON r.owner_user_id=g.owner_user_id
   AND r.reviewer_user_id=g.issuer_admin_id
   AND r.rate_decision_digest=g.rate_decision_digest
   AND r.fee_model_version=g.fee_model_version
   AND r.scope=g.scope
 JOIN private.strata_api_fee_owner_consents c
   ON c.owner_user_id=g.owner_user_id AND c.grant_id=g.grant_id
 WHERE a.id=$1::text AND a.owner_user_id=$2::uuid
   AND a.subaccount=1 AND a.exchange_index=2
   AND a.commissioned=true AND a.execution_enabled=true
   AND a.kill_switch=false
   AND p.state='APPROVED' AND p.approved_at IS NOT NULL
   AND p.fee_policy_version=$3::text
   AND p.fee_formula_version=$4::text
   AND p.fee_source_url LIKE 'strata-api-reviewed://kxbtc15m/%'
   AND g.policy_version=$3::text
   AND g.scope='KXBTC15M:INDEX2'
   AND g.rate_decision_digest=$5::text
   AND g.fee_model_version=$6::text
   AND g.issuer_admin_id<>a.owner_user_id
   AND g.confirmation='ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1'
   AND r.confirmation='I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1'
   AND r.reviewer_user_id<>a.owner_user_id
   -- A naturally expired short-lived grant may retain reviewed model evidence
   -- for a narrowly scoped exit; an EXPLICITLY REVOKED grant or owner consent
   -- must never be silently treated as still authorized.
   AND g.revoked_at IS NULL AND c.revoked_at IS NULL
   AND r.revoked_at IS NULL
   AND r.signed_at<=g.issued_at
   AND c.confirmation='CONFIRM_REVIEWED_API_FEE_SOURCE_V1'
   AND c.confirmed_at>=g.issued_at
   AND c.confirmed_at<=p.approved_at
   AND g.issued_at<=p.approved_at
 ORDER BY r.signed_at DESC,r.review_id DESC LIMIT 65 FOR SHARE OF a,p,g,r,c`;

/** History is a mode latch, including revoked/expired rows. Never use a legacy
 * review to evade a failed current-SHA standing authorization. */
const HISTORY_SQL=`SELECT (
 EXISTS(SELECT 1 FROM private.strata_api_fee_standing_delegations
 WHERE owner_user_id=$2::uuid AND grant_id=$4::uuid AND release_commit_sha=$3)
 OR EXISTS(SELECT 1 FROM private.strata_standing_execution_reviews
 WHERE owner_user_id=$2::uuid AND execution_account_id=$1 AND release_commit_sha=$3)
 ) AS standing_history`;
export const SUCCESSOR_SQL=`SELECT d.delegation_id::text,m.model_id::text,e.release_id::text,
 (extract(epoch FROM (LEAST(d.valid_until,m.valid_until)-clock_timestamp()))*1000)::float8 AS valid_for_ms
 FROM public.v13_production_account a
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN private.strata_api_fee_standing_delegations d ON d.owner_user_id=a.owner_user_id
   AND d.grant_id=$8::uuid AND d.policy_hash=p.policy_hash AND d.release_commit_sha=$7
 JOIN private.strata_api_fee_standing_models m ON m.model_id=d.model_id
 JOIN private.strata_api_fee_source_grants g ON g.grant_id=d.grant_id AND g.owner_user_id=d.owner_user_id
 JOIN auth.users issuer ON issuer.id=g.issuer_admin_id AND issuer.email_confirmed_at IS NOT NULL
 JOIN private.role_assignments issuer_role ON lower(btrim(issuer_role.email))=lower(btrim(issuer.email)) AND issuer_role.role='ADMIN'
 JOIN private.strata_standing_execution_reviews e ON e.owner_user_id=a.owner_user_id
   AND e.execution_account_id=a.id AND e.policy_hash=p.policy_hash AND e.release_commit_sha=$7
 JOIN auth.users u ON u.id=m.reviewer_admin_id AND u.email_confirmed_at IS NOT NULL
 JOIN private.role_assignments role ON lower(btrim(role.email))=lower(btrim(u.email)) AND role.role='ADMIN'

 WHERE a.id=$1 AND a.owner_user_id=$2::uuid
   AND p.state='APPROVED' AND p.fee_policy_version=$3 AND p.fee_formula_version=$4
   AND p.fee_source_url='strata-api-reviewed://kxbtc15m/'||$8::text
   AND d.confirmation='I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1'
   AND d.revoked_at IS NULL AND d.granted_at<=clock_timestamp()
   AND d.valid_until>clock_timestamp() AND d.valid_until<=m.valid_until
   AND d.valid_until>d.granted_at AND d.valid_until<=d.granted_at+interval '30 days'
   AND m.valid_until>m.signed_at AND m.valid_until<=m.signed_at+interval '30 days'
   AND m.release_commit_sha=$7 AND m.rate_decision_digest=$5 AND m.fee_model_version=$6
   AND m.scope='KXBTC15M:INDEX2' AND m.reviewer_admin_id<>a.owner_user_id
   AND m.revoked_at IS NULL AND m.signed_at<=d.granted_at AND m.valid_until>clock_timestamp()
   AND ${standingAuthoritySql('e','a.owner_user_id')}
   AND ((COALESCE(to_jsonb(e)->>'review_authority','INDEPENDENT_V1')='INDEPENDENT_V1'
     AND e.confirmation='I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1'
     AND EXISTS(SELECT 1 FROM public.profiles reviewer WHERE reviewer.id=e.independent_reviewer_id AND reviewer.role IN ('ADMIN','DEVELOPER') FOR SHARE))
    OR (to_jsonb(e)->>'review_authority'='OWNER_SELF_V1' AND e.confirmation='${OWNER_SELF_REVIEW_CONFIRM}'))
   AND e.state='approved'
   AND e.revoked_at IS NULL AND e.created_at<=clock_timestamp()
   AND (SELECT count(*) FROM private.strata_api_fee_standing_models competing
     WHERE competing.release_commit_sha=$7 AND competing.rate_decision_digest=$5
       AND competing.revoked_at IS NULL AND competing.valid_until>clock_timestamp())=1
 LIMIT 2 FOR SHARE OF a,p,d,m,e,u,role,g,issuer,issuer_role`;
export type ProtectiveFeeAuthority={ok:boolean;reason:string;proofKind?:"legacy"|"standing_successor";authorityFingerprint?:string;validForMs?:number};
/** Read-only monetary authority. Inside a caller-owned transaction the SHARE
 * locks are retained until COMMIT, including model/delegation revocation rows.
 * Invoke after provider GETs, never hold this transaction across network I/O.
 * Monetary owner delegation does not authorize trading: the independent exact
 * account/policy/SHA reduce-only review and final signed release remain separate.
 * No continuous entry grant or technical observation lease is read or renewed.
 */
export async function verifyReviewedProtectiveExitFeeAuthority(
 ownerId:string,accountId:string,exactSha:string,db:DB=pool,
):Promise<ProtectiveFeeAuthority>{
 if(!UUID.test(ownerId)||!/^[a-zA-Z0-9._:-]{1,128}$/.test(accountId)||!/^[a-f0-9]{40}$/.test(exactSha))
   return {ok:false,reason:"protective_fee_authority_identity_invalid"};
 const args:unknown[]=[accountId,ownerId,API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION,
   PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION];
 try{
  const base=await db.query(REVIEW_SQL,args);
  if(!base.rows.length||base.rows.length>=65||
    new Set(base.rows.map(r=>r.review_id)).size!==base.rows.length||base.rows.some(r=>!UUID.test(String(r.grant_id??"")))||
    new Set(base.rows.map(r=>r.grant_id)).size!==1||new Set(base.rows.map(r=>r.consent_id)).size!==1)
   return {ok:false,reason:"protective_fee_independent_owner_review_missing"};
  const scoped=[...args,exactSha,base.rows[0]!.grant_id];
  const fingerprint=(kind:string,row:Record<string,unknown>,successor?:Record<string,unknown>)=>
   createHash("sha256").update(JSON.stringify({kind,ownerId,accountId,exactSha,
    grant:row.grant_id,consent:row.consent_id,review:row.review_id,policy:row.policy_hash,
    delegation:successor?.delegation_id,model:successor?.model_id,exitReview:successor?.release_id})).digest("hex");
  const history=await db.query(HISTORY_SQL,[accountId,ownerId,exactSha,base.rows[0]!.grant_id]);
  if(history.rows.length!==1||typeof history.rows[0]?.standing_history!=="boolean")
   return {ok:false,reason:"protective_fee_standing_history_unknown"};
  if(history.rows[0]!.standing_history===true){
   const successor=await db.query(SUCCESSOR_SQL,scoped);
   if(successor.rows.length!==1||!Number.isFinite(successor.rows[0]?.valid_for_ms)||Number(successor.rows[0]?.valid_for_ms)<=0)
    return {ok:false,reason:"protective_fee_standing_successor_missing"};
   return {ok:true,reason:"protective_fee_standing_successor_verified",proofKind:"standing_successor",
    authorityFingerprint:fingerprint("standing_successor",base.rows[0]!,successor.rows[0]),
    validForMs:Math.min(3_600_000,Number(successor.rows[0]!.valid_for_ms))};
  }
  const legacy=base.rows.filter(r=>r.legacy_valid===true);
  return legacy.length===1&&Number.isFinite(legacy[0]?.valid_for_ms)&&Number(legacy[0]?.valid_for_ms)>0
   ? {ok:true,reason:"protective_fee_legacy_review_verified",proofKind:"legacy",authorityFingerprint:fingerprint("legacy",legacy[0]!),validForMs:Math.min(3_600_000,Number(legacy[0]!.valid_for_ms))}
   : {ok:false,reason:"protective_fee_independent_owner_review_missing"};
 }catch{return {ok:false,reason:"protective_fee_historic_review_unavailable"};}
}
export async function verifyReviewedProtectiveExitFee(
 ownerId:string,accountId:string,exactTicker:string,
 deps:{db?:DB;readFee?:FeeReader;now?:()=>number;sha?:()=>string}={},
):Promise<ProtectiveExitFeeProof>{
 if(!UUID.test(ownerId) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(accountId) ||
    !MARKET.test(exactTicker) || !validateConservativeFeeVectors())
   return fail("protective_fee_identity_or_model_invalid");
 const now=(deps.now??Date.now)();
 if(!Number.isSafeInteger(now)||now<=0)return fail("protective_fee_clock_invalid");
 const authority=await verifyReviewedProtectiveExitFeeAuthority(ownerId,accountId,(deps.sha??deployedGitSha)(),deps.db??pool);
 if(!authority.ok)return fail(authority.reason);
 let live:Awaited<ReturnType<FeeReader>>;
 try{live=await(deps.readFee??readExactEmergencyFeeEvidence)(exactTicker,deps.now??Date.now);}
 catch{return fail("protective_fee_provider_metadata_unverified");}
 // Anchor before the wall-clock decision/validation work, not after it.
 const completedMonotonic=performance.now();
 const completedAt=(deps.now??Date.now)();
 if(!Number.isSafeInteger(completedAt)||completedAt<now||!Number.isFinite(completedMonotonic)||completedMonotonic<0)return fail("protective_fee_clock_invalid");
 if(!live.ok || live.marketOpen!==true || live.marketTicker!==exactTicker ||
    !/^[a-f0-9]{64}$/.test(live.fingerprint) ||
    !Number.isSafeInteger(live.observedAtMs) || live.observedAtMs>completedAt+3_000 ||
    completedAt-live.observedAtMs>3_000)
   return fail("protective_fee_provider_metadata_unverified");
 // The signed review binds the previously approved monetary coefficient.
 // The current exact-market GET proves the relevant series/event/override
 // configuration has not changed. The final transactional release fence is
 // still the *sole* order authorization, not this read-only verifier.
 const proof:ProtectiveExitFeeProof=Object.freeze({ok:true,reason:authority.proofKind==="standing_successor"?"protective_fee_approved_standing_model_and_current_api":"protective_fee_approved_historical_model_and_current_api",
   monetaryFeeAuthorized:true,marketTicker:exactTicker,authorityFingerprint:authority.authorityFingerprint,
   sourceDigest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,
   verifiedAt:new Date(live.observedAtMs).toISOString(),
   policyApproved:false as const,tradingAuthorized:false as const});
 providerFreshness.set(proof,Object.freeze({completedMonotonic,
  remainingMs:3_000-Math.max(0,completedAt-live.observedAtMs)}));
 return proof;
}
