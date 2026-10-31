import {getMarketEvidenceReadTiming} from "../strata/marketEvidenceReadTiming";
import {V13_CHAMPION_PARAMETER_SET} from "@workspace/v13-strategy";
import {signalCap} from "../v13ExecutionPlanner";

const captured = new WeakSet<object>();
export const isEntryPriceDiagnostics = (v:unknown):v is EntryPriceDiagnostics =>
  typeof v === "object" && v !== null && captured.has(v);
const number = (v:unknown):number|null => typeof v === "number" && Number.isFinite(v) ? v : null;
const price = (v:unknown):number|null => {
  const n=typeof v === "string" && /^0\.\d{1,4}$/.test(v) ? Number(v) : number(v);
  return n!==null && n>0 && n<1 ? n : null;
};
const quantity = (v:unknown):number|null => {
  const n=typeof v === "string" && /^\d{1,12}(?:\.\d{1,4})?$/.test(v) ? Number(v) : number(v);
  return n!==null && n>=0 && n<=1e12 ? n : null;
};
const milliseconds = (v:unknown):number|null => {
  const n=number(v);return n!==null && Number.isSafeInteger(n) && n>=0 ? n : null;
};

/** Whitelist only. Never retain raw provider bodies, credentials, or fee artifacts.
 * Three normalized levels at most; sampled availability is NOT full depth proof.
 * Existing observedAtMs is sampled before owned market reads, not provider time
 * or response receipt. Unknown transport timestamps/RTT remain explicitly null.
 */
export function captureEntryPriceDiagnostics(source:unknown,book:unknown) {
  try {
    if(!source || typeof source!=="object" || !book || typeof book!=="object")return undefined;
    const s=source as Record<string,unknown>, b=book as Record<string,unknown>;
    const signal=s.signal==="SCOUT"||s.signal==="CONFIRM"?s.signal:null;
    const side=s.direction==="DOWN"?"NO":s.direction==="UP"?"YES":null;
    const referenceOffer=price(s.entry_offer);
    const championCap=signal===null?null:signal==="SCOUT"
      ?V13_CHAMPION_PARAMETER_SET.parameters.scoutMaxOffer
      :V13_CHAMPION_PARAMETER_SET.parameters.confirmMaxOffer;
    const plannerCap=signal===null?null:signalCap(signal);
    const effectiveCeiling=referenceOffer!==null && plannerCap!==null ? Math.min(referenceOffer,plannerCap):null;
    const levels=Array.isArray(b.asks)?b.asks:[];
    const sampledAskLevels=[];
    for(let i=0;i<Math.min(levels.length,3);i++){
      const l=levels[i];
      sampledAskLevels.push(Object.freeze({priceDollars:price(l?.priceDollars),availableContracts:quantity(l?.availableContracts)}));
    }
    const sampleValid=sampledAskLevels.every(l=>l.priceDollars!==null && l.availableContracts!==null);
    const sampledContractsAtOrBelowCeiling=sampleValid && effectiveCeiling!==null
      ?sampledAskLevels.reduce((n,l)=>n+(l.priceDollars!<=effectiveCeiling+1e-12?l.availableContracts!:0),0):null;
    const evaluatedAtMs=s.evaluated_at instanceof Date ? s.evaluated_at.getTime()
      :typeof s.evaluated_at==="string" && /^\d{4}-\d\d-\d\dT/.test(s.evaluated_at)?Date.parse(s.evaluated_at):null;
    const diagnostic=Object.freeze({version:1 as const,signal,side,referenceOffer,championCap,plannerCap,effectiveCeiling,
      bestAskDollars:price(b.bestAskDollars),bestBidDollars:price(b.bestBidDollars),
      sampledAskLevels:Object.freeze(sampledAskLevels),sampledContractsAtOrBelowCeiling,
      depthTruncated:levels.length>3,sourceEvaluatedAtMs:milliseconds(evaluatedAtMs),
      sourceBtcProviderAgeMs:milliseconds(s.btc_provider_age_ms),sourceBtcReceiveAgeMs:milliseconds(s.btc_receive_age_ms),
      sourceMarketAgeMs:milliseconds(s.market_age_ms),bookObservationStartAtMs:milliseconds(b.observedAtMs),
      bookReceiptAtMs:null,bookProviderTimestampMs:null,bookProviderRttMs:null,
      feeVerificationDurationMs:null,evidenceReads:getMarketEvidenceReadTiming(book)});
    captured.add(diagnostic);
    return diagnostic;
  } catch {return undefined; /* Diagnostics must not alter execution, even on hostile getters. */}
}
export type EntryPriceDiagnostics = NonNullable<ReturnType<typeof captureEntryPriceDiagnostics>>;
