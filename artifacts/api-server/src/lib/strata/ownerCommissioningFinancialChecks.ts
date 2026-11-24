import {inspectOwnerAccountOnboardingReadiness} from "./ownerAccountOnboardingReadiness";
import {inspectOwnerSignedExchangeReleaseProof} from "./ownerSignedExchangeReleaseProof";
import {inspectOwnerFiveGateReleaseAudit} from "./ownerFiveGateReleaseAudit";
import {readOwnedApprovedFeeEvidence} from "./personalAccountActivation";
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
