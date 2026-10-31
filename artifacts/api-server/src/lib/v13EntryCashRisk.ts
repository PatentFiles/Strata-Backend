import {digest} from "./v13-production/types";
import {planV13IocEntry,type V13IocEntryPlan,type V13DepthLevel,type V13ExecutionSignal,type V13ExecutionDirection} from './v13ExecutionPlanner';
import type {V13VerifiedFeeEvidence} from './v13LiveMoneyEntryPreflight';
export const ENTRY_CASH_RISK_VERSION='NON_DIRECT_CENT_FRAGMENTS_V1' as const;
export type V13EntryCashRisk={version:typeof ENTRY_CASH_RISK_VERSION;marketTicker:string;side:'YES'|'NO';
 modelFingerprint:string;gridDigest:string;policyHash:string;artifactDigest:string;feeMetadataDigest:string;seriesDigest:string;entryCashDebitPerContractMicros:number;
 entryTradeFeePerContractMicros:number;exitLossPerContractMicros:number};
export type V13EntryCashProof={version:typeof ENTRY_CASH_RISK_VERSION;contracts:number;limitMicros:number;
 modelFingerprint:string;feeFingerprint:string;budgetCents:number;entryCashDebitMicros:string;
 entryTradeFeeMicros:string;exitLossMicros:string;reservedEntryCashCents:number;reservedExitFeeCents:number;plannedAllInCents:number};
export function cashRiskModelFingerprint(r:Omit<V13EntryCashRisk,'modelFingerprint'|'entryCashDebitPerContractMicros'|'entryTradeFeePerContractMicros'|'exitLossPerContractMicros'>):string {
 return digest({version:r.version,marketTicker:r.marketTicker,side:r.side,policyHash:r.policyHash,artifactDigest:r.artifactDigest,
  feeMetadataDigest:r.feeMetadataDigest,seriesDigest:r.seriesDigest,gridDigest:r.gridDigest});
}
export function cashRiskFeeFingerprint(fee:Pick<V13VerifiedFeeEvidence,'contracts'|'limitPrice'|'cashRisk'>):string {
 const r=fee.cashRisk!;return digest({modelFingerprint:r.modelFingerprint,contracts:fee.contracts,limitPrice:fee.limitPrice,
  entryCashDebitPerContractMicros:r.entryCashDebitPerContractMicros,entryTradeFeePerContractMicros:r.entryTradeFeePerContractMicros,exitLossPerContractMicros:r.exitLossPerContractMicros});
}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
/** Pure checks for the existing multiplier-one, non-direct cent-grid model.
 * These are not an approval or provider signature. Real market readers mint the
 * envelope only after the exact-market source/grid checks and existing helpers. */
export function validEntryCashRisk(fee:V13VerifiedFeeEvidence):fee is V13VerifiedFeeEvidence&{cashRisk:V13EntryCashRisk}{
 const r=fee.cashRisk;
 if(!r||r.version!==ENTRY_CASH_RISK_VERSION||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(r.marketTicker)||
  !['YES','NO'].includes(r.side)||![r.modelFingerprint,r.gridDigest,r.policyHash,r.artifactDigest,r.feeMetadataDigest,r.seriesDigest].every(hash)||
  r.modelFingerprint!==cashRiskModelFingerprint(r)||fee.fingerprint!==cashRiskFeeFingerprint(fee)||
  !Number.isSafeInteger(fee.reservedEntryFeeCents)||fee.reservedEntryFeeCents<0||!Number.isSafeInteger(fee.reservedExitFeeCents)||fee.reservedExitFeeCents<0||
  r.entryCashDebitPerContractMicros!==1_000_000||
  !Number.isSafeInteger(fee.contracts)||fee.contracts<1||fee.contracts>999_999_999||
  !Number.isFinite(fee.limitPrice)||fee.limitPrice<=0||fee.limitPrice>=1||
  Math.abs(fee.limitPrice*10000-Math.round(fee.limitPrice*10000))>1e-8||
  !Number.isSafeInteger(r.entryTradeFeePerContractMicros)||r.entryTradeFeePerContractMicros<100||r.entryTradeFeePerContractMicros>17500||r.entryTradeFeePerContractMicros%100!==0||
  !Number.isSafeInteger(r.exitLossPerContractMicros)||r.exitLossPerContractMicros<100||r.exitLossPerContractMicros>999900||r.exitLossPerContractMicros%100!==0)return false;
 return BigInt(fee.reservedEntryFeeCents)===ceil(BigInt(r.entryTradeFeePerContractMicros)*BigInt(fee.contracts),10000n)&&
  BigInt(fee.reservedExitFeeCents)===ceil(BigInt(r.exitLossPerContractMicros)*BigInt(fee.contracts),10000n);
}
export function entryCashProof(fee:V13VerifiedFeeEvidence,contracts:number,budgetCents:number):V13EntryCashProof|null{
 if(!Number.isSafeInteger(fee.reservedEntryFeeCents)||fee.reservedEntryFeeCents<0||
  !Number.isSafeInteger(fee.reservedExitFeeCents)||fee.reservedExitFeeCents<0||!validEntryCashRisk(fee)||
  !Number.isSafeInteger(contracts)||contracts<1||contracts>fee.contracts||
  !Number.isSafeInteger(budgetCents)||budgetCents<1)return null;
 const r=fee.cashRisk,n=BigInt(contracts),cash=BigInt(r.entryCashDebitPerContractMicros)*n,
  trade=BigInt(r.entryTradeFeePerContractMicros)*n,exit=BigInt(r.exitLossPerContractMicros)*n;
 const cashCents=Number(ceil(cash,10000n)),exitCents=Number(ceil(exit,10000n));
 if(!Number.isSafeInteger(cashCents+exitCents))return null;
 return {version:ENTRY_CASH_RISK_VERSION,contracts,limitMicros:Math.round(fee.limitPrice*1_000_000),
  modelFingerprint:r.modelFingerprint,feeFingerprint:fee.fingerprint,budgetCents,
  entryCashDebitMicros:String(cash),entryTradeFeeMicros:String(trade),exitLossMicros:String(exit),
  reservedEntryCashCents:cashCents,reservedExitFeeCents:exitCents,plannedAllInCents:cashCents+exitCents};
}
export function planCashBoundEntry(input:{signal:V13ExecutionSignal;direction:V13ExecutionDirection;referenceOffer:number;
 maxStakeCents:number;bestAskDollars:string|null;askLevels:V13DepthLevel[];fee:V13VerifiedFeeEvidence;budgetCents:number}):
 {ok:true;plan:V13IocEntryPlan;cashRisk:V13EntryCashProof}|{ok:false;reason:string}{
 const {fee,budgetCents}=input;
 const unit=entryCashProof(fee,1,Math.max(1,budgetCents));
 if(!unit)return {ok:false,reason:'cash_risk_unproven'};
 if(fee.cashRisk!.side!==(input.direction==='UP'?'YES':'NO'))return {ok:false,reason:'cash_risk_side_mismatch'};
 if(!Number.isSafeInteger(budgetCents)||budgetCents<1)return {ok:false,reason:'no_whole_contract_affordable'};
 const per=BigInt(fee.cashRisk!.entryCashDebitPerContractMicros)+BigInt(fee.cashRisk!.exitLossPerContractMicros);
 let max=Number(BigInt(budgetCents)*10000n/per);max=Math.min(max,fee.contracts);
 while(max>0&&entryCashProof(fee,max,budgetCents)!.plannedAllInCents>budgetCents)max--;
 if(max<1)return {ok:false,reason:'no_whole_contract_affordable'};
 const plan=planV13IocEntry({...input,maxContracts:max});
 if(!plan.ok)return plan;
 if(Math.abs(plan.plan.limitPrice-fee.limitPrice)>1e-8)return {ok:false,reason:'fee_evidence_invalid_or_stale'};
 const proof=entryCashProof(fee,plan.plan.contracts,budgetCents)!;
 if(proof.plannedAllInCents>budgetCents)return {ok:false,reason:'cash_risk_unaffordable'};
 return {ok:true,plan:{...plan.plan,worstCaseEntryCashDebitCents:proof.reservedEntryCashCents},cashRisk:proof};
}

/** New-version final check: immutable model/grid identity, not reoptimization.
 * The ORIGINAL limit-price terms and reservation remain authoritative. */
export function samePinnedCashModel(pinned:V13VerifiedFeeEvidence,fresh:V13VerifiedFeeEvidence):boolean{
 if(!validEntryCashRisk(pinned)||!validEntryCashRisk(fresh))return false;
 const a=pinned.cashRisk,b=fresh.cashRisk;
 return pinned.policyVersion===fresh.policyVersion&&pinned.sourceUrl===fresh.sourceUrl&&pinned.formulaVersion===fresh.formulaVersion&&
  a.modelFingerprint===b.modelFingerprint&&a.marketTicker===b.marketTicker&&a.side===b.side&&a.gridDigest===b.gridDigest&&
  a.entryCashDebitPerContractMicros===b.entryCashDebitPerContractMicros&&a.exitLossPerContractMicros===b.exitLossPerContractMicros&&
  fresh.limitPrice<=pinned.limitPrice+1e-12&&b.entryTradeFeePerContractMicros<=a.entryTradeFeePerContractMicros&&
  (fresh.limitPrice!==pinned.limitPrice||b.entryTradeFeePerContractMicros===a.entryTradeFeePerContractMicros);
}
export function pinnedEntryDepthAvailable(bestAsk:string,levels:V13DepthLevel[],contracts:number,limitMicros:number):boolean{
 if(!Number.isSafeInteger(contracts)||contracts<1||!Number.isSafeInteger(limitMicros)||limitMicros<100||limitMicros>999900||limitMicros%100!==0||
  !Array.isArray(levels)||!levels.length||levels.length>1000)return false;
 const price=(v:string)=>/^0\.[0-9]{4}$/.test(v)?Number(v.slice(2))*100:null;
 const ask=price(bestAsk);if(ask===null||ask<=0||ask>limitMicros)return false;
 let available=0n,min=1_000_000;const seen=new Set<number>();
 for(const l of levels){
  const p=price(l.priceDollars),m=/^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/.exec(l.availableContracts);
  if(p===null||p<=0||p>=1_000_000||!m||seen.has(p))return false;seen.add(p);
  const q=BigInt(m[1]!)*100n+BigInt((m[2]??'').padEnd(2,'0')||'0');
  if(q<=0n)return false;min=Math.min(min,p);if(p<=limitMicros)available+=q;
 }
 return min===ask&&available>=BigInt(contracts)*100n;
}
/** Actual one-fill joint gross/fee upward cent alignment, without
 * rebate credit. The cumulative joint cash bound is a second independent check. */
export function entryFillFeeUpperMicros(fee:V13VerifiedFeeEvidence,quantityHundredths:bigint,priceMicros:number):bigint|null{
 if(!validEntryCashRisk(fee)||quantityHundredths<1n||quantityHundredths>BigInt(fee.contracts)*100n||
  !Number.isSafeInteger(priceMicros)||priceMicros<=0||priceMicros>Math.round(fee.limitPrice*1_000_000))return null;
 const p=BigInt(priceMicros);
 const exactTrade=ceil(7n*quantityHundredths*p*(1_000_000n-p),10_000_000_000n);
 const envelopeTrade=ceil(BigInt(fee.cashRisk.entryTradeFeePerContractMicros)*quantityHundredths,100n);
 if(exactTrade>envelopeTrade)return null;
 const grossNumerator=quantityHundredths*p;
 if(grossNumerator%100n!==0n)return null;
 const gross=grossNumerator/100n;
 // A cent lattice contains the centicent lattice; this never assumes member
 // class or credits a rebate. Aligned amounts get no invented extra cent.
 return ceil(gross+exactTrade,10000n)*10000n-gross;
}
