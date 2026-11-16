import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {dedicatedSignerFingerprint} from './commissioning';
import {readReconciledReleaseRenewalHistory,verifyReconciledReleaseRenewalSnapshot} from './reconciledReleaseRenewalHistory';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import type {Pool,PoolClient} from '@workspace/db';
import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { deployedGitSha, DEPLOYED_SHA_RUNTIME_UNAVAILABLE } from "./deployedGitSha";
import { readOwnedKalshiFeeds, personalAccountSnapshot } from "./personalExchangeRead";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import { verifyProtectiveReleaseFeePreflight } from "./protectiveReleaseFeePreflight";
import { observeDynamicKalshiFees, computeDynamicFeeModelDigest, type DynamicFeeResult } from "./dynamicOfficialFeeSchedule";
import { DYNAMIC_FEE_POLICY_VERSION_V4 } from "./dynamicFeeOrderRiskV4";
import {parseV3FeeSource,verifyOwnerV3FeeAuthority,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from './ownerFeeV3Authority';
import { CANONICAL_FEE_SCHEDULE_URL } from "../microLiveFeeArtifact";
import { officialFeeSnapshotLeaseValid } from "./verifiedOfficialFeeSnapshotLease";
import { parseReviewedApiSource, verifyReviewedApiFeeSourceStage,
  API_SOURCE_POLICY_VERSION, API_SOURCE_FORMULA_VERSION } from "./apiFeeSourceStage";
import { digest as v13Digest, type Identity, type Request } from "../v13-production/types";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const REVIEW_URL=/^https:\/\/github\.com\/PatentFiles\/Strata-Backend\/pull\/\d+$/;
export const REVIEW_CONFIRM="I_INDEPENDENTLY_REVIEWED_THE_EXACT_PRODUCTION_PROTECTIVE_EXIT_RELEASE";
export const OWNER_CONFIRM="I_AUTHORIZE_MY_OWN_ACCOUNT_AND_SHARED_LIVE_EXECUTION_AFTER_INDEPENDENT_REVIEW";
export const PROVISIONAL_REPAIR_CONFIRM="I_AUTHORIZE_AN_AUDITED_REPAIR_OF_MY_STALE_COMMISSIONING_BLOCKER";
type DbRow=Record<string,unknown>;
type Query={query(sql:string,params?:unknown[]):Promise<{rows:DbRow[];rowCount?:number|null}>};
type Db=Query & {connect():Promise<Query&{release(discard?:boolean):void}>};
type Deps={db?:Db;sha?:()=>string;readFeeds?:typeof readOwnedKalshiFeeds;verifyFee?:typeof verifyProtectiveReleaseFeePreflight;verifyApiFee?:typeof verifyReviewedApiFeeSourceStage;observeV4Fee?:(ticker:string)=>Promise<DynamicFeeResult>;verifyOwnerV3Fee?:typeof verifyOwnerV3FeeAuthority;now?:()=>number};
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
  const ownerV3Id=parseV3FeeSource(sourceUrl);
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
  }else if(ownerV3Id){
    // A versioned owner-authenticated fee source is an alternative to V2
    // human ADMIN issuance, never a fabricated V2 independent signature.
    // Check actual official monetary publication and current market metadata,
    // owner/account/SHA scope, revocation and the saved policy source.
    if(account.fee_policy_version!==V3_FEE_POLICY_VERSION||
       account.fee_formula_version!==V3_FEE_FORMULA_VERSION)
      return deny("release_owner_v3_policy_or_formula_mismatch");
    const fee=await(deps.verifyOwnerV3Fee??verifyOwnerV3FeeAuthority)(
      ownerId,"STEP_11",sourceUrl);
    if(!fee.ok)return deny("release_owner_v3_"+fee.reason);
    if(fee.identity.authorityId!==ownerV3Id||
       fee.identity.releaseCommitSha!==sha||
       fee.identity.sourceUrl!==sourceUrl||
       fee.identity.feePolicyVersion!==V3_FEE_POLICY_VERSION||
       fee.identity.formulaVersion!==V3_FEE_FORMULA_VERSION||
       fee.identity.sourceDigest!==String(account.fee_artifact_digest??""))
      return deny("release_owner_v3_source_sha_or_digest_mismatch");
    freshFeeDigest=fee.identity.sourceDigest;
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
export async function attestProtectiveReleaseReview(
 actorId:string,role:string,raw:unknown,deps:Deps={}
){
 const db=deps.db??pool,sha=(deps.sha??deployedGitSha)();
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as DbRow:{};
 const ownerId=b.ownerUserId, qid=b.qualificationId;
 const note=typeof b.note==="string"?b.note.trim():"";
 const url=b.reviewUrl;
 if(!valid(actorId)||!valid(ownerId)||actorId===ownerId||
    !["ADMIN","DEVELOPER"].includes(role)||!valid(qid)||!REVIEW_URL.test(String(url))||
    b.confirmation!==REVIEW_CONFIRM||note.length<120||note.length>2500||!SHA.test(sha))
   return deny("genuine_independent_review_and_confirmation_required");
 let client:Awaited<ReturnType<Db["connect"]>>|null=null,committed=false;
 try{
  client=await db.connect();
  await client.query("BEGIN");
  const v=await readReleaseOwner(client,ownerId);
  if(!v.ok)return deny(v.reason);
  const q=await client.query(`
 SELECT qualification_id::text,evidence_digest FROM private.strata_protective_release_qualification
 WHERE qualification_id=$1::uuid AND owner_user_id=$2::uuid AND release_commit_sha=$3
 AND expires_at>now()+interval '60 seconds' FOR SHARE`,
 [qid,ownerId,sha]);
  if(q.rows.length!==1)return deny("independent_production_read_only_evidence_expired");
  const already=await client.query(`
 SELECT 1 FROM private.strata_protective_release_reviews
 WHERE qualification_id=$1::uuid AND reviewer_user_id=$2::uuid LIMIT 1`,
 [qid,actorId]);
  if(already.rows.length)return deny("review_already_recorded");
  const digest=hash({sha,ownerId,reviewerId:actorId,
   qualificationId:qid,qualificationDigest:q.rows[0]?.evidence_digest,reviewUrl:url,note});
  const inserted=await client.query(`
 INSERT INTO private.strata_protective_release_reviews
 (qualification_id,release_commit_sha,reviewer_user_id,owner_user_id,review_url,review_note,evidence_digest)
 VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7)
 RETURNING review_id::text AS id,expires_at`,
 [qid,sha,actorId,ownerId,url,note,digest]);
  if(inserted.rows.length!==1)return deny("independent_review_not_recorded");
  await client.query("COMMIT");committed=true;
  return {ok:true,reason:"independent_release_review_recorded",
    reviewId:inserted.rows[0]?.id,expiresAt:inserted.rows[0]?.expires_at,
    ordersSubmitted:false as const};
 }catch{return deny("independent_release_review_database_unavailable")}
 finally{if(client){if(!committed)try{await client.query("ROLLBACK")}catch{};client.release()}}
}
/** One separate AAL2 owner action: insert genuine release and enable this
 * particular commissioned account + shared infrastructure atomically.
 * No worker is started. ARM and START remain deliberate dashboard actions.
 */
// Local candidate: collect outside the transaction, then bind every observed
// account/credential/history row under locks before an enabling transition.
// Live technical renewal retains its existing behavior and does not require flatness.
async function finalReleaseScope(db:Query,owner:string,account:string,lock=false):Promise<DbRow & {worker:DbRow[]}>{
 const q=await db.query(`SELECT a.xmin::text AS account_revision,p.xmin::text AS policy_revision,
 s.xmin::text AS stake_revision,c.xmin::text AS credential_revision,
 fa.xmin::text AS financial_revision,pc.xmin::text AS provider_revision,
 g.xmin::text AS global_revision,
 c.vault_secret_id::text,fa.id::text AS financial_id,pc.id::text AS provider_id,
 a.key_fingerprint,a.cash_micros::text,a.reserved_micros::text
 FROM public.v13_production_account a
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN public.strata_configured_stake s ON s.execution_account_id=a.id
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=fa.id
 AND c.provider_connection_id=pc.id AND c.key_fingerprint=a.key_fingerprint AND c.role='restricted_execution'
 AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'

 JOIN public.live_execution_config g ON g.id='singleton'
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2
 ${lock?'FOR UPDATE OF a FOR SHARE OF p,s,c,fa,pc,g':''}`,[account,owner]);
 if(q.rows.length!==1)throw Error('release_scope_unverified');
 const row=q.rows[0]!;
 if(String(row.reserved_micros)!=='0')throw Error('release_reserved_cash_unverified');
 // Account FOR UPDATE is already held by the finalizer. A validated immediate
 // FK makes concurrent lease INSERT acquire conflicting parent KEY SHARE.
 const leases=await db.query(`SELECT w.*,w.xmin::text AS row_revision FROM private.kalshi_account_worker_lease w
 WHERE execution_account_id=$1 ${lock?'FOR UPDATE':''}`,[account]);
 if(leases.rows.length>1)throw Error('release_worker_lease_not_unique');
 if(leases.rows.length){const w=leases.rows[0]!;
  if(w.owner_user_id!==owner||w.financial_account_id!==row.financial_id||w.provider_connection_id!==row.provider_id||w.credential_fingerprint!==row.key_fingerprint||w.vault_secret_id!==row.vault_secret_id)throw Error('release_worker_binding_unverified');
  if(w.arm_requested!==false||!((w.state==='killed'&&w.account_kill===true)||(w.state==='released'&&w.account_kill===false)))throw Error('release_stopped_disarmed_scope_required');
 }else if(lock){
  const fence=await db.query(`SELECT c.oid FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='private.kalshi_account_worker_lease'::pg_catalog.regclass
 AND c.confrelid='public.v13_production_account'::pg_catalog.regclass
 AND c.conname='kalshi_account_worker_lease_owner_fk'
 AND c.contype='f' AND c.convalidated AND NOT c.condeferrable
 AND (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) AND a.attnotnull)=2
 AND (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(num,n)
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=ARRAY['execution_account_id','owner_user_id']
 AND (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(num,n)
 JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num)=ARRAY['id','owner_user_id']
 AND (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgisinternal AND t.tgenabled IN ('O','A'))=4
 AND pg_catalog.current_setting('session_replication_role')='origin'`);
  if(fence.rows.length!==1)throw Error('release_absent_lease_fence_unverified');
 }
 return {...row,worker:leases.rows};
}
async function finalReleaseHistory(db:Query,account:string,owner:string,lock=false){
 const initial=await readNeverPostedReleaseHistory(db,account,lock,{expiredExitOwnerId:owner});
 if(initial.rows.length)return {mode:'retained' as const,...await readReconciledReleaseRenewalHistory(db,account,owner,lock)};
 const suffix=lock?' FOR SHARE':'';
 const events=await db.query('SELECT event_id FROM public.v13_production_event WHERE account_id=$1 LIMIT 1'+suffix,[account]);
 const positions=await db.query('SELECT id FROM public.v13_production_position WHERE account_id=$1 LIMIT 1'+suffix,[account]);
 const exits=await db.query('SELECT reservation_id FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 LIMIT 1'+suffix,[account]);
 if(events.rows.length||positions.rows.length||exits.rows.length)throw Error('release_empty_history_financial_records_present');
 return {mode:'empty' as const,...initial,reconciliationDigest:hash({emptyAccount:account,history:initial.historyDigest})};
}
function finalReleaseSnapshot(history:Awaited<ReturnType<typeof finalReleaseHistory>>,snapshot:Parameters<typeof verifyReconciledReleaseRenewalSnapshot>[1]){
 if(history.mode==='retained')verifyReconciledReleaseRenewalSnapshot(history,snapshot);
 else if(snapshot.orders.length||snapshot.fills.length||snapshot.positions.length||snapshot.settlements.length)throw Error('release_empty_history_signed_exposure');
}

async function collectFinalReleaseEvidence(owner:string,deps:Deps){
 const db=deps.db??pool,v=await readReleaseOwner(db,owner);
 if(!v.ok)throw Error('release_owner_scope_unverified');
 if(v.account.kill_switch!==true)return null;
 const account=String(v.account.id),scope=await finalReleaseScope(db,owner,account);
 const history=await finalReleaseHistory(db,account,owner);
 const material=await loadedMaterial(db,v.account);
 if(!material||dedicatedSignerFingerprint(material.keyId,material.privateKey)!==scope.key_fingerprint)throw Error('release_signer_unverified');
 const started=(deps.now??Date.now)(),feeds=await(deps.readFeeds??readOwnedKalshiFeeds)(material,started);
 if(!feeds.ok||feeds.historicalCoverageComplete!==true||feeds.observedAtMs!==started)throw Error('release_complete_signed_evidence_required');
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:String(scope.key_fingerprint)},feeds,history.requests);
 if(!('identity' in snapshot)||!snapshot.authenticated||!snapshot.complete||!snapshot.cashExact||snapshot.unexplainedCashActivity||String(feeds.cashMicros)!==scope.cash_micros)throw Error('release_signed_scope_cash_unverified');
 finalReleaseSnapshot(history,snapshot);
 if(history.mode==='empty'&&(feeds.orders.length||feeds.fills.length||feeds.positions.length||feeds.settlements.length))throw Error('release_empty_history_signed_activity');
 if((deps.now??Date.now)()-started>5000||(deps.now??Date.now)()<started)throw Error('release_signed_evidence_stale');
 return {account,scope,history,snapshot,started,activation:v.account};
}

/** Exact immutable review receipt lookup; absence remains UNKNOWN, never retry permission. */
export async function lookupProtectiveReleaseAuthorization(ownerId:string,reviewId:string,deps:Deps={}){
 if(!valid(ownerId)||!valid(reviewId))return {outcome:'UNKNOWN' as const};
 try{
 const rows=await(deps.db??pool).query(`SELECT l.release_id::text,q.execution_account_id,l.release_commit_sha,l.revoked_at,l.expires_at
 FROM private.strata_protective_release_reviews r
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=r.qualification_id
 AND q.owner_user_id=r.owner_user_id AND q.release_commit_sha=r.release_commit_sha
 JOIN private.strata_protective_exit_release l ON l.release_commit_sha=r.release_commit_sha
 AND l.operator_approver_id=r.owner_user_id AND l.independent_reviewer_id=r.reviewer_user_id
 AND l.release_evidence_digest=r.evidence_digest
 WHERE r.review_id=$1::uuid AND r.owner_user_id=$2::uuid LIMIT 2`,[reviewId,ownerId]);
 if(rows.rows.length!==1)return {outcome:'UNKNOWN' as const};
 const row=rows.rows[0]!;
 if(!valid(row.release_id)||typeof row.execution_account_id!=='string'||!SHA.test(String(row.release_commit_sha)))return {outcome:'UNKNOWN' as const};
 const sha=String(row.release_commit_sha);
 return {outcome:'RECORDED' as const,releaseId:String(row.release_id),accountId:String(row.execution_account_id),reviewId,sha,
   revoked:row.revoked_at!==null,expiresAt:row.expires_at,currentReadinessVerified:false as const,
    ordersSubmitted:false as const,workerStarted:false as const};
 }catch{return {outcome:'UNKNOWN' as const};}
}

export async function authorizeProtectiveRelease(
 ownerId:string,raw:unknown,deps:Deps={}
){
 const db=deps.db??pool,sha=(deps.sha??deployedGitSha)();
 const b=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as DbRow:{};
 if(!valid(ownerId)||!valid(b.reviewId)||b.confirmation!==OWNER_CONFIRM||!SHA.test(sha))
   return deny("explicit_authenticated_owner_release_confirmation_required");
 const repairing=b.provisionalRepairConfirmation===PROVISIONAL_REPAIR_CONFIRM;
 if(b.provisionalRepairConfirmation!==undefined&&!repairing)
   return deny("explicit_commissioning_repair_confirmation_invalid");
 let client:Awaited<ReturnType<Db["connect"]>>|null=null,committed=false,commitAttempted=false;
 try{
  const previous=await lookupProtectiveReleaseAuthorization(ownerId,String(b.reviewId),deps);
  if(previous.outcome==='RECORDED')return {...deny('release_review_already_used_lookup_only'),outcome:'LOOKUP_ONLY' as const};
  if(!repairing){
   const initial=await readReleaseOwner(db,ownerId);if(!initial.ok)return deny(initial.reason);
   const a=initial.account;
   if(a.blocked_reason==='awaiting_account_commissioning')return deny('explicit_commissioning_repair_confirmation_required');
   if(a.blocked_reason!==null&&a.blocked_reason!==undefined)return deny('account_risk_freeze_requires_independent_remediation');
   const g=await db.query("SELECT mode,live_execution_enabled,manual_kill_switch FROM public.live_execution_config WHERE id='singleton'");
   if(g.rows.length!==1||g.rows[0]?.mode!=='V13_PRODUCTION'||truth(g.rows[0]?.live_execution_enabled)===truth(g.rows[0]?.manual_kill_switch))return deny('global_execution_kill_state_inconsistent');
   if(!truth(a.kill_switch)&&!truth(g.rows[0]?.live_execution_enabled))return deny('account_global_release_state_mismatch');
   const review=await db.query(`-- release:preflight-review
 SELECT r.review_id FROM private.strata_protective_release_reviews r
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=r.qualification_id
 WHERE r.review_id=$1::uuid AND r.owner_user_id=$2::uuid AND r.release_commit_sha=$3
 AND r.reviewer_user_id<>$2::uuid AND r.expires_at>now()+interval '60 seconds'
 AND q.owner_user_id=$2::uuid AND q.execution_account_id=$4 AND q.release_commit_sha=$3
 AND q.expires_at>now()+interval '60 seconds'`,[b.reviewId,ownerId,sha,a.id]);
   if(review.rows.length!==1)return deny('independent_review_or_qualification_expired');
  }
  const evidence=repairing?null:await collectFinalReleaseEvidence(ownerId,deps);
  client=await db.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='1500ms'");
  await client.query("SET LOCAL statement_timeout='12000ms'");
  // Serialize against worker admission, account kill and concurrent grants.
  const v=await readReleaseOwner(client,ownerId);
  if(!v.ok)return deny(v.reason);
  const a=v.account,accountId=String(a.id);
  const locked=await client.query(`
 SELECT id,execution_enabled,kill_switch,cash_micros::text,
   blocked_reason,reserved_micros::text,reconciled_at,
   commissioned,cash_precision_verified FROM public.v13_production_account
 WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[accountId,ownerId]);
  const current=locked.rows[0];
  // execution_enabled is durable eligibility, not the current ARM state.
  // Both (false,true) and (true,true) are valid killed account states;
  // only (false,false) is a contradictory live-but-ineligible state.
  if(locked.rows.length!==1||!current||
     (!truth(current.execution_enabled)&&!truth(current.kill_switch)))
    return deny("account_inconsistent_execution_kill_state");
  const frozen=current.blocked_reason;
  if(frozen!==null&&frozen!==undefined&&frozen!=="awaiting_account_commissioning")
    return deny("account_risk_freeze_requires_independent_remediation");
  if(frozen==="awaiting_account_commissioning"&&!repairing)
    return deny("explicit_commissioning_repair_confirmation_required");
  if(frozen!=="awaiting_account_commissioning"&&repairing)
    return deny("commissioning_repair_not_applicable");
  const accountNeedsEnable=truth(current.kill_switch);
  const global=await client.query(`
 SELECT mode,live_execution_enabled,manual_kill_switch FROM public.live_execution_config
 WHERE id='singleton' FOR UPDATE`);
  if(global.rows.length!==1||global.rows[0]?.mode!=="V13_PRODUCTION"||
     truth(global.rows[0]?.live_execution_enabled)===truth(global.rows[0]?.manual_kill_switch))
   return deny("global_execution_kill_state_inconsistent");
  const globalNeedsEnable=!truth(global.rows[0]?.live_execution_enabled);
  // Global admission may already be enabled for another commissioned owner.
  // It must not force an unrelated account's kill switch off, nor prevent
  // independently qualified activation of THIS owner. Do not re-enable an
  // account that is already on while the shared gate is killed: that remains
  // a privileged global release, not an account authorization.
  if(!accountNeedsEnable&&globalNeedsEnable)
    return deny("account_global_release_state_mismatch");
  if(accountNeedsEnable&&!repairing){
    if(!evidence||evidence.account!==accountId)return deny('release_fresh_signed_evidence_required');
    const guard=await client.query(`SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.v13_production_observation'::pg_catalog.regclass
      AND tgname='final_release_signed_deadline' AND tgenabled='O' AND tgdeferrable AND tginitdeferred`);
    if(guard.rows.length!==1)return deny('release_signed_deadline_migration_required');
    const lockedScope=await finalReleaseScope(client,ownerId,accountId,true);
    // Baseline credential contract: mapping/revocation rows locked, re-decrypt and
    // compare captured signer; no assertion of physical Vault/root-key fencing.
    const material=await loadedMaterial(client,a);
    if(!material||dedicatedSignerFingerprint(material.keyId,material.privateKey)!==String(evidence.scope.key_fingerprint))
      return deny('release_restricted_signer_changed');
    const activation=await readReleaseOwner(client,ownerId);
    if(hash(lockedScope)!==hash(evidence.scope)||!activation.ok||hash(activation.account)!==hash(evidence.activation))return deny('release_scope_changed_during_signed_read');
    const history=await finalReleaseHistory(client,accountId,ownerId,true);
    if(history.reconciliationDigest!==evidence.history.reconciliationDigest)return deny('release_history_changed_during_signed_read');
    finalReleaseSnapshot(history,evidence.snapshot);
    const ledgerAccount=await client.query('SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid',[accountId,ownerId]);
    if(ledgerAccount.rows.length!==1)return deny('release_ledger_account_missing');
    const ledger=new ProductionLedger(db as Pool,accountId);
    await ledger.finalAccountProof(client as PoolClient,ledgerAccount.rows[0] as unknown as Account,evidence.snapshot,(deps.now??Date.now)());
    await ledger.assertConservation(client as PoolClient,ledgerAccount.rows[0] as unknown as Account);
  }
  const unresolved=await readUnresolvedIntentMode((sql,p)=>client!.query(sql,p),accountId);
  if(!unresolved.ok||unresolved.mode!=="entries")return deny("release_unresolved_order");
  if(!Number.isSafeInteger(Number(a.configured_stake_cents))||
     Number(a.configured_stake_cents)<=0||
     Number(a.configured_stake_cents)>Number(a.max_entry_stake_cents)||
     Number(a.configured_stake_cents)>Number(a.max_entry_all_in_cents)||
     Number(a.configured_stake_cents)*10000>Number(a.cash_micros))
    return deny("approved_stake_or_cash_not_ready");
  const review=await client.query(`
 SELECT r.review_id::text,r.reviewer_user_id::text,r.review_url,r.evidence_digest,q.qualification_id::text,
        q.evidence_digest AS qualification_digest
 FROM private.strata_protective_release_reviews r
 JOIN private.strata_protective_release_qualification q ON q.qualification_id=r.qualification_id
 WHERE r.review_id=$1::uuid AND r.owner_user_id=$2::uuid AND r.release_commit_sha=$3
   AND r.reviewer_user_id<>$2::uuid AND r.expires_at>now()+interval '60 seconds'
   AND q.owner_user_id=$2::uuid AND q.execution_account_id=$4 AND q.release_commit_sha=$3
   AND q.expires_at>now()+interval '60 seconds'
 FOR SHARE OF r,q`,[b.reviewId,ownerId,sha,accountId]);
  if(review.rows.length!==1)return deny("independent_review_or_qualification_expired");
  // Durable SHA consent retains its original qualification. A fresh review may
  // use a newer qualification; never relabel the historical owner receipt.
  if(accountNeedsEnable&&!repairing){
   const consent=await client.query(`SELECT oa.approval_id FROM private.strata_owner_sha_approvals oa
    JOIN private.strata_protective_release_qualification oq ON oq.qualification_id=oa.qualification_id
    AND oq.owner_user_id=oa.owner_user_id AND oq.execution_account_id=oa.execution_account_id
    AND oq.release_commit_sha=oa.release_commit_sha
    WHERE oa.owner_user_id=$1::uuid AND oa.execution_account_id=$2 AND oa.release_commit_sha=$3
    AND oa.revoked_at IS NULL AND oa.qualification_digest=oq.evidence_digest
    AND oa.confirmed_at>=oq.observed_at AND oa.confirmed_at<oq.expires_at
    FOR SHARE OF oa,oq`,[ownerId,accountId,sha]);
   if(consent.rows.length!==1)return deny('owner_exact_sha_consent_required');
  }
  const used=await client.query('SELECT release_id FROM private.strata_protective_exit_release WHERE release_commit_sha=$1 AND operator_approver_id=$2::uuid AND release_evidence_digest=$3 LIMIT 2',[sha,ownerId,review.rows[0]!.evidence_digest]);
  if(used.rows.length)return {...deny('release_review_already_used_lookup_only'),outcome:'LOOKUP_ONLY' as const};
  const reviewer=String(review.rows[0]?.reviewer_user_id);
  const role=await client.query(`
 SELECT 1 FROM auth.users u JOIN public.profiles p ON p.id=u.id
 WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL
 AND p.role IN ('ADMIN','DEVELOPER') LIMIT 1 FOR SHARE OF u,p`,[reviewer]);
  if(role.rows.length!==1)return deny("reviewer_authority_expired");
  let repairEvidence:{observedAtMs:number;exchangeDigest:string}|null=null;
  if(repairing){
    const rec=await client.query(`
 SELECT (SELECT count(*)::text FROM public.v13_production_intent WHERE account_id=$1) intents,
        (SELECT count(*)::text FROM public.v13_production_event WHERE account_id=$1) events,
        (SELECT count(*)::text FROM public.v13_production_position
           WHERE account_id=$1 AND quantity_hundredths>0) positions,
        (SELECT count(*)::text FROM private.strata_emergency_exit_reservations
           WHERE execution_account_id=$1) exit_reservations`,[accountId]);
    const counts=rec.rows[0];
    if(rec.rows.length!==1||!counts||
       ["intents","events","positions","exit_reservations"].some(k=>String(counts[k])!=="0")||
       !truth(current.commissioned)||!truth(current.cash_precision_verified)||
       String(current.reserved_micros)!=="0"||
       !current.reconciled_at||
       !Number.isFinite(Date.parse(String(current.reconciled_at))))
      return deny("commissioning_repair_fresh_zero_exposure_unverified");

    // The reconciliation previously required a worker-maintained DB timestamp
    // younger than 15s. That timestamp cannot stay fresh during a genuinely
    // independent human review, especially when the trading worker is STOPPED.
    // Instead obtain the *authoritative* signed, complete, account-scoped
    // Kalshi balance/order/fill/position/settlement history NOW, while the
    // financial row is locked and before making the owner-approved transition.
    const material=await loadedMaterial(client,a);
    if(!material)return deny("commissioning_repair_restricted_signer_unavailable");
    const observedAtMs=(deps.now??Date.now)();
    const feeds=await(deps.readFeeds??readOwnedKalshiFeeds)(material,observedAtMs);
    if(!feeds.ok)return deny("commissioning_repair_live_exchange_read_unavailable");
    if(!Number.isSafeInteger(feeds.observedAtMs)||
       feeds.observedAtMs!==observedAtMs||
       Date.now()-observedAtMs>15_000||
       observedAtMs-Date.now()>2000||
       String(feeds.cashMicros)!==String(current.cash_micros))
      return deny("commissioning_repair_live_cash_or_freshness_unverified");
    const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:String(a.key_fingerprint)};
    const snapshot=personalAccountSnapshot(identity,feeds,[]);
    if(!("identity" in snapshot)||
       snapshot.orders.length!==0||snapshot.fills.length!==0||
       snapshot.positions.length!==0||snapshot.settlements.length!==0||
       feeds.orders.length!==0||feeds.fills.length!==0||
       feeds.settlements.length!==0)
      return deny("commissioning_repair_live_exposure_unverified");
    repairEvidence={observedAtMs,exchangeDigest:hash({
      accountId,sha,observedAtMs,cashMicros:feeds.cashMicros,
      orders:feeds.orders,fills:feeds.fills,
      positions:feeds.positions,settlements:feeds.settlements,
    })};
  }
  const prior=await client.query(`
 SELECT release_id::text FROM private.strata_protective_exit_release
 WHERE release_commit_sha=$1 AND revoked_at IS NULL AND expires_at>now()
 FOR UPDATE`,[sha]);
  if(prior.rows.length>1)return deny("active_release_duplicate_or_unverified");
  if(prior.rows.length===1){
    // Renewal is atomic: revoke the old release only inside the transaction
    // that commits a fresh independent review and replacement release.
    const revoked=await client.query(`
      UPDATE private.strata_protective_exit_release SET revoked_at=now()
      WHERE release_id=$1::uuid AND revoked_at IS NULL RETURNING release_id`,
      [prior.rows[0]?.release_id]);
    if(revoked.rows.length!==1)return deny("prior_release_revocation_failed");
  }
  const inserted=await client.query(`
 INSERT INTO private.strata_protective_exit_release
 (release_commit_sha,independent_reviewer_id,operator_approver_id,
 review_url,release_evidence_digest,state,expires_at)
 VALUES($1,$2::uuid,$3::uuid,$4,$5,'approved',now()+interval '2 hours')
 RETURNING release_id::text AS id,expires_at`,
 [sha,reviewer,ownerId,review.rows[0]?.review_url,review.rows[0]?.evidence_digest]);
  if(inserted.rows.length!==1)return deny("release_not_recorded");
  if(repairing){
    const clear=await client.query(`
 UPDATE public.v13_production_account SET blocked_reason=NULL,revision=revision+1
 WHERE id=$1 AND owner_user_id=$2::uuid
   AND blocked_reason='awaiting_account_commissioning'
   AND commissioned=true AND cash_precision_verified=true
   AND reserved_micros=0
   -- DB-server freshness check on the independent signed provider read.
   -- Do not rely on a stale cached worker reconciliation timestamp.
   AND $3::timestamptz > statement_timestamp()-interval '15 seconds'
   AND $3::timestamptz <= statement_timestamp()+interval '2 seconds'
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=$1)
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_event WHERE account_id=$1)
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0)
   AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1)
 RETURNING id`,[accountId,ownerId,
     repairEvidence?new Date(repairEvidence.observedAtMs).toISOString():null]);
    if(clear.rows.length!==1)return deny("commissioning_repair_transactional_guard_failed");
    if(!repairEvidence)return deny("commissioning_repair_fresh_exchange_evidence_missing");
    const audit={accountId,ownerId,releaseSha:sha,reviewId:String(b.reviewId),
      reviewerId:reviewer,priorReason:"awaiting_account_commissioning",
      newReason:null,confirmation:PROVISIONAL_REPAIR_CONFIRM,
      liveExchangeObservedAtMs:repairEvidence.observedAtMs,
      liveExchangeEvidenceDigest:repairEvidence.exchangeDigest};
    await client.query(`
 INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
 VALUES($1,$2,'OWNER_COMMISSIONING_FREEZE_REPAIR',$3::jsonb,$4)`,
    [randomUUID(),accountId,JSON.stringify(audit),v13Digest(audit)]);
  }
  if(accountNeedsEnable){
    const updated=await client.query(`
 UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false
 WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true
 AND execution_enabled=$3 AND kill_switch=true RETURNING id`,
    [accountId,ownerId,truth(current.execution_enabled)]);
    if(updated.rows.length!==1)return deny("account_enable_failed");
  }
  if(globalNeedsEnable){
    const master=await client.query(`
 UPDATE public.live_execution_config SET live_execution_enabled=true,manual_kill_switch=false,updated_at=now()
 WHERE id='singleton' AND mode='V13_PRODUCTION'
 AND live_execution_enabled=false AND manual_kill_switch=true RETURNING id`);
    if(master.rows.length!==1)return deny("shared_live_enable_failed");
  }
  // The final authenticated release must also reconcile a TERMINAL killed
  // worker lease. Without this, the account becomes live-eligible while ARM
  // permanently rejects the old lease's account_kill=true. Never recover a
  // worker-owned or uncertain lease here: those require a separate signed
  // stale-worker recovery and cannot be made executable by this approval.
  const leases=await client.query(`
 SELECT state,account_kill,arm_requested,fencing_token::text AS fencing_token
 FROM private.kalshi_account_worker_lease
 WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,
    [accountId,ownerId]);
  if(leases.rows.length>1)return deny("release_worker_lease_not_unique");
  if(leases.rows.length===1){
    const lease=leases.rows[0]!;
    if(lease.state==="killed"){
      if(lease.account_kill!==true||lease.arm_requested!==false)
        return deny("release_killed_lease_state_inconsistent");
      // Re-check complete absence of persisted financial or exit exposure
      // under the same transaction before fencing an old terminated worker.
      const flat=await client.query(`
 SELECT
   (SELECT count(*)::int FROM public.v13_production_position
      WHERE account_id=$1 AND quantity_hundredths<>0) AS positions,
   (SELECT count(*)::int FROM public.v13_production_intent
      WHERE account_id=$1 AND state NOT IN ('TERMINAL','BLOCKED')) AS intents,
   (SELECT count(*)::int FROM private.strata_emergency_exit_reservations
      WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) AS exits`,[accountId]);
      if(flat.rows.length!==1 ||
         Number(flat.rows[0]?.positions)!==0 ||
         Number(flat.rows[0]?.intents)!==0 ||
         Number(flat.rows[0]?.exits)!==0)
        return deny("release_killed_lease_exposure_unverified");
      const fenced=await client.query(`
 UPDATE private.kalshi_account_worker_lease
 SET state='released',account_kill=false,arm_requested=false,
     fencing_token=fencing_token+1,heartbeat_at=now(),released_at=now()
 WHERE execution_account_id=$1 AND owner_user_id=$2::uuid
   AND state='killed' AND account_kill=true AND arm_requested=false
   AND fencing_token=$3::bigint
   AND EXISTS(SELECT 1 FROM public.v13_production_account a
     WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.commissioned=true
       AND a.execution_enabled=true AND a.kill_switch=false AND a.blocked_reason IS NULL)
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_position
     WHERE account_id=$1 AND quantity_hundredths<>0)
   AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent
     WHERE account_id=$1 AND state NOT IN ('TERMINAL','BLOCKED'))
   AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations
     WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN'))
 RETURNING fencing_token::text AS fencing_token`,
        [accountId,ownerId,lease.fencing_token]);
      if(fenced.rows.length!==1)return deny("release_killed_lease_fence_failed");
      const evidence={ownerId,accountId,sha,reviewId:String(b.reviewId),
        oldFencingToken:String(lease.fencing_token),
        nextFencingToken:String(fenced.rows[0]?.fencing_token),
        state:"released",accountKill:false,armRequested:false};
      await client.query(`
 INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
 VALUES($1,$2,'OWNER_RELEASE_FENCED_TERMINAL_LEASE',$3::jsonb,$4)`,
        [randomUUID(),accountId,JSON.stringify(evidence),v13Digest(evidence)]);
    } else if(lease.state==="released"){
      if(lease.account_kill!==false)
        return deny("release_released_lease_kill_state_inconsistent");
    } else if(lease.state==="owned"){
      // An already-enabled account may renew technical evidence without
      // changing a running worker. A newly released account must be idle.
      if(accountNeedsEnable)return deny("release_owned_worker_requires_recovery");
    } else return deny("release_worker_lease_state_unverified");
  }
  if(evidence){
    const at=(deps.now??Date.now)();
    if((deps.sha??deployedGitSha)()!==sha||at<evidence.started||at-evidence.started>5000)return deny('release_signed_evidence_stale');
    const fresh=await client.query(`SELECT clock_timestamp()>=to_timestamp($1::double precision/1000)
      AND clock_timestamp()<to_timestamp($1::double precision/1000)+interval '5 seconds' AS fresh`,[evidence.started]);
    if(fresh.rows[0]?.fresh!==true)return deny('release_signed_evidence_stale');
    const audit={ownerId,accountId,sha,reviewId:String(b.reviewId),observedAtMs:evidence.started,historyDigest:evidence.history.reconciliationDigest,exchangeDigest:hash(evidence.snapshot),ordersSubmitted:false};
    await client.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,'OWNER_RELEASE_SIGNED_RECHECK',$3,$4)",[randomUUID(),accountId,audit,v13Digest(audit)]);
  }
  commitAttempted=true;await client.query("COMMIT");committed=true;
  return {ok:true,reason:"owner_approved_release_account_and_shared_live_enabled",
   releaseId:inserted.rows[0]?.id,expiresAt:inserted.rows[0]?.expires_at,
   provisionalFreezeRepaired:repairing,
   ordersSubmitted:false as const,workerStarted:false as const};
 }catch{return commitAttempted?{ok:false,reason:"owner_release_outcome_unknown",outcome:"UNKNOWN" as const,ordersSubmitted:false as const}:deny("owner_release_transaction_refused")}
 finally{if(client){let discard=commitAttempted&&!committed;if(!committed&&!commitAttempted)try{await client.query("ROLLBACK")}catch{discard=true;}client.release(discard)}}
}
