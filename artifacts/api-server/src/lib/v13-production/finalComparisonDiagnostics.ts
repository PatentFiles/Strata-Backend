import {validEntryCashRisk,samePinnedCashModel} from '../v13EntryCashRisk';
import type {MarketEvidence} from './types';
const branded=new WeakSet<object>();
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER?v:null;
const price=(v:unknown)=>{const n=typeof v==='string'&&/^0\.[0-9]{4}$/.test(v)?Number(v):v;return typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1?n:null;};
export type FinalComparisonDiagnostics=Readonly<{
 semantics:'post_failure_diagnostic_sample_not_guard_clock';sampledAtMs:number|null;
 cashEntry:boolean;flags:Readonly<Record<string,boolean|null>>;categories:readonly string[];
 pinnedLimitMicros:number|null;requestContracts:number|null;sourceReferenceOffer:number|null;
 storedFeeLimit:number|null;freshFeeLimit:number|null;freshBestAsk:number|null;freshBestBid:number|null;
 storedFeeContracts:number|null;freshFeeContracts:number|null;
 bookObservedAtMs:number|null;feeVerifiedAtMs:number|null;bookAgeAtSampleMs:number|null;feeAgeAtSampleMs:number|null;
 maxQuoteAgeMs:number|null;maxFeeEvidenceAgeMs:number|null;sourceEvaluatedAtMs:number|null;
 originalBtcProviderAgeMs:number|null;originalBtcReceiveAgeMs:number|null;originalMarketAgeMs:number|null;
}>;
/** Fixed scalar allowlist, no payloads/identities/digests/URLs. Never authority.
 * Captured ONLY after the unchanged gate has rejected; sample ages do not
 * identify which short-circuited guard clock was read or prove its exact age.
 */
export function captureFinalComparison(input:{cashEntry:boolean;stored:MarketEvidence;fresh:MarketEvidence;
 pinnedFingerprint:string;requestContracts:unknown;pinnedLimitMicros:unknown;source:unknown;
 maxQuoteAgeMs:number;maxFeeEvidenceAgeMs:number;sampledAtMs:number}):FinalComparisonDiagnostics|undefined{
 try{
  const a=input.stored.fee,b=input.fresh.fee,validA=validEntryCashRisk(a),validB=validEntryCashRisk(b);
  const both=validA&&validB, x=a.cashRisk,y=b.cashRisk;
  const flags={storedCashValid:validA,freshCashValid:validB,
   samePinnedCashModel:input.cashEntry?samePinnedCashModel(a,b):null,
   feeFingerprintEqual:b.fingerprint===input.pinnedFingerprint,
   policyVersionEqual:a.policyVersion===b.policyVersion,sourceUrlEqual:a.sourceUrl===b.sourceUrl,formulaVersionEqual:a.formulaVersion===b.formulaVersion,
   modelEqual:both?x!.modelFingerprint===y!.modelFingerprint:null,
   policyHashEqual:both?x!.policyHash===y!.policyHash:null,artifactDigestEqual:both?x!.artifactDigest===y!.artifactDigest:null,
   feeMetadataDigestEqual:both?x!.feeMetadataDigest===y!.feeMetadataDigest:null,seriesDigestEqual:both?x!.seriesDigest===y!.seriesDigest:null,
   marketEqual:both?x!.marketTicker===y!.marketTicker:null,sideEqual:both?x!.side===y!.side:null,
   gridEqual:both?x!.gridDigest===y!.gridDigest:null,
   cashBoundEqual:both?x!.entryCashDebitPerContractMicros===y!.entryCashDebitPerContractMicros:null,
   exitBoundEqual:both?x!.exitLossPerContractMicros===y!.exitLossPerContractMicros:null,
   feeLimitNotHigher:b.limitPrice<=a.limitPrice+1e-12,
   tradeBoundNotHigher:both?y!.entryTradeFeePerContractMicros<=x!.entryTradeFeePerContractMicros:null,
   samePriceTradeBoundEqual:both?(b.limitPrice!==a.limitPrice||y!.entryTradeFeePerContractMicros===x!.entryTradeFeePerContractMicros):null};
  const sampled=finite(input.sampledAtMs),observed=finite(input.fresh.observedAtMs),verified=finite(b.verifiedAtMs);
  const bookAge=sampled!==null&&observed!==null?finite(sampled-observed):null;
  const feeAge=sampled!==null&&verified!==null?finite(sampled-verified):null;
  const categories:string[]=[];
  if(input.cashEntry){
   if(!validA||!validB)categories.push('cash_evidence_invalid');
   if(both){
    if(!flags.policyVersionEqual||!flags.sourceUrlEqual||!flags.formulaVersionEqual||!flags.modelEqual||!flags.marketEqual||!flags.sideEqual||!flags.gridEqual)categories.push('semantic_model_or_scope_changed');
    if(!flags.feeLimitNotHigher)categories.push('fresh_fee_limit_above_pinned');
    if(!flags.cashBoundEqual||!flags.exitBoundEqual||!flags.tradeBoundNotHigher||!flags.samePriceTradeBoundEqual)categories.push('cash_or_fee_bound_changed');
   }
  }else categories.push('legacy_fee_comparison_rejected_or_clock');
  if(bookAge===null||bookAge<0||bookAge>input.maxQuoteAgeMs)categories.push('quote_age_outside_limit_at_sample');
  if(feeAge===null||feeAge<0||feeAge>input.maxFeeEvidenceAgeMs)categories.push('fee_age_outside_limit_at_sample');
  if(!categories.length)categories.push('guard_clock_or_unclassified_mismatch');
  const s=(input.source&&typeof input.source==='object'?input.source:{}) as Record<string,unknown>;
  const evaluated=s.evaluated_at instanceof Date?s.evaluated_at.getTime():typeof s.evaluated_at==='string'?Date.parse(s.evaluated_at):null;
  const out=Object.freeze({semantics:'post_failure_diagnostic_sample_not_guard_clock' as const,sampledAtMs:sampled,
   cashEntry:input.cashEntry,flags:Object.freeze(flags),categories:Object.freeze(categories),
   pinnedLimitMicros:finite(input.pinnedLimitMicros),requestContracts:finite(input.requestContracts),sourceReferenceOffer:price(s.entry_offer),
   storedFeeLimit:price(a.limitPrice),freshFeeLimit:price(b.limitPrice),freshBestAsk:price(input.fresh.bestAskDollars),freshBestBid:price(input.fresh.bestBidDollars),
   storedFeeContracts:finite(a.contracts),freshFeeContracts:finite(b.contracts),bookObservedAtMs:observed,feeVerifiedAtMs:verified,
   bookAgeAtSampleMs:bookAge,feeAgeAtSampleMs:feeAge,maxQuoteAgeMs:finite(input.maxQuoteAgeMs),maxFeeEvidenceAgeMs:finite(input.maxFeeEvidenceAgeMs),
   sourceEvaluatedAtMs:finite(evaluated),originalBtcProviderAgeMs:finite(s.btc_provider_age_ms),originalBtcReceiveAgeMs:finite(s.btc_receive_age_ms),originalMarketAgeMs:finite(s.market_age_ms)});
  branded.add(out);return out;
 }catch{return undefined;}
}
export function isFinalComparisonDiagnostics(value:unknown):value is FinalComparisonDiagnostics{
 return !!value&&typeof value==='object'&&branded.has(value);
}
