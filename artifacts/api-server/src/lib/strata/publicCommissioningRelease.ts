/** Compose the real owner release services, not a second execution engine.
 * All authority writes follow a versioned, exact owner consent. Each underlying
 * service retains its own locks, signed evidence, risk and freshness checks.
 * A successful response means eligible for a SEPARATE explicit START only.
 */
import {createHash} from "node:crypto";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {publicSelfServiceReleaseQualified,readOwnedSelfServiceScope} from "./ownerSelfServiceEligibility";
import {bindPlatformFeeV5ToOwner,capturePlatformOfficialFeeV5} from "./independentOfficialFeeV5";
import {previewDurableFeeMigration,migrateOwnedDurableFeePolicy,DURABLE_MIGRATION_CONFIRM,DURABLE_PUBLICATION_RISK_ACCEPTANCE} from "./durableFeeMigration";
import {isDurableFeeVersion} from "./durableOwnerFeePolicy";
import {parseV3FeeSource} from "./ownerFeeV3Authority";
import {readOwnedRuntimeFeeEvidence,reportOwnedActivation} from "./personalAccountActivation";
import {prepareActivationRequest} from "./ownerCommissioningFinancialChecks";
import {qualifyProtectiveRelease} from "./inAppProtectiveRelease";
import {recordOwnerSelfStandingReview} from "./ownerSelfStandingReview";
import {OWNER_SELF_REVIEW_CONFIRM} from "./ownerSelfReviewMode";
import {activateOwnerSelfAccount,ownerSelfActivationOutcome,OWNER_SELF_ACTIVATION_CONFIRM} from "./ownerSelfAccountActivation";
import {standingExecutionStatus} from "./standingExecutionReview";
import {enrollContinuousGrant,checkContinuousBootstrap,CONTINUOUS_OWNER_CONFIRM} from "./continuousExecutionAuthorization";
import {qualifyPublicIndependentLiveScope} from "../v13-production/liveEntryContainment";
import {digest} from "../v13-production/types";
import {verifyMonetaryFeeContract} from "./monetaryFeeContract";

export const REVIEW_PUBLIC_RELEASE="REVIEW_PUBLIC_OWNER_RELEASE_V1";
export const CONFIRM_PUBLIC_RELEASE="CONFIRM_PUBLIC_OWNER_RELEASE_V1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;
const no=(reason:string)=>({ok:false as const,version:"PUBLIC_OWNER_RELEASE_V1" as const,reason,review:null,
 readyToTrade:false as const,tradingAuthorized:false as const,ordersSubmitted:false as const,workerStarted:false as const,transferAttempted:false as const});
const txt=(x:unknown)=>typeof x==="string"?x:"";
export function parsePublicReleaseConsent(owner:string,raw:unknown){
 if(!UUID.test(owner)||!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const b=raw as Row,preview=b.confirmation===REVIEW_PUBLIC_RELEASE,confirm=b.confirmation===CONFIRM_PUBLIC_RELEASE;
 const keys=Object.keys(b).sort().join(",");
 if(b.expectedOwnerId!==owner||(!preview&&!confirm)||(preview?keys!=="confirmation,expectedOwnerId":keys!=="confirmation,expectedOwnerId,scopeDigest"||!HASH.test(txt(b.scopeDigest))))return null;
 return {preview,scopeDigest:confirm?txt(b.scopeDigest):null};
}
function attemptId(scope:string){const b=createHash("sha256").update("public-owner-release-v1:"+scope).digest("hex");
 return b.slice(0,8)+"-"+b.slice(8,12)+"-5"+b.slice(13,16)+"-a"+b.slice(17,20)+"-"+b.slice(20,32);}
async function current(owner:string,sha:string){
 const a=await readOwnedSelfServiceScope(pool,owner,sha);
 if(!a||!a.commissioned||a.blocked||!a.cashConserved||!a.cashReconciled||a.reservedMicros!=="0"||
  BigInt(a.cashMicros)<BigInt(a.stakeCents)*10000n)return null;
 const p=await pool.query("SELECT a.minimum_exit_micros,a.fee_artifact_digest,p.id,p.version,p.policy_hash,p.fee_policy_version,p.fee_source_url,"+
 "p.capital_limit_cents,p.max_entry_stake_cents,p.max_entry_all_in_cents,p.max_daily_loss_cents,p.max_total_loss_cents,"+
 "p.max_open_positions,p.max_quote_age_ms,p.max_fee_evidence_age_ms "+
 "FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id "+
 "WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND p.created_by=$1::text AND p.approved_by=$1::text AND p.state='APPROVED' LIMIT 2",[owner,a.accountId]);
 if(p.rows.length!==1||p.rows[0]!.policy_hash!==a.policyHash||Number(p.rows[0]!.minimum_exit_micros)!==10000)return null;
 return {a,p:p.rows[0]!};
}
type Current=NonNullable<Awaited<ReturnType<typeof current>>>;
const riskColumns=["capital_limit_cents","max_entry_stake_cents","max_entry_all_in_cents","max_daily_loss_cents","max_total_loss_cents","max_open_positions","max_quote_age_ms","max_fee_evidence_age_ms"] as const;
async function review(owner:string,sha:string){
 const scope=await current(owner,sha);if(!scope)return null;
 const {a,p}=scope;
 let mode:"existing"|"durable_migration"="existing",feeDigest=txt(p.fee_artifact_digest),captureId:string|null=null;
 if(!isDurableFeeVersion(p.fee_policy_version)&&!parseV3FeeSource(txt(p.fee_source_url))){
  if(!a.killSwitchOn||a.executionEnabled)return null;
  // Publisher evidence preparation does not create a fee authority.
  await capturePlatformOfficialFeeV5();
  const binding=await bindPlatformFeeV5ToOwner(owner);
  if(!binding.ok)return null;
  const monetary=await verifyMonetaryFeeContract("STEP_11");
  if(!monetary.ok||!monetary.monetaryFeeAuthorized||monetary.sourceDigest!==binding.digest)return null;
  const migration=await previewDurableFeeMigration(owner);
  if(!migration.ok||!migration.candidateCapture||migration.expectedPolicyHash!==a.policyHash||
    migration.candidateCapture.digest!==binding.digest||String(migration.candidateCapture.captureId)!==binding.captureId)return null;
  mode="durable_migration";feeDigest=binding.digest;captureId=binding.captureId;
 }else{
  const fee=await readOwnedRuntimeFeeEvidence(pool,owner);
  if(!fee.ok||fee.feeArtifactDigest!==feeDigest)return null;
 }
 if(!HASH.test(feeDigest))return null;
 const limits={capitalLimitCents:Number(p.capital_limit_cents),maxEntryStakeCents:Number(p.max_entry_stake_cents),
  maxEntryAllInCents:Number(p.max_entry_all_in_cents),maxDailyLossCents:Number(p.max_daily_loss_cents),
  maxTotalLossCents:Number(p.max_total_loss_cents),maxOpenPositions:Number(p.max_open_positions),
  maxQuoteAgeMs:Number(p.max_quote_age_ms),maxFeeEvidenceAgeMs:Number(p.max_fee_evidence_age_ms)};
 if(!Object.values(limits).every(n=>Number.isSafeInteger(n)&&n>0))return null;
 const latest=await current(owner,sha);
 if(!latest||digest(latest)!==digest(scope))return null;
 const core={ownerId:owner,accountId:a.accountId,releaseSha:sha,policyHash:a.policyHash,
  policyVersion:Number(p.version),stakeCents:a.stakeCents,cashMicros:a.cashMicros,minimumExitMicros:10000,
  feeDigest,feeMode:mode,limits};
 return {scope,captureId,review:{...core,scopeDigest:digest({core,keyFingerprint:a.keyFingerprint,policyId:p.id})}};
}
async function finishRelease(owner:string,sha:string,scope:Current){
 const a=scope.a,account=a.accountId,policyHash=a.policyHash;
 const exact={expectedSha:sha,accountId:account,policyHash};
 let standing=await standingExecutionStatus(owner);
 if(!standing.ok||standing.ownerId!==owner||standing.accountId!==account||standing.policyHash!==policyHash||standing.sha!==sha||!standing.ownerSelfAvailable)
  return no("public_release_owner_scope_changed");
 if(a.killSwitchOn){
  if(a.executionEnabled||standing.grantExists||standing.grantRevoked)return no("public_release_existing_authority_requires_reconciliation");
  const request=await prepareActivationRequest(owner);
  if(!request.ok)return no(request.reason);
  let qid=txt(standing.reviewQualificationId),rid=txt(standing.reviewId);
  if(rid){
   // Reuse an exact immutable owner review; its qualification is checked
   // again by activateOwnerSelfAccount. Never replace expired/revoked consent.
   if(standing.reviewAuthority!=="OWNER_SELF_V1"||standing.ownerAuthorizerId!==owner||!UUID.test(qid)||!UUID.test(rid))
    return no("public_release_existing_review_requires_reconciliation");
  }else{
   // Refuse to re-create a revoked or ambiguous authority automatically.
   const prior=await pool.query("SELECT 1 FROM private.strata_standing_execution_reviews WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3 AND policy_hash=$4 LIMIT 1",[owner,account,sha,policyHash]);
   if(prior.rows.length)return no("public_release_prior_review_requires_reconciliation");
   const q=await qualifyProtectiveRelease(owner);
   if(!q.ok||!("qualificationId" in q)||!UUID.test(String(q.qualificationId)))return no(q.ok?"public_release_qualification_unconfirmed":q.reason);
   qid=String(q.qualificationId);
   const r=await recordOwnerSelfStandingReview(owner,{...exact,qualificationId:qid,confirmation:OWNER_SELF_REVIEW_CONFIRM});
   if(!r.ok||!("reviewId" in r)||!UUID.test(String(r.reviewId)))return no(r.reason);
   rid=String(r.reviewId);
  }
  const activation=await activateOwnerSelfAccount(owner,{...exact,qualificationId:qid,reviewId:rid,confirmation:OWNER_SELF_ACTIVATION_CONFIRM});
  if(!activation.ok)return no(activation.reason);
 }else if(!a.executionEnabled)return no("public_release_execution_state_inconsistent");
 const active=await ownerSelfActivationOutcome(owner,sha);
 if(active.outcome!=="RECORDED"||!active.eligibilityCurrent||active.accountId!==account)return no("public_release_activation_readback_unverified");
 standing=await standingExecutionStatus(owner);
 if(!standing.ok||standing.accountId!==account||standing.policyHash!==policyHash||standing.ownerId!==owner||
  standing.sha!==sha||standing.grantRevoked||standing.reviewAuthority!=="OWNER_SELF_V1"||standing.ownerAuthorizerId!==owner)
  return no("public_release_standing_readback_unverified");
 if(!standing.grantActive){
  if(standing.grantExists)return no("public_release_prior_grant_requires_reconciliation");
  const grant=await enrollContinuousGrant(owner,{...exact,confirmation:CONTINUOUS_OWNER_CONFIRM});
  if(!grant.ok)return no(grant.reason);
 }
 const status=await reportOwnedActivation(pool,owner),fee=await readOwnedRuntimeFeeEvidence(pool,owner);
 const admission=await qualifyPublicIndependentLiveScope(pool,{ownerId:owner,accountId:account,releaseSha:sha});
 if(!status.readyForLive||status.accountId!==account||!fee.ok||fee.feeArtifactDigest!==scope.p.fee_artifact_digest||
  !admission||admission.policyHash!==policyHash||!await checkContinuousBootstrap(pool,owner,sha))
  return no("public_release_final_start_preflight_unverified");
 const stopped=await pool.query("SELECT 1 FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND state='released' AND account_kill=false AND arm_requested=false LIMIT 2",[account,owner]);
 if(stopped.rows.length!==1)return no("public_release_worker_not_disarmed");
 return {...no("public_owner_ready_for_explicit_start"),ok:true as const,readyToTrade:true as const};
}
export async function publicReleaseAction(owner:string,raw:unknown){
 const consent=parsePublicReleaseConsent(owner,raw),sha=deployedGitSha();
 if(!consent)return no("public_release_exact_owner_consent_required");
 if(!publicSelfServiceReleaseQualified(sha))return no("public_self_service_release_not_qualified");
 if(process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED!=="true"||
  process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=="true"||process.env.STRATA_INDEPENDENT_LIVE_SOURCE_V1!=="true")
  return no("public_release_platform_execution_not_qualified");
 try{
  const verified=await review(owner,sha);
  if(!verified)return no("public_release_verified_account_or_fee_scope_unavailable");
  if(consent.preview)return {...no("public_release_review_ready"),ok:true as const,review:verified.review};
  if(verified.review.scopeDigest!==consent.scopeDigest)return no("public_release_review_scope_changed");
  if(verified.review.feeMode==="durable_migration"){
   const p=verified.scope.p,a=verified.scope.a;
   const migrated=await migrateOwnedDurableFeePolicy(owner,{accountId:a.accountId,captureId:verified.captureId,
    confirmation:DURABLE_MIGRATION_CONFIRM,expectedPolicyHash:a.policyHash,expectedPolicyId:p.id,
    expectedPolicyVersion:Number(p.version),expectedSha:sha,modelId:attemptId(verified.review.scopeDigest),riskAcceptance:DURABLE_PUBLICATION_RISK_ACCEPTANCE});
   if(!migrated.ok)return no(migrated.reason);
  }
  const next=await current(owner,sha);
  if(!next||next.a.accountId!==verified.scope.a.accountId||next.a.keyFingerprint!==verified.scope.a.keyFingerprint||
   next.a.stakeCents!==verified.scope.a.stakeCents||next.a.cashMicros!==verified.scope.a.cashMicros||
   next.p.fee_artifact_digest!==verified.review.feeDigest)return no("public_release_policy_migration_readback_unverified");
  if(verified.review.feeMode==="durable_migration"&&!isDurableFeeVersion(next.p.fee_policy_version))return no("public_release_durable_model_not_recorded");
  if(verified.review.feeMode==="existing"&&next.a.policyHash!==verified.scope.a.policyHash)return no("public_release_policy_changed");
  if(riskColumns.some(k=>String(next.p[k])!==String(verified.scope.p[k])))return no("public_release_risk_settings_changed");
  return await finishRelease(owner,sha,next);
 }catch{return no("public_release_outcome_unconfirmed_refresh_records");}
}
