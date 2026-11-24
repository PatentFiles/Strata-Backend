import {inspectOwnerAccountOnboardingReadiness} from "./ownerAccountOnboardingReadiness";
import {inspectOwnerSignedExchangeReleaseProof} from "./ownerSignedExchangeReleaseProof";
import {inspectOwnerFiveGateReleaseAudit} from "./ownerFiveGateReleaseAudit";
import {readOwnedApprovedFeeEvidence,readOwnedRuntimeFeeEvidence,readInitialCommissioningReview,commissionOwnedAccount,COMMISSION_OWNED_ACCOUNT_CONFIRMATION,type InitialCommissioningReview} from "./personalAccountActivation";
import {refreshOwnerCommissioningCash} from "./ownerCommissioningCashTransition";
import {verifyOwnedHistoricalFunding} from "./ownedPilotTransfer";
import {pool} from "@workspace/db";

export const VERIFY_FINANCIAL_CHECKS="VERIFY_AND_COMMISSION_FINANCIAL_EVIDENCE_V1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeReason=(v:unknown)=>typeof v==="string"&&/^[a-z][a-z0-9_]{0,119}$/.test(v)?v:"financial_evidence_unavailable";
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
  const signed=await ports.signed(owner);
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
type TransitionPorts=Ports&{
 runtimeFee?:(owner:string)=>Promise<FeeResult>;
 funding:(owner:string)=>ReturnType<typeof verifyOwnedHistoricalFunding>;
 refreshCash:(owner:string)=>ReturnType<typeof refreshOwnerCommissioningCash>;
 review:(owner:string,fee:FeeResult)=>Promise<InitialCommissioningReview|null>;
 commission:(owner:string,review:InitialCommissioningReview,floor:number,observedAt:string)=>ReturnType<typeof commissionOwnedAccount>;
};
const transitionPorts:TransitionPorts={
 runtimeFee:id=>readOwnedRuntimeFeeEvidence(pool,id),
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
 let cashRecordPersisted=false,fundingRecordPersisted=false,commissioningPerformed=false;
 const wrap=(out:EvidenceResult,review:InitialCommissioningReview|null=null)=>({
  ...out,readOnly:false as const,version:"OWNED_FINANCIAL_COMMISSIONING_V2" as const,
  cashRecordPersisted,fundingRecordPersisted,commissioningPerformed,commissioningReview:review,
 });
 const blocked=(reason:string,checks=empty())=>wrap(result("BLOCKED",reason,checks));
 if(!consent)return {...blocked("financial_transition_exact_owner_consent_required"),ok:false as const};
 if(process.env.NODE_ENV!=="test"&&ports!==transitionPorts)
  return {...blocked("financial_transition_production_override_forbidden"),ok:false as const};
 try{
  let before=await ports.status(owner);
  const v1={expectedOwnerId:owner,confirmation:VERIFY_FINANCIAL_CHECKS};
  if(!eligibleForCash(before))return wrap(await verifyCommissioningFinancialChecks(owner,v1,ports));
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
  const cash=await ports.refreshCash(owner);
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
