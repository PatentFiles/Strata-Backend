import {inspectOwnerAccountOnboardingReadiness} from "./ownerAccountOnboardingReadiness";
import {inspectOwnerSignedExchangeReleaseProof} from "./ownerSignedExchangeReleaseProof";
import {inspectOwnerFiveGateReleaseAudit} from "./ownerFiveGateReleaseAudit";
import {readOwnedApprovedFeeEvidence,readOwnedRuntimeFeeEvidence,readInitialCommissioningReview,commissionOwnedAccount,COMMISSION_OWNED_ACCOUNT_CONFIRMATION,requestOwnedAccountActivation,REQUEST_OWNED_ACTIVATION_CONFIRMATION,type InitialCommissioningReview} from "./personalAccountActivation";
import {refreshOwnerCommissioningCash} from "./ownerCommissioningCashTransition";
import {verifyOwnedHistoricalFunding} from "./ownedPilotTransfer";
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {initializePublicStoppedLease,publicSelfServiceRequested} from "./ownerSelfServiceEligibility";
import {qualifyProtectiveRelease} from "./inAppProtectiveRelease";

export const VERIFY_FINANCIAL_CHECKS="VERIFY_AND_COMMISSION_FINANCIAL_EVIDENCE_V1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeReason=(v:unknown)=>typeof v==="string"&&/^[a-z][a-z0-9_]{0,119}$/.test(v)?v:"financial_evidence_unavailable";
/** Only this refusal is known to come from a pre-commit signed diagnostic
 * whose final revision fence changed. Re-acquire fresh evidence instead of
 * accepting the old snapshot. Never replay an uncertain commit or provider
 * mutation. Stop on any other refusal, or after three total attempts. */
export async function retrySignedDiagnosticRace<T extends {ok:boolean;reason?:string}>(read:()=>Promise<T>):Promise<T>{
 const started=performance.now();
 let out=await read();
 for(let retry=0;retry<2&&!out.ok&&out.reason==="account_changed_during_signed_diagnostic"&&performance.now()-started<12000;retry++){
  await new Promise<void>(resolve=>setTimeout(resolve,125*(retry+1)));
  out=await read();
 }
 return out;
}
type FeeResult=Awaited<ReturnType<typeof readOwnedApprovedFeeEvidence>>;
type Ports={
 status:(owner:string)=>ReturnType<typeof inspectOwnerAccountOnboardingReadiness>;
 signed:(owner:string)=>ReturnType<typeof inspectOwnerSignedExchangeReleaseProof>;
 fee:(owner:string)=>Promise<FeeResult>;
 release:(owner:string)=>ReturnType<typeof inspectOwnerFiveGateReleaseAudit>;
};
type Stage="TECHNICAL_REQUIRED"|"FUNDING_REQUIRED"|"OPENING_CAPITAL_RECOVERY_REQUIRED"|"POLICY_REQUIRED"|
 "CASH_RECONCILIATION_REQUIRED"|"FEE_AUTHORITY_REQUIRED"|"COMMISSIONING_REQUIRED"|"RELEASE_REQUIRED"|"CHECKS_COMPLETE"|"BLOCKED";
type Checks={fundingRecordPresent:boolean;openingCapitalConserved:boolean;approvedPolicyPresent:boolean;
 signedHistoryFlat:boolean;signedCashMatches:boolean;marketFeeMetadataVerified:boolean;approvedFeeSourceVerified:boolean;
 cashReconciliationRecordCurrent:boolean;commissioned:boolean;protectiveReleaseRecorded:boolean;ownerReleaseRecorded:boolean};
const empty=():Checks=>({fundingRecordPresent:false,openingCapitalConserved:false,approvedPolicyPresent:false,
 signedHistoryFlat:false,signedCashMatches:false,marketFeeMetadataVerified:false,approvedFeeSourceVerified:false,
 cashReconciliationRecordCurrent:false,commissioned:false,protectiveReleaseRecorded:false,ownerReleaseRecorded:false});
const result=(stage:Stage,reason:string,checks:Checks)=>({ok:true as const,stage,reason:safeReason(reason),checks:{...checks},
 readOnly:true as const,tradingAuthorized:false as const,ordersSubmitted:false as const,transferAttempted:false as const,workerStarted:false as const});
export function validFinancialChecksConsent(owner:string,raw:unknown){
 if(!UUID.test(owner)||!raw||typeof raw!=="object"||Array.isArray(raw))return false;
 const b=raw as Record<string,unknown>;
 return Object.keys(b).sort().join(",")==="confirmation,expectedOwnerId"&&b.expectedOwnerId===owner&&b.confirmation===VERIFY_FINANCIAL_CHECKS;
}
/** A single versioned continuation of technical onboarding. All monetary
 * evidence is collected by established server services, not browser digests.
 * This version is explicitly evidence-only: no transfer, repair, fee grant,
 * policy approval, commissioning write, worker control or live authority.
 * Durable completion is read from existing records on every explicit request.
 */
export async function verifyCommissioningFinancialChecks(owner:string,raw:unknown,ports:Ports={
 status:inspectOwnerAccountOnboardingReadiness,
 signed:id=>inspectOwnerSignedExchangeReleaseProof(id,{allowStoppedUncommissioned:true}),
 fee:id=>readOwnedApprovedFeeEvidence(pool,id),
 release:inspectOwnerFiveGateReleaseAudit,
}){
 const checks=empty();
 if(!validFinancialChecksConsent(owner,raw))return {...result("BLOCKED","financial_checks_exact_owner_consent_required",checks),ok:false as const};
 try{
  const before=await ports.status(owner);
  if(!before.ok)return result("BLOCKED",before.reason,checks);
  if(!before.emailVerified||!before.ownedAccountUnique||!before.credentials.allFourRecorded||before.keyInventory.connection!=="saved")
   return result("TECHNICAL_REQUIRED","verified_account_and_all_roles_required",checks);
  checks.commissioned=before.account.commissioned;
  checks.fundingRecordPresent=before.funding.historicalOrCompletedTransferRecorded;
  checks.openingCapitalConserved=before.openingBasis?.differenceMicros==="0";
  checks.approvedPolicyPresent=before.policy.approvedRecord&&Number.isSafeInteger(before.policy.configuredStakeCents)&&Number(before.policy.configuredStakeCents)>0;
  if(!before.account.killSwitchOn||before.account.otherFreeze)
   return result("BLOCKED","stopped_account_or_existing_safety_hold_requires_review",checks);
  if(!before.openingBasis)return result("BLOCKED","local_accounting_unverified",checks);
  if(!checks.openingCapitalConserved)
   return result("OPENING_CAPITAL_RECOVERY_REQUIRED","opening_capital_difference_requires_signed_owner_recovery",checks);
  if(!checks.fundingRecordPresent)return result("FUNDING_REQUIRED","verify_existing_funding_without_repeating_transfer",checks);
  if(!checks.approvedPolicyPresent)return result("POLICY_REQUIRED","owner_approved_strategy_and_risk_configuration_required",checks);
  const signed=await retrySignedDiagnosticRace(()=>ports.signed(owner));
  if(!signed.ok)return result("CASH_RECONCILIATION_REQUIRED",signed.reason,checks);
  checks.signedHistoryFlat=signed.authenticatedExchangeFlat===true;
  checks.signedCashMatches=signed.exchangeCashMatchesLedger===true;
  checks.marketFeeMetadataVerified=signed.apiMarketFeeMetadataVerified===true;
  if(!checks.signedHistoryFlat||!checks.signedCashMatches)
   return result("CASH_RECONCILIATION_REQUIRED","signed_cash_or_complete_history_does_not_match",checks);
  // Actual approved-policy verification performs the existing issuer/API
  // checks, including consent and review rules. API metadata alone is not it.
  const fee=await ports.fee(owner);
  checks.approvedFeeSourceVerified=fee.ok===true&&typeof fee.feeArtifactDigest==="string"&&/^[a-f0-9]{64}$/.test(fee.feeArtifactDigest);
  const audit=await ports.release(owner);
  const after=await ports.status(owner);
  // A concurrent owner/account change invalidates this composite report.
  if(!after.ok||!after.ownedAccountUnique||!after.credentials.allFourRecorded||!after.account.killSwitchOn||
    after.account.otherFreeze||JSON.stringify(before.openingBasis)!==JSON.stringify(after.openingBasis)||
    JSON.stringify(before.policy)!==JSON.stringify(after.policy)||JSON.stringify(before.account)!==JSON.stringify(after.account)||
    JSON.stringify(before.keyInventory)!==JSON.stringify(after.keyInventory)||
    !after.funding.historicalOrCompletedTransferRecorded)
   return result("BLOCKED","account_changed_during_financial_checks",empty());
  if(audit.ok){
   checks.cashReconciliationRecordCurrent=audit.cash.persistedReconciliationFresh&&audit.cash.localExposureFlat;
   checks.protectiveReleaseRecorded=audit.exit.protectiveRelease.recordPresent;
   checks.ownerReleaseRecorded=audit.owner.exactShaApproval.recordPresent;
  }
  if(!checks.marketFeeMetadataVerified||!checks.approvedFeeSourceVerified)
   return result("FEE_AUTHORITY_REQUIRED",fee.ok?"market_fee_metadata_unverified":fee.reason,checks);
  if(!checks.cashReconciliationRecordCurrent)
   return result("CASH_RECONCILIATION_REQUIRED","record_current_verified_cash_reconciliation",checks);
  if(!after.account.commissioned||after.account.provisionalHold)
   return result("COMMISSIONING_REQUIRED","complete_owner_scoped_commissioning_transition",checks);
  if(!checks.protectiveReleaseRecorded||!checks.ownerReleaseRecorded)
   return result("RELEASE_REQUIRED","exact_release_and_protective_authority_required",checks);
  // A composite read is not an execution lease, one-use permit or START.
  return result("CHECKS_COMPLETE","recorded_checks_complete_independent_execution_preflight_still_required",checks);
 }catch{return result("BLOCKED","financial_evidence_unavailable",checks);}
}

/** V1 remains read-only. V2 explicitly authorizes recording genuinely verified
 * existing funding and cash evidence, including first-time opening capital
 * from one registered transfer. No transfer, recovery of a commissioned basis,
 * policy amendment, fee grant, protective release or START is authorized. */
export const ADVANCE_FINANCIAL_COMMISSIONING="ADVANCE_OWNED_FINANCIAL_COMMISSIONING_V2";
export const CONFIRM_INITIAL_COMMISSIONING="CONFIRM_OWNED_INITIAL_COMMISSIONING_V2";
// This is NOT owner release consent or activation eligibility. It permits
// preparing the existing activation request and technical qualification only.
export const PREPARE_RELEASE_QUALIFICATION="PREPARE_OWNED_RELEASE_QUALIFICATION_V1";
export async function prepareActivationRequest(owner:string){
 const refuse=(reason:string)=>({ok:false,reason,executionEnabled:false as const,killSwitchCleared:false as const,liveEnabled:false as const});
 const tx=await pool.connect();
 let committed=false,commitAttempted=false,discard:Error|undefined;
 try{
  await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const locked=await tx.query(`SELECT a.id FROM public.v13_production_account a
   WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
   AND a.commissioned=true AND a.execution_enabled=false AND a.kill_switch=true
   AND a.blocked_reason IS NULL AND a.reserved_micros=0 AND a.minimum_exit_micros=10000
   AND a.cash_precision_verified=true AND a.reconciled_at BETWEEN now()-interval '15 minutes' AND now()
   AND a.cash_micros=a.initial_cash_micros+COALESCE((SELECT SUM(e.cash_delta_micros) FROM public.v13_production_event e WHERE e.account_id=a.id),0)
   FOR UPDATE OF a`,[owner]);
  if(locked.rows.length!==1)return refuse("stopped_commissioned_release_scope_required");
  const lease=await tx.query("SELECT execution_account_id FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 FOR UPDATE",[locked.rows[0].id]);
  // Public customers do not have an administrator-created worker. Initialize
  // only a never-run account, with both execution gates closed.
  if(publicSelfServiceRequested()&&lease.rows.length===0&&
   !await initializePublicStoppedLease(tx,owner,String(locked.rows[0].id),deployedGitSha()))
   return refuse("initial_stopped_worker_lease_unavailable");
  const active=await tx.query(`SELECT 1 FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1
   AND (owner_user_id IS DISTINCT FROM $2::uuid OR state NOT IN ('released','killed') OR arm_requested IS DISTINCT FROM false)`,[locked.rows[0].id,owner]);
  if(active.rows.length)return refuse("release_preparation_worker_not_stopped");
  const recorded=await requestOwnedAccountActivation(tx,{ownerUserId:owner,confirmation:REQUEST_OWNED_ACTIVATION_CONFIRMATION});
  if(!recorded.ok)return recorded;
  commitAttempted=true;await tx.query("COMMIT");committed=true;
  return recorded;
 }catch{
  if(commitAttempted){discard=new Error("release_preparation_commit_unknown");return refuse("release_preparation_outcome_unknown");}
  return refuse("release_preparation_account_request_unavailable");
 }finally{
  if(!committed&&!discard){try{await tx.query("ROLLBACK");}catch{discard=new Error("release_preparation_rollback_failed");}}
  tx.release(discard);
 }
}
type TransitionPorts=Ports&{
 runtimeFee?:(owner:string)=>Promise<FeeResult>;
 prepareActivation?:(owner:string)=>ReturnType<typeof prepareActivationRequest>;
 qualify?:(owner:string)=>ReturnType<typeof qualifyProtectiveRelease>;
 funding:(owner:string)=>ReturnType<typeof verifyOwnedHistoricalFunding>;
 refreshCash:(owner:string)=>ReturnType<typeof refreshOwnerCommissioningCash>;
 review:(owner:string,fee:FeeResult)=>Promise<InitialCommissioningReview|null>;
 commission:(owner:string,review:InitialCommissioningReview,floor:number,observedAt:string)=>ReturnType<typeof commissionOwnedAccount>;
};
const transitionPorts:TransitionPorts={
 runtimeFee:id=>readOwnedRuntimeFeeEvidence(pool,id),
 prepareActivation:prepareActivationRequest,
 qualify:id=>qualifyProtectiveRelease(id),
 status:inspectOwnerAccountOnboardingReadiness,
 signed:id=>inspectOwnerSignedExchangeReleaseProof(id,{allowStoppedUncommissioned:true}),
 fee:id=>readOwnedApprovedFeeEvidence(pool,id),
 release:inspectOwnerFiveGateReleaseAudit,
 funding:id=>verifyOwnedHistoricalFunding(pool,id),
 refreshCash:refreshOwnerCommissioningCash,
 review:(id,fee)=>readInitialCommissioningReview(pool,id,fee),
 commission:(id,review,floor,observedAt)=>commissionOwnedAccount(pool,{
  ownerUserId:id,confirmation:COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
  feeArtifactDigest:review.feeDigest,minimumExitMicros:floor,initialReview:review,signedCashObservedAt:observedAt,
 }),
};
function transitionConsent(owner:string,raw:unknown){
 if(!UUID.test(owner)||!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const b=raw as Record<string,unknown>,keys=Object.keys(b).sort().join(",");
 if(b.expectedOwnerId!==owner)return null;
 if(b.confirmation===PREPARE_RELEASE_QUALIFICATION&&keys==="confirmation,expectedOwnerId")return {mode:"prepare" as const};
 if(b.confirmation===ADVANCE_FINANCIAL_COMMISSIONING&&keys==="confirmation,expectedOwnerId")
  return {mode:"advance" as const};
 if(b.confirmation===CONFIRM_INITIAL_COMMISSIONING&&keys==="confirmation,expectedOwnerId,minimumExitMicros,scopeDigest"&&
  typeof b.scopeDigest==="string"&&/^[a-f0-9]{64}$/.test(b.scopeDigest)&&typeof b.minimumExitMicros==="number"&&
  Number.isSafeInteger(b.minimumExitMicros)&&b.minimumExitMicros>=1&&b.minimumExitMicros<=999999)
  return {mode:"commission" as const,scopeDigest:b.scopeDigest,floor:b.minimumExitMicros};
 return null;
}
type EvidenceResult=Awaited<ReturnType<typeof verifyCommissioningFinancialChecks>>;
function eligibleForCash(status:Awaited<ReturnType<Ports["status"]>>){
 return status.ok&&status.emailVerified&&status.ownedAccountUnique&&status.credentials.allFourRecorded&&
  status.keyInventory.connection==="saved"&&status.account.killSwitchOn&&!status.account.otherFreeze&&
  status.openingBasis?.differenceMicros==="0";
}
/** Existing durable database records are the checkpoint. A bounded invocation
 * can register historical evidence, commit a fresh cash observation, then
 * prepare or apply the exact initial commission. A new request always reads
 * the authoritative state first. Never replay an uncertain mutation inside
 * this invocation or claim that a recorded approval constitutes live authority. */
export async function advanceOwnerFinancialCommissioning(owner:string,raw:unknown,ports:TransitionPorts=transitionPorts){
 if(validFinancialChecksConsent(owner,raw))return verifyCommissioningFinancialChecks(owner,raw,ports);
 const consent=transitionConsent(owner,raw);
 let cashRecordPersisted=false,fundingRecordPersisted=false,commissioningPerformed=false,activationRequestRecorded=false,qualificationPrepared=false;
 const wrap=(out:EvidenceResult,review:InitialCommissioningReview|null=null)=>({
  ...out,readOnly:false as const,version:"OWNED_FINANCIAL_COMMISSIONING_V2" as const,
  cashRecordPersisted,fundingRecordPersisted,commissioningPerformed,commissioningReview:review,
  ...(consent?.mode==="prepare"?{activationRequestRecorded,qualificationPrepared}:{}),
 });
 const blocked=(reason:string,checks=empty())=>wrap(result("BLOCKED",reason,checks));
 if(!consent)return {...blocked("financial_transition_exact_owner_consent_required"),ok:false as const};
 if(process.env.NODE_ENV!=="test"&&ports!==transitionPorts)
  return {...blocked("financial_transition_production_override_forbidden"),ok:false as const};
 try{
  let before=await ports.status(owner);
  const v1={expectedOwnerId:owner,confirmation:VERIFY_FINANCIAL_CHECKS};
  if(!eligibleForCash(before))return wrap(await verifyCommissioningFinancialChecks(owner,v1,ports));
  if(consent.mode==="prepare"){
   // An explicit preparation request never performs funding, reconciliation
   // writes, initial commission, repair, owner activation or continuous grant.
   if(!before.account.commissioned||before.account.provisionalHold)
    return wrap(await verifyCommissioningFinancialChecks(owner,v1,ports));
   const evidence=await verifyCommissioningFinancialChecks(owner,v1,{...ports,fee:ports.runtimeFee??ports.fee});
   if(evidence.stage!=="RELEASE_REQUIRED"&&evidence.stage!=="CHECKS_COMPLETE")return wrap(evidence);
   if(!ports.prepareActivation||!ports.qualify)return blocked("release_preparation_unavailable",evidence.checks);
   const requested=await ports.prepareActivation(owner);
   if(!requested.ok)return wrap(result("RELEASE_REQUIRED",requested.reason,evidence.checks));
   activationRequestRecorded=true;
   const qualification=await ports.qualify(owner);
   if(!qualification.ok||!("qualificationId" in qualification)||!UUID.test(String(qualification.qualificationId))||
    !Number.isFinite(Date.parse(String(qualification.expiresAt)))||Date.parse(String(qualification.expiresAt))<=Date.now())
    return wrap(result("RELEASE_REQUIRED",qualification.ok?"release_qualification_readback_unverified":qualification.reason,evidence.checks));
   qualificationPrepared=true;
   // This records technical proof, NOT release permission. Owner-specific
   // approvals, final execution preflight and explicit START remain separate.
   return wrap(result("RELEASE_REQUIRED","signed_protective_qualification_prepared_owner_release_required",evidence.checks));
  }
  // A previously commissioned account missing a receipt needs its genuine
  // recovery path; the fixed initial-funding verifier cannot repair it.
  if(!before.funding.historicalOrCompletedTransferRecorded&&!before.account.commissioned&&consent.mode==="advance"){
   const found=await ports.funding(owner);
   if(!found.ok||!found.historicalVerified)return wrap(result("FUNDING_REQUIRED",found.reason,empty()));
   fundingRecordPersisted=true;before=await ports.status(owner);
   if(!eligibleForCash(before)||!before.funding.historicalOrCompletedTransferRecorded)return blocked("financial_funding_readback_unverified");
  }
  if(!before.funding.historicalOrCompletedTransferRecorded||!before.policy.approvedRecord||
    !Number.isSafeInteger(before.policy.configuredStakeCents)||Number(before.policy.configuredStakeCents)<=0)
   return wrap(await verifyCommissioningFinancialChecks(owner,v1,ports));
  // Repeat confirmations of a completed commission are readback, never a
  // second commissioning write or a different floor/policy approval.
  if(consent.mode==="commission"&&before.account.commissioned)
   return wrap(await verifyCommissioningFinancialChecks(owner,v1,ports));
  // A scope-revision refusal from refreshCash occurs before its write phase.
  // Each retry performs new signed reads and the original transactional fences.
  const cash=await retrySignedDiagnosticRace(()=>ports.refreshCash(owner));
  if(!cash.ok)return wrap(result("CASH_RECONCILIATION_REQUIRED",cash.reason,empty()));
  cashRecordPersisted=true;
  const feeCapture:{value:FeeResult|null}={value:null};
  // V1 remains on STEP_9. Only the explicitly authorized continuation uses
  // current runtime authority, including existing standing lease renewal.
  const runtimePorts:Ports={...ports,fee:ports.runtimeFee??ports.fee};
  const evidence=await verifyCommissioningFinancialChecks(owner,v1,{
   ...runtimePorts,fee:async id=>{const f=await runtimePorts.fee(id);feeCapture.value=f;return f;},
  });
  if(evidence.stage!=="COMMISSIONING_REQUIRED"||evidence.checks.commissioned||!feeCapture.value?.ok)
   return wrap(evidence);
  const review=await ports.review(owner,feeCapture.value);
  if(!review)return blocked("initial_commissioning_review_scope_unverified",evidence.checks);
  if(consent.mode==="advance")return wrap(evidence,review);
  if(review.scopeDigest!==consent.scopeDigest||
    (review.existingExitFloorMicros!==null&&review.existingExitFloorMicros!==consent.floor))
   return blocked("initial_commissioning_review_scope_changed",evidence.checks);
  const done=await ports.commission(owner,review,consent.floor,cash.observedAt);
  if(!done.ok)return blocked(done.reason,evidence.checks);
  commissioningPerformed=true;
  // Resume through existing evidence and release checks after the real
  // financial state transition, never grant a worker or trading permit.
  return wrap(await verifyCommissioningFinancialChecks(owner,v1,runtimePorts));
 }catch{return blocked("financial_transition_outcome_unconfirmed_refresh_records");}
}
