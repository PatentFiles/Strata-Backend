/**
 * Issue #165: dynamic, READ-ONLY Kalshi Predictions monetary fee observation.
 *
 * The constants below describe a trusted SOURCE, decimal precision and
 * parse grammar; NO taker or maker percentage is approved in source code.
 * Every observation fetches the official issuer document plus exact-market
 * series/event API evidence and binds the derived model to their digests.
 *
 * This module intentionally has NO grant, policy, SQL, ARM, START, or POST.
 * A changed model requires fresh owner consent and a separately reviewed
 * V3 monetary-admission implementation. Legacy pins remain fail closed.
 */
import {createHash} from "node:crypto";
import {readUnapprovedOfficialFeePublication,CANONICAL_FEE_SCHEDULE_URL} from "../microLiveFeeArtifact";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";

const PPM=1_000_000n;
const MICRO_DENOM=10_000_000_000_000_000n;
const CENTICENT_MICROS=100n;
const SHA=/^[a-f0-9]{64}$/;
const SERIES=/^KXBTC15M-[A-Za-z0-9-]+$/;
const DATE=/Last updated and effective:\s*([A-Za-z]+\s+\d{1,2},?\s+20\d{2})\b/gi;

export type DynamicFeeModel={
 issuer:string;
 publicationDigest:string;
 effectiveDate:string;
 takerRatePpm:number;
 makerRatePpm:number;
 defaultTakerMultiplierPpm:number;
 defaultMakerMultiplierPpm:number;
 marketTicker:string;
 eventTicker:string;
 metadataDigest:string;
 modelDigest:string;
 observedAt:string;
 // Explicitly NO executable authority.
 tradingAuthorized:false;
 requiresVersionedReview:true;
};
export type DynamicFeeResult=
 | {ok:true;reason:"dynamic_fee_observation_for_review_only";model:DynamicFeeModel;
    providerContentChanged:boolean;tradingAuthorized:false}
 | {ok:false;reason:string;tradingAuthorized:false};

const deny=(reason:string):DynamicFeeResult=>({ok:false,reason,tradingAuthorized:false});

/** Decimal-to-integer, no JS floating-point monetary conversions. */
function decimalPpm(raw:string):number|null{
 if(!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw))return null;
 const [whole,fraction=""]=raw.split(".");
 const result=BigInt(whole!)*PPM+BigInt((fraction+"000000").slice(0,6));
 return result<=PPM&&result>=0n?Number(result):null;
}
function formula(text:string):number|null{
 const match=/\bfees\s*=\s*round\s+up\s*\(\s*M\s*[x×*]\s*(\d+(?:\.\d{1,6})?)\s*[x×*]\s*C\s*[x×*]\s*P\s*[x×*]\s*\(\s*1\s*[-−]\s*P\s*\)\s*\)/i.exec(text);
 return match?decimalPpm(match[1]!):null;
}
export function parseDynamicKalshiPublication(text:string,nowMs:number):{
 ok:true;effectiveDate:string;takerRatePpm:number;makerRatePpm:number;
 defaultTakerMultiplierPpm:number;defaultMakerMultiplierPpm:number;
}|{ok:false;reason:string}{
 if(!Number.isSafeInteger(nowMs)||nowMs<=0||text.length<100||text.length>500_000)
   return {ok:false,reason:"dynamic_fee_document_or_clock_invalid"};
 const doc=text.replace(/\s+/g," ").trim();
 const trading=doc.indexOf("Trading Fees"),maker=doc.indexOf("Maker Fees");
 const nonstandard=doc.indexOf("Non-Standard Fees");
 const perps=doc.indexOf("Perpetual Futures Fees");
 if(trading!==0||maker<=trading||nonstandard<=maker||perps<=nonstandard)
   return {ok:false,reason:"dynamic_fee_document_structure_changed"};
 const takerSection=doc.slice(trading,maker);
 const makerSection=doc.slice(maker,Math.min(nonstandard,maker+1300));
 const taker=formula(takerSection),make=formula(makerSection);
 const takerDefault=/\bM\s*=\s*the multiplier for each contract\s*\(default is (\d+(?:\.\d{1,6})?) unless otherwise indicated\)/i.exec(takerSection);
 const makerDefault=/\bM\s*=\s*the multiplier for each contract\s*\(default is (\d+(?:\.\d{1,6})?) unless otherwise indicated\)/i.exec(makerSection);
 const takerMult=takerDefault?decimalPpm(takerDefault[1]!):null;
 const makerMult=makerDefault?decimalPpm(makerDefault[1]!):null;
 if(taker===null||make===null||takerMult===null||makerMult===null)
   return {ok:false,reason:"dynamic_fee_formula_unverifiable"};
 // Do not infer applicability from the default when the issuer explicitly
 // lists our series in its exception table. Requires a new exact-market
 // monetary proof rather than an optimistic default.
 if(/\bKXBTC15M\b/i.test(doc.slice(nonstandard,perps)))
   return {ok:false,reason:"dynamic_fee_series_exception_needs_review"};
 if(!/all event contract markets on the exchange, apart from specific products/i.test(takerSection)||
    !/fee\s*\+\s*positionCost is rounded to a centicent/i.test(takerSection))
   return {ok:false,reason:"dynamic_fee_scope_or_rounding_unknown"};
 const footers=[...doc.matchAll(DATE)].map(m=>Date.parse(m[1]!));
 if(footers.length<1||footers.some(n=>!Number.isFinite(n))||
    new Set(footers).size!==1||footers[0]!>nowMs)
   return {ok:false,reason:"dynamic_fee_effective_date_unverified"};
 return {ok:true,effectiveDate:new Date(footers[0]!).toISOString().slice(0,10),
   takerRatePpm:taker,makerRatePpm:make,
   defaultTakerMultiplierPpm:takerMult,defaultMakerMultiplierPpm:makerMult};
}

/** All quantities are integer hundredths and price ticks / 10,000.
 * The payable model is conservatively rounded up to 1 centicent ($0.0001)
 * per caller-specified fill; no netting of independently rounded fills.
 * For research and comparison only; NOT an exchange-authorized quote.
 */
export function estimateDynamicFeeMicros(
 ratePpm:number,multiplierPpm:number,
 contractsHundredths:number,priceTick:number,
):bigint|null{
 if(![ratePpm,multiplierPpm,contractsHundredths,priceTick].every(Number.isSafeInteger)||
    ratePpm<0||ratePpm>1_000_000||multiplierPpm<0||multiplierPpm>1_000_000||
    contractsHundredths<1||contractsHundredths>100_000_000||
    priceTick<=0||priceTick>=10_000)return null;
 const top=BigInt(ratePpm)*BigInt(multiplierPpm)*
   BigInt(contractsHundredths)*BigInt(priceTick)*BigInt(10_000-priceTick);
 const micros=(top+MICRO_DENOM-1n)/MICRO_DENOM;
 return (micros+CENTICENT_MICROS-1n)/CENTICENT_MICROS*CENTICENT_MICROS;
}

/**
 * An exact PDF/market fetch makes the fee RATE discoverable, not approved.
 * A changed digest never reuses an old human/owner fee authorization. All
 * failures including 429, redirect, stale provider data and fee exceptions
 * are returned as denials, with zero trading authority.
 */
export async function observeDynamicKalshiFees(
 marketTicker:string,reviewedDigest:string|null=null,
 fetchImpl:typeof fetch=globalThis.fetch,now:()=>number=Date.now,
):Promise<DynamicFeeResult>{
 if(!SERIES.test(marketTicker)||reviewedDigest!==null&&!SHA.test(reviewedDigest))
   return deny("dynamic_fee_market_or_review_digest_invalid");
 const started=now();
 if(!Number.isSafeInteger(started)||started<=0)return deny("dynamic_fee_clock_invalid");
 const published=await readUnapprovedOfficialFeePublication(fetchImpl);
 if(!published.ok)return deny(published.reason);
 const parsed=parseDynamicKalshiPublication(published.normalizedText,now());
 if(!parsed.ok)return deny(parsed.reason);
 const provider=await probeCurrentKalshiFeeApi(fetchImpl,now,marketTicker);
 if(!provider.ok||provider.marketTicker!==marketTicker||
    !provider.eventTicker||!provider.metadataDigest||
    !SHA.test(provider.metadataDigest))
   return deny(provider.ok?"dynamic_fee_provider_identity_incomplete":provider.reason);
 const age=now()-started;
 if(age<0||age>15_000)return deny("dynamic_fee_observation_expired");
 // The API probe currently rejects unreviewed non-standard multipliers,
 // overrides, fee-type changes and effective changes automatically.
 const modelBase={issuer:CANONICAL_FEE_SCHEDULE_URL,
   publicationDigest:published.digest,effectiveDate:parsed.effectiveDate,
   takerRatePpm:parsed.takerRatePpm,makerRatePpm:parsed.makerRatePpm,
   defaultTakerMultiplierPpm:parsed.defaultTakerMultiplierPpm,
   defaultMakerMultiplierPpm:parsed.defaultMakerMultiplierPpm,
   marketTicker,eventTicker:provider.eventTicker,metadataDigest:provider.metadataDigest};
 // Model identity must remain stable across repeat reads of unchanged
 // issuer bytes and unchanged market fee terms. metadataDigest separately
 // identifies each time-stamped provider observation; never hash its clock
 // into the durable version candidate or every refresh would appear to drift.
 const {metadataDigest:_ephemeralObservation,...feeIdentity}=modelBase;
 const modelDigest=createHash("sha256").update(JSON.stringify({
   ...feeIdentity,feeType:provider.feeType,
   feeMultiplier:provider.feeMultiplier,
 })).digest("hex");
 return {ok:true,reason:"dynamic_fee_observation_for_review_only",
   model:{...modelBase,modelDigest,observedAt:new Date(now()).toISOString(),
     tradingAuthorized:false,requiresVersionedReview:true},
   providerContentChanged:reviewedDigest!==null&&reviewedDigest!==published.digest,
   tradingAuthorized:false};
}
