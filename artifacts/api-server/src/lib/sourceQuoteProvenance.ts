import type {PublicFeedReadEvidence} from "./publicFeedJson";
import {deployedGitSha} from "./strata/deployedGitSha";
const stored=new WeakMap<object,SourceQuoteProvenance>();
const finite=(x:unknown,max=86_400_000)=>typeof x==="number"&&Number.isFinite(x)&&x>=0&&x<=max?x:null;
const stamp=(x:unknown)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0?x:null;
const parsedDate=(x:unknown)=>typeof x==="string"&&x.length<=128?stamp(Date.parse(x)):null;
const safeNow=(read:()=>number)=>{try{return read();}catch{return NaN;}};
export type SourceQuoteProvenance=Readonly<{
 version:1;source:"kalshi_public_exact_market_detail";
 requestStartedAtMs:number|null;responseHeadersAtMs:number|null;parsedDetailReceivedAtMs:number|null;
 headersElapsedMs:number|null;requestToParsedDetailMs:number|null;
 httpStatus:number|null;httpDateAtMs:number|null;httpResponseAgeSeconds:number|null;
 cacheMaxAgeSeconds:number|null;cacheNoStoreObserved:boolean;
 quoteOriginAtMs:null;quoteOriginAgeAtReceiptMs:null;
 yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null;
}>;
/** Existing GET only. HTTP Date/Age describe the HTTP response, NOT quote time.
 * Do not restamp observations, change freshness or infer quote origin from cache
 * policy. Every missing/invalid/throwing diagnostic clock stays unknown. */
export function beginSourceQuoteRead(wall:()=>number=Date.now,mono:()=>number=()=>performance.now()){
 const started=stamp(safeNow(wall)),monotonicStart=safeNow(mono);
 return (market:object,receivedAtMs:number,transport:PublicFeedReadEvidence|null)=>{
  try{
   const m=market as Record<string,unknown>;
   const elapsed=safeNow(mono)-monotonicStart;
   const value:SourceQuoteProvenance=Object.freeze({version:1,source:"kalshi_public_exact_market_detail",
    requestStartedAtMs:started,responseHeadersAtMs:parsedDate(transport?.receivedAt),parsedDetailReceivedAtMs:stamp(receivedAtMs),
    headersElapsedMs:finite(transport?.roundTripMs),requestToParsedDetailMs:finite(elapsed),
    httpStatus:Number.isInteger(transport?.status)&&transport!.status!>=100&&transport!.status!<=599?transport!.status!:null,
    httpDateAtMs:parsedDate(transport?.responseDate),httpResponseAgeSeconds:finite(transport?.ageSeconds,Number.MAX_SAFE_INTEGER),
    cacheMaxAgeSeconds:finite(transport?.cacheMaxAgeSeconds,Number.MAX_SAFE_INTEGER),cacheNoStoreObserved:transport?.cacheNoStore===true,
    quoteOriginAtMs:null,quoteOriginAgeAtReceiptMs:null,
    yesBid:finite(m.yesBid,1),yesAsk:finite(m.yesAsk,1),noBid:finite(m.noBid,1),noAsk:finite(m.noAsk,1)});
   stored.set(market,value);
  }catch{/* Telemetry cannot change parsing, return values or authority. */}
 };
}
export function getSourceQuoteProvenance(market:unknown):SourceQuoteProvenance|undefined{
 return market!==null&&typeof market==="object"?stored.get(market):undefined;
}
/** Called AFTER successful producer transaction return, with the committed row
 * ID. This timestamp is a client observation, never a database COMMIT timestamp.
 * Emit only canonical SCOUT/CONFIRM; no extra GET or database storage. */
export function emitCommittedSourceQuote(market:unknown,input:{evaluationId:string;engineId:string;signal:string;
 marketTicker:string;evaluatedAtMs:number;commitReturnObservedAtMs:number;qualifyingTrigger:boolean},report:(event:Readonly<Record<string,unknown>>)=>unknown){
 try{
  if(input.qualifyingTrigger!==true||input.engineId!=="v1.3-paper"||!["SCOUT","CONFIRM"].includes(input.signal)||
   !/^[a-f0-9-]{36}$/i.test(input.evaluationId)||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(input.marketTicker))return;
  const provenance=getSourceQuoteProvenance(market);
  const event=Object.freeze({event:"strata_source_quote_provenance",evaluationId:input.evaluationId,
   engineId:input.engineId,signal:input.signal,marketTicker:input.marketTicker,
   evaluatedAtMs:stamp(input.evaluatedAtMs),commitReturnObservedAtMs:stamp(input.commitReturnObservedAtMs),
   releaseCommitSha:deployedGitSha(),processId:process.pid,
   provenance:provenance??null,provenanceAvailable:Boolean(provenance)});
  queueMicrotask(()=>{try{const pending=report(event);if(pending)void Promise.resolve(pending).catch(()=>{});}catch{}});
 }catch{/* Logging is never part of committing/waking/admitting an order. */}
}
