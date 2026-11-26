import {preflightV13LiveMoneyEntry} from "./v13LiveMoneyEntryPreflight";
import {ENTRY_BUDGET_CHOICE_VERSION,entryBudgetTermsDigest,previewApprovedEntryBudget,type OfflineBudgetPreviewInput} from "./entryBudgetChoice";

export const QUALIFICATION_STAKE_LADDER_CENTS=Object.freeze([500,1500,2500,5000,10000,15000,20000,25000,50000] as const);
type ApprovalSnapshot=OfflineBudgetPreviewInput&Readonly<{selectionRevision?:number}>;
const usd=(v:number)=>Number.isSafeInteger(v)&&v>0;
const q=(v:number)=>usd(v)&&v<=999_999_999;
const m=(v:number)=>usd(v)&&v<1_000_000;
const ladder=(v:number)=>QUALIFICATION_STAKE_LADDER_CENTS.some(x=>x===v);
const pins=new WeakSet<object>();
type Pin=Readonly<{
  version:"STAKE_CHOICE_FINAL_FENCE_V1"; choiceId:string; choiceRevision:number; approvalDigest:string;
  accountId:string; ownerId:string; policyHash:string; releaseSha:string; stakeRevision:number;
  credentialFingerprint:string; feeApprovalId:string; feeApprovalDigest:string;
  configuredGrossCents:number; grossCents:number; allInCents:number; selectionRevision:number|null;
  plannedGrossCents:number; plannedAllInCents:number; contracts:number; limitMicros:number; originalQuoteAtMs:number;
}>;
type Plan=Readonly<{plannedGrossCents:number;plannedAllInCents:number;contracts:number;limitMicros:number}>;
function state(x:ApprovalSnapshot,now:number){
 const c=x.choice,s=x.currentScope,b=x.trustedBudgetApproval,f=x.trustedFeeApproval;
 const times=[now,b.approvedAtMs,b.expiresAtMs,f.verifiedAtMs,f.expiresAtMs];
 if(times.some(t=>!Number.isSafeInteger(t)||t<0)||b.approvedAtMs>now||b.expiresAtMs<=now||f.verifiedAtMs>now||f.expiresAtMs<=now||
 b.revokedAtMs!==null||f.revokedAtMs!==null||c.version!==ENTRY_BUDGET_CHOICE_VERSION||
 !ladder(c.grossCents)||!usd(c.allInCents)||c.allInCents<c.grossCents||
 c.grossCents>x.currentConfiguredGrossCents||x.currentConfiguredGrossCents>x.preflight.policy.maxEntryStakeCents||
 c.allInCents>x.preflight.policy.maxEntryAllInCents||c.allInCents>x.preflight.policy.capitalLimitCents||
 (x.selectionRevision!==undefined&&!usd(x.selectionRevision))||!usd(s.stakeRevision)||x.preflight.policy.policyHash!==s.policyHash||s.policyRevision!==x.preflight.policy.version||
 x.requestedChoice.choiceId!==c.choiceId||x.requestedChoice.choiceRevision!==c.choiceRevision||
 c.approvalDigest!==entryBudgetTermsDigest(c)||c.approvalDigest!==b.approvalDigest)return null;
 const keys=["ownerId","accountId","credentialFingerprint","releaseSha","policyHash","policyRevision","stakeRevision","feeApprovalId","feeApprovalDigest"] as const;
 if(keys.some(k=>c.scope[k]!==s[k]||b.scope[k]!==s[k]||f.scope[k]!==s[k]))return null;
 if(f.policyVersion!==x.preflight.policy.feePolicyVersion||f.sourceUrl!==x.preflight.policy.feeSourceUrl||
    f.formulaVersion!==x.preflight.policy.feeFormulaVersion)return null;
 return {choiceId:c.choiceId,choiceRevision:c.choiceRevision,approvalDigest:c.approvalDigest,
  accountId:s.accountId,ownerId:s.ownerId,policyHash:s.policyHash,releaseSha:s.releaseSha,
  stakeRevision:s.stakeRevision,credentialFingerprint:s.credentialFingerprint,feeApprovalId:s.feeApprovalId,
  feeApprovalDigest:s.feeApprovalDigest,configuredGrossCents:x.currentConfiguredGrossCents,
  grossCents:c.grossCents,allInCents:c.allInCents,selectionRevision:x.selectionRevision??null};
}
function planWithin(term:{grossCents:number;allInCents:number},p:Plan){
 if(!q(p.contracts)||!m(p.limitMicros)||!usd(p.plannedGrossCents)||!usd(p.plannedAllInCents)||
 p.plannedGrossCents>term.grossCents||p.plannedAllInCents>term.allInCents||
 p.plannedAllInCents<p.plannedGrossCents)return false;
 const total=BigInt(p.contracts)*BigInt(p.limitMicros);
 return BigInt(p.plannedGrossCents)===(total+9999n)/10000n;
}
/** Staging candidate only. Not a credential, order approval, or persistent format.
 * An eventual runtime must derive both snapshots from trusted readers and lock
 * the same account during PREPARE and FINAL. This module has no order transport.
 */
export function prepareBudgetChoiceFence(x:ApprovalSnapshot,p:Plan,now:number):Pin|null{
 const s=state(x,now);
 const v=previewApprovedEntryBudget(x);
 const stamp=x.preflight.nowMs-x.preflight.quoteAgeMs;
 if(!Number.isSafeInteger(stamp)||stamp<0||stamp>now||now-stamp>Math.min(5000,x.preflight.policy.maxQuoteAgeMs))return null;
 const planned=preflightV13LiveMoneyEntry({...x.preflight,configuredStakeCents:x.choice.grossCents,
    requireCashRisk:true,capitalRemainingCents:Math.min(x.preflight.capitalRemainingCents,x.choice.allInCents)});
 if(!planned.ok||Math.round(planned.plan.limitPrice*1_000_000)!==p.limitMicros)return null;
 if(!s||!v.ok||!planWithin(s,p)||v.requestedContracts!==p.contracts||
 v.modeledGrossCents!==p.plannedGrossCents||v.modeledAllInCents!==p.plannedAllInCents)return null;
 const pin=Object.freeze({version:"STAKE_CHOICE_FINAL_FENCE_V1" as const,...s,...p,originalQuoteAtMs:stamp});
 pins.add(pin);return pin;
}
/** One-shot no-order qualification boundary. Reader must be the same locked
 * transaction's trusted re-read; caller of this module does not gain order authority. */
export async function recheckBudgetChoiceFence(pin:Pin,readCurrent:()=>Promise<ApprovalSnapshot|null>,exactPlan:Plan,now:()=>number){
 if(!pins.has(pin))return false;
 pins.delete(pin);
 try{
  const x=await readCurrent();
  if(!x)return false;
  const at=now(),s=state(x,at);if(!s||!planWithin(s,exactPlan))return false;
  const age=at-pin.originalQuoteAtMs,feeAge=at-x.preflight.feeEvidence.verifiedAtMs;
  if(!Number.isSafeInteger(age)||age<0||age>Math.min(5000,x.preflight.policy.maxQuoteAgeMs)||
    !Number.isSafeInteger(feeAge)||feeAge<0||feeAge>x.preflight.policy.maxFeeEvidenceAgeMs||
    x.preflight.feeEvidence.cashRisk?.artifactDigest!==x.trustedFeeApproval.feeArtifactDigest)return false;
  return Object.entries(s).every(([k,v])=>pin[k as keyof Pin]===v)&&
    exactPlan.plannedGrossCents===pin.plannedGrossCents&&exactPlan.plannedAllInCents===pin.plannedAllInCents&&
    exactPlan.contracts===pin.contracts&&exactPlan.limitMicros===pin.limitMicros;
 }catch{return false;}
}
