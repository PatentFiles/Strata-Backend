import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { deployedGitSha, DEPLOYED_SHA_RUNTIME_UNAVAILABLE } from "./deployedGitSha";
import { readOwnedKalshiFeeds, personalAccountSnapshot } from "./personalExchangeRead";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import { verifyProtectiveReleaseFeePreflight } from "./protectiveReleaseFeePreflight";
import { observeDynamicKalshiFees, computeDynamicFeeModelDigest, type DynamicFeeResult } from "./dynamicOfficialFeeSchedule";
import { DYNAMIC_FEE_POLICY_VERSION_V4 } from "./dynamicFeeOrderRiskV4";
import { CANONICAL_FEE_SCHEDULE_URL } from "../microLiveFeeArtifact";
import { officialFeeSnapshotLeaseValid } from "./verifiedOfficialFeeSnapshotLease";
import { parseReviewedApiSource, verifyReviewedApiFeeSourceStage,
  API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import { digest as v13Digest, type Identity, type Request } from "../v13-production/types";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
export const REVIEW_CONFIRM="I_INDEPENDENTLY_REVIEWED_THE_EXACT_PRODUCTION_PROTECTIVE_EXIT_RELEASE";
export const OWNER_CONFIRM="I_AUTHORIZE_MY_OWN_ACCOUNT_AND_SHARED_LIVE_EXECUTION_AFTER_INDEPENDENT_REVIEW";
export const PROVISIONAL_REPAIR_CONFIRM="I_AUTHORIZE_AN_AUDITED_REPAIR_OF_MY_STALE_COMMISSIONING_BLOCKER";
type DbRow=Record<string,unknown>;
type Query={query(sql:string,params?:unknown[]):Promise<{rows:DbRow[];rowCount?:number}>};
type Db=Query & {connect():Promise<Query&{release():void}>};
type Deps={db?:Db;sha?:()=>string;readFeeds?:typeof readOwnedKalshiFeeds;verifyFee?:typeof verifyProtectiveReleaseFeePreflight;verifyApiFee?:typeof verifyReviewedApiFeeSourceStage;observeV4Fee?:(ticker:string)=>Promise<DynamicFeeResult>;now?:()=>number};
const deny=(reason:string)=>({ok:false,reason,ordersSubmitted:false as const});
const valid=(s:unknown):s is string=>typeof s==="string"&&UUID.test(s);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const truth=(v:unknown)=>v===true||v==="t";
const time=(n:number)=>new Date(n).toISOString();
const accountSQL=`
 SELECT a.id,a.owner_user_id::text AS owner_id,a.commissioned,a.execution_enabled,
 a.kill_switch,a.cash_precision_verified,a.minimum_exit_micros,a.cash_micros::text AS cash_micros,
 a.blocked_reason,a.revision,a.reconciled_at,
 a.key_fingerprint,a.policy_id,a.commissioning_digest,a.fee_artifact_digest,
 a.kalshi_connection_id, p.state AS policy_state,p.fee_source_url,p.fee_policy_version,
 p.fee_formula_version,p.policy_hash,p.approved_at,p.max_entry_stake_cents,p.max_entry_all_in_cents,
 stake.configured_stake_cents
 FROM public.v13_production_account a
 LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id
  AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text
 LEFT JOIN public.strata_configured_stake stake ON stake.execution_account_id=a.id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`;
export async function readReleaseOwner(db:Query,ownerId:string):Promise<{ok:true;account:DbRow}|{ok:false;reason:string}>{
 if(!valid(ownerId))return {ok:false,reason:"owner_identity_invalid"};
 const a=await db.query(accountSQL,[ownerId]);
 if(a.rows.length!==1)return {ok:false,reason:"owned_account_missing_or_ambiguous"};
 const account=a.rows[0]!;
 if(!truth(account.commissioned)||account.policy_state!=="APPROVED"||
    !truth(account.cash_precision_verified)||Number(account.minimum_exit_micros)!==10000)
   return {ok:false,reason:"account_commissioning_policy_or_floor_unverified"};
 if(!/^[a-f0-9]{64}$/.test(String(account.fee_artifact_digest??"")))
   return {ok:false,reason:"account_fee_digest_unverified"};
 const request=await db.query(`
 SELECT o.digest FROM public.v13_production_observation o
 WHERE o.account_id=$1 AND o.kind='OWNER_ACTIVATION_REQUEST'
 ORDER BY o.observed_at DESC LIMIT 1`,[account.id]);
 const expected=v13Digest({
  accountId:String(account.id),policyId:String(account.policy_id??""),
  feeDigest:String(account.fee_artifact_digest??""),
  stakeCents:Number(account.configured_stake_cents),
  commissioningDigest:String(account.commissioning_digest??""),
  minimumExitMicros:Number(account.minimum_exit_micros),
 });
 if(request.rows.length!==1||request.rows[0]?.digest!==expected)
   return {ok:false,reason:"owner_activation_request_stale_or_missing"};
 return {ok:true,account};
}
export async function loadedMaterial(db:Query,account:DbRow):Promise<{keyId:string;privateKey:string}|null>{
 const r=await db.query(`
 SELECT s.decrypted_secret FROM private.kalshi_connection_credentials c
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 WHERE c.owner_user_id=$1::uuid AND c.financial_account_id=$2
 AND c.role='restricted_execution' AND c.revoked_at IS NULL
 AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 AND c.key_fingerprint=$3 LIMIT 2`,
 [account.owner_id,account.kalshi_connection_id,account.key_fingerprint]);
 if(r.rows.length!==1)return null;
 try{
  const parsed=JSON.parse(String(r.rows[0]?.decrypted_secret??"")) as DbRow;
  return typeof parsed.api_key_id==="string"&&typeof parsed.private_key==="string"
    ?{keyId:parsed.api_key_id,privateKey:parsed.private_key}:null;
 }catch{return null;}
}
export async function pendingReleaseOwners(deps:Deps={}){
 const db=deps.db??pool;
 const r=await db.query(`
 SELECT a.owner_user_id::text AS owner_user_id
 FROM public.v13_production_account a
 WHERE a.owner_user_id IS NOT NULL AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
 AND EXISTS(SELECT 1 FROM public.v13_production_observation o
            WHERE o.account_id=a.id AND o.kind='OWNER_ACTIVATION_REQUEST')
 ORDER BY a.owner_user_id LIMIT 25`);
 return r.rows.map(x=>String(x.owner_user_id)).filter(x=>UUID.test(x));
}
export async function protectiveReleaseStatus(actorId:string,ownerId:string,deps:Deps={}){
 try{
  const db=deps.db??pool,sha=(deps.sha??deployedGitSha)();
  if(!valid(actorId)||!valid(ownerId))return deny("identity_invalid");
  if(!SHA.test(sha))return deny("deployed_commit_unverified");
  const owner=await readReleaseOwner(db,ownerId);
  const qualification=await db.query(`
 SELECT qualification_id::text,evidence_digest,expires_at FROM private.strata_protective_release_qualification
 WHERE owner_user_id=$1::uuid AND release_commit_sha=$2 AND expires_at>now()
 ORDER BY observed_at DESC LIMIT 1`,[ownerId,sha]);
  const review=await db.query(`
 SELECT v.review_id::text,v.reviewer_user_id::text,v.review_url,v.evidence_digest,v.expires_at
 FROM private.strata_protective_release_reviews v
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=v.qualification_id
 WHERE v.owner_user_id=$1::uuid AND v.release_commit_sha=$2 AND v.expires_at>now()
 AND q.expires_at>now() ORDER BY v.approved_at DESC LIMIT 1`,[ownerId,sha]);
  const active=await db.query(`
 SELECT release_id::text,expires_at FROM private.strata_protective_exit_release
 WHERE release_commit_sha=$1 AND state='approved' AND revoked_at IS NULL
 AND expires_at>now()+interval '20 minutes'
 AND independent_reviewer_id<>$2::uuid
 AND operator_approver_id<>independent_reviewer_id
 LIMIT 2`,[sha,ownerId]);
  // New owner SHA releases are account-specific and durable until revoked.
  // Missing staged schema retains the legacy status without granting authority.
  let ownerMode=false,ownerApproved=false,ownerApprovalId:null|string=null;
  try{
    const own=await db.query(`SELECT approval_id::text FROM private.strata_owner_sha_approvals
      WHERE owner_user_id=$1::uuid AND release_commit_sha=$2 AND revoked_at IS NULL LIMIT 2`,[ownerId,sha]);
    ownerMode=true;ownerApproved=own.rows.length===1;
    ownerApprovalId=ownerApproved?String(own.rows[0]?.approval_id):null;
  }catch{ownerMode=false;}
  const global=await db.query("SELECT live_execution_enabled,manual_kill_switch FROM public.live_execution_config WHERE id='singleton'");
  const account=owner.ok?owner.account:null;
   const approvedSource=account?String(account.fee_source_url??""):"";
   // The V4 dynamic model and legacy pinned model share the canonical
   // issuer URL. Identity is the APPROVED policy version, not the URL.
   // Misreporting V4 as legacy sends the owner through an obsolete 2h
   // snapshot renewal even when strict V4 evidence is the actual gate.
   const feeSourceMode=account
    ? account.fee_policy_version===DYNAMIC_FEE_POLICY_VERSION_V4
       ? approvedSource===CANONICAL_FEE_SCHEDULE_URL
          ? "DYNAMIC_PROVIDER_V4" : "UNRECOGNIZED"
       : parseReviewedApiSource(approvedSource) ? "REVIEWED_API_V2"
       : approvedSource===CANONICAL_FEE_SCHEDULE_URL
          ? "LEGACY_PDF_V1" : "UNRECOGNIZED"
    : "UNAVAILABLE";
   const observedCash=account?.reconciled_at==null?NaN:
     Date.parse(String(account.reconciled_at));
   const observedNow=(deps.now??Date.now)();
   const cashReconciliationStale=!Number.isFinite(observedCash)||
     observedCash>observedNow+10_000||observedNow-observedCash>15*60_000;
  return {ok:true,reason:owner.ok?"status_verified":owner.reason,sha,ownerId,
   qualificationId:qualification.rows[0]?.qualification_id??null,
   qualificationExpiresAt:qualification.rows[0]?.expires_at??null,
   reviewerId:review.rows.length===1?review.rows[0]?.reviewer_user_id:null,
   reviewId:review.rows.length===1?review.rows[0]?.review_id:null,
   reviewed:review.rows.length===1,
   releaseMode:ownerMode?'OWNER_SHA_V1':'LEGACY_TWO_HOUR',
   codeApprovalActive:ownerApproved,codeApprovalId:ownerApprovalId,
   // Owner-only approval is not sufficient: the frontend releaseActive signal
    // must require BOTH owner exact-SHA consent and independent technical exit
    // release, matching START. Legacy mode retains its technical release gate.
    releaseActive:active.rows.length===1&&(!ownerMode||ownerApproved),
   releaseExpiresAt:active.rows[0]?.expires_at??null,
   accountReady:owner.ok,
    // Read-only evidence: approved policy does not prove live fee eligibility.
    feeSourceMode,
    legacyPdfSnapshotExpired:feeSourceMode==="LEGACY_PDF_V1"
      ?!officialFeeSnapshotLeaseValid(observedNow):false,
    cashReconciliationStale,
    cashReconciledAt:account?.reconciled_at??null,
    approvedStakeCents:account?Number(account.configured_stake_cents):null,
   // Discovery hint only; endpoint rechecks ownership, lease, policy and signed proof.
   transientDatabaseFreezeDetected:actorId===ownerId&&account?.blocked_reason==="timeout exceeded when trying to connect",
   provisionalFreezeDetected:owner.ok&&owner.account.blocked_reason==="awaiting_account_commissioning",
   accountExecutionEnabled:account?truth(account.execution_enabled):false,
   globalExecutionEnabled:truth(global.rows[0]?.live_execution_enabled),
   accountKillOn:account?!truth(account.execution_enabled)||truth(account.kill_switch):true,
   globalKillOn:!truth(global.rows[0]?.live_execution_enabled)||truth(global.rows[0]?.manual_kill_switch),
   ordersSubmitted:false as const};
 }catch{return deny("release_status_database_unavailable");}
}
/** Authenticated PRODUCTION API GETs only: full cursor history and V13 comparison.
 * This never creates an order and never sends vault secrets to a browser.
 */
export async function qualifyProtectiveRelease(ownerId:string,deps:Deps={}){
 const db=deps.db??pool,sha=(deps.sha??deployedGitSha)(),now=(deps.now??Date.now)();
 if(!valid(ownerId)||!SHA.test(sha))return deny("release_identity_or_deployment_invalid");
 try{
  const v=await readReleaseOwner(db,ownerId);
  if(!v.ok)return deny(v.reason);
  const account=v.account;
  if(account.blocked_reason!==null&&account.blocked_reason!==undefined&&
     account.blocked_reason!=="awaiting_account_commissioning")
    return deny("account_risk_freeze_requires_independent_remediation");
  const unresolved=await readUnresolvedIntentMode((sql,p)=>db.query(sql,p),String(account.id));
  if(!unresolved.ok||unresolved.mode!=="entries")
    return deny("unresolved_order_prevents_release");
  const material=await loadedMaterial(db,account);
  if(!material)return deny("restricted_production_signer_unavailable");
  const feeds=await(deps.readFeeds??readOwnedKalshiFeeds)(material,now);
  if(!feeds.ok)return deny(feeds.reason);
  // Exchange reads are signed, but the proof must also be recent on this
  // actual invocation: a slow or stale read is never a valid release receipt.
  if(!Number.isSafeInteger(feeds.observedAtMs)||
     feeds.observedAtMs!==now ||
     (deps.now??Date.now)()-now>45_000)
    return deny("authenticated_production_read_stale");
  // The exact account-specific order/fill ledger is authoritative.
  const found=await db.query("SELECT request FROM public.v13_production_intent WHERE account_id=$1",[account.id]);
  const requests=found.rows.flatMap(row=>{
   try{
    const r=typeof row.request==="string"?JSON.parse(row.request):row.request;
    return r&&typeof r==="object"?[r as Request]:[];
   }catch{return [];}
  });
  if(requests.length!==found.rows.length)return deny("financial_intent_unreadable");
  const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(account.key_fingerprint)};
  const mapped=personalAccountSnapshot(identity,feeds,requests);
  if(!("identity" in mapped))return deny(mapped.reason);
  if(account.blocked_reason==="awaiting_account_commissioning" &&
     (mapped.orders.length>0||mapped.fills.length>0||mapped.positions.length>0||
      mapped.settlements.length>0||requests.length>0))
    return deny("commissioning_repair_requires_empty_exchange_and_ledger_history");
  const sourceUrl=String(account.fee_source_url??"");
  const reviewedApi=parseReviewedApiSource(sourceUrl);
  let freshFeeDigest:string;
  let v4FeeBinding:null|{marketTicker:string;modelDigest:string;metadataDigest:string;
    authorityId:string}=null;
  if(account.fee_policy_version===DYNAMIC_FEE_POLICY_VERSION_V4){
    // A V4-approved policy must NEVER fall through the legacy pinned-PDF
    // qualifier merely because both policies identify the same issuer URL.
    // Require actual owner/MFA consent for this precise account, policy and
    // deployed SHA, then independently re-observe official bytes and exact
    // Kalshi market fees. A stored grant alone is not a current issuer quote.
    if(sourceUrl!==CANONICAL_FEE_SCHEDULE_URL||
       account.fee_formula_version!==DYNAMIC_FEE_POLICY_VERSION_V4||
       !/^[a-f0-9]{64}$/.test(String(account.policy_hash??"")))
      return deny("release_v4_policy_source_or_formula_invalid");
    const grant=await db.query(`
 SELECT g.authority_id::text,e.market_ticker,e.model_digest,e.official_source_digest
 FROM private.strata_wallet_v4_fee_authority g
 JOIN private.strata_wallet_v4_fee_evidence e
 ON e.evidence_id=g.evidence_id AND e.owner_user_id=g.owner_user_id
 AND e.execution_account_id=g.execution_account_id
 AND e.deployed_sha=g.deployed_sha AND e.model_digest=g.model_digest
 WHERE g.owner_user_id=$1::uuid AND g.execution_account_id=$2
 AND g.deployed_sha=$3 AND g.policy_hash=$4
 AND g.policy_version='strata_owner_provider_dynamic_fee_v4'
 AND g.revoked_at IS NULL AND g.approved_at<=now()
 AND g.expires_at>now()+interval '60 seconds'
 AND e.revoked_at IS NULL AND e.observed_at<=now()
 AND e.expires_at>now()+interval '60 seconds'
 AND 'ORDER_ENTRY'=ANY(g.authorized_stages)
 ORDER BY g.approved_at DESC LIMIT 2`,
      [ownerId,account.id,sha,account.policy_hash]);
    if(grant.rows.length!==1)return deny("release_v4_owner_fee_grant_missing_or_ambiguous");
    const g=grant.rows[0]!;
    const ticker=String(g.market_ticker??"");
    if(!/^KXBTC15M-[A-Za-z0-9-]+$/.test(ticker)||
       !/^[a-f0-9]{64}$/.test(String(g.model_digest??""))||
       !/^[a-f0-9]{64}$/.test(String(g.official_source_digest??""))||
       !valid(g.authority_id))
      return deny("release_v4_fee_grant_identity_invalid");
    const observed=await(deps.observeV4Fee??(ticker=>observeDynamicKalshiFees(ticker)))(ticker);
    if(!observed.ok)return deny("release_v4_official_fee_"+(
      /^[a-z][a-z0-9_]{2,95}$/.test(observed.reason)?observed.reason:"unavailable"));
    const m=observed.model,observedAtMs=Date.parse(m.observedAt),feeNow=(deps.now??Date.now)();
    if(m.marketTicker!==ticker||m.modelDigest!==g.model_digest||
       m.publicationDigest!==g.official_source_digest||
       m.issuer!==CANONICAL_FEE_SCHEDULE_URL||
       m.feeType!=="quadratic"||m.feeMultiplier!=="1"||
       m.tradingAuthorized!==false||m.requiresVersionedReview!==true||
       computeDynamicFeeModelDigest(m)!==m.modelDigest||
       !/^[a-f0-9]{64}$/.test(m.metadataDigest)||
       !Number.isSafeInteger(feeNow)||!Number.isFinite(observedAtMs)||
       observedAtMs>feeNow||feeNow-observedAtMs>10_000)
      return deny("release_v4_official_fee_model_changed_or_stale");
    freshFeeDigest=m.publicationDigest;
    v4FeeBinding={marketTicker:ticker,modelDigest:m.modelDigest,
      metadataDigest:m.metadataDigest,authorityId:String(g.authority_id)};
  }else if(reviewedApi){
    // This reviewed API-source grant is an independently signed model, NOT
    // evidence that Kalshi's PDF was fetched. Verify the exact owner/source
    // and fresh official market metadata before recording any qualification.
    if(account.fee_policy_version!==API_SOURCE_POLICY_VERSION||
       account.fee_formula_version!==API_SOURCE_FORMULA_VERSION)
      return deny("release_api_fee_policy_mismatch");
    const verified=await(deps.verifyApiFee??verifyReviewedApiFeeSourceStage)(
      ownerId,"STEP_11",sourceUrl);
    if(!verified.ok){
      const reason=/^[a-z][a-z0-9_]{2,95}$/.test(verified.reason)
        ?verified.reason:"fee_source_unavailable";
      return deny("release_api_fee_"+reason);
    }
    const nowFee=(deps.now??Date.now)();
    if(verified.identity.grantId!==reviewedApi.grantId||
       verified.identity.sourceUrl!==sourceUrl||
       verified.identity.feePolicyVersion!==API_SOURCE_POLICY_VERSION||
       verified.identity.formulaVersion!==API_SOURCE_FORMULA_VERSION||
       !/^[a-f0-9]{64}$/.test(verified.identity.digest)||
       !Number.isSafeInteger(verified.identity.verifiedAtMs)||
       verified.identity.verifiedAtMs>nowFee||
       nowFee-verified.identity.verifiedAtMs>10_000)
      return deny("release_api_fee_identity_or_freshness_unverified");
    freshFeeDigest=verified.identity.digest;
  }else{
    // Legacy approved provider-PDF policy remains independently verified.
    const fee=await(deps.verifyFee??verifyProtectiveReleaseFeePreflight)();
    if(!fee.ok){
      const reason=/^[a-z][a-z0-9_]{2,95}$/.test(fee.reason)
        ?fee.reason:"fee_preflight_unavailable";
      return deny("release_fee_"+reason);
    }
    if(sourceUrl!=="https://kalshi.com/docs/kalshi-fee-schedule.pdf")
      return deny("approved_fee_source_url_mismatch");
    if(!/^[a-f0-9]{64}$/.test(String(fee.sourceDigest??"")))
      return deny("current_official_fee_digest_missing");
    if(fee.sourceDigest!==account.fee_artifact_digest)
      return deny("approved_fee_artifact_digest_changed");
    freshFeeDigest=fee.sourceDigest;
  }
  // Qualification binds current fee proof to the same bounded provider read.
  // An expired network journey must not produce a fresh owner release token.
  const completedAt=(deps.now??Date.now)();
  if(!Number.isSafeInteger(completedAt)||completedAt<now||
     completedAt-now>45_000)
    return deny("authenticated_production_qualification_stale");
  if(String(feeds.cashMicros)!==String(account.cash_micros))
    return deny("exchange_and_financial_ledger_cash_mismatch");
  const evidence=hash({sha,ownerId,accountId:account.id,observedAtMs:now,
   cash:feeds.cashMicros,orders:feeds.orders,fills:feeds.fills,
   positions:feeds.positions,settlements:feeds.settlements,
   fee:account.fee_artifact_digest,freshFeeDigest,v4FeeBinding,reviewedApiGrantId:reviewedApi?.grantId??null,policy:account.policy_id});
  const recorded=await db.query(`
 INSERT INTO private.strata_protective_release_qualification
 (release_commit_sha,owner_user_id,execution_account_id,evidence_digest)
 VALUES($1,$2::uuid,$3,$4)
 RETURNING qualification_id::text AS id,expires_at`,
 [sha,ownerId,account.id,evidence]);
  if(recorded.rows.length!==1)return deny("production_read_qualification_not_recorded");
  return {ok:true,reason:"authenticated_production_read_only_qualified",
   qualificationId:recorded.rows[0]?.id,expiresAt:recorded.rows[0]?.expires_at,
   sha,ordersSubmitted:false as const};
 }catch{return deny("authenticated_production_qualification_unavailable");}
}
/** New independent release reviews are retired. Historical rows are not
 * relabeled, deleted, or automatically revoked. */
export async function attestProtectiveReleaseReview(
 _actorId:string,_role:string,_raw:unknown,_deps:Deps={}
){return deny("independent_review_enrollment_retired_use_owner_self");}
/** Retired finite-release activation. No account/global flags, worker lease,
 * freeze, ledger, or historical approval may be changed through this service.
 * New approvals use the separate scoped owner-self workflow. */
export async function authorizeProtectiveRelease(
 _ownerId:string,_raw:unknown,_deps:Deps={}
){return {...deny("independent_review_release_activation_retired_use_owner_self"),workerStarted:false as const};}
