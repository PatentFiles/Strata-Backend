/**
 * Cheap, non-authoritative refusal before an expensive read-only market fetch.
 * The executor MUST perform its existing source, policy, fee and exchange
 * checks again inside the committed financial transaction and at HTTP send.
 * Never reinterpret a stale paper source as a fresh Kalshi market quote.
 */
export function earlySourceFreshnessRejection(input:{
 evaluatedAtMs:number;observedAtMs:number;maxQuoteAgeMs:number;
 btcProviderAgeMs:unknown;btcReceiveAgeMs:unknown;marketAgeMs:unknown;
}):"production_evaluation_stale"|"production_source_feed_stale_or_changed"|null {
 const {evaluatedAtMs,observedAtMs,maxQuoteAgeMs}=input;
 if(!Number.isFinite(observedAtMs)||!Number.isFinite(evaluatedAtMs)||
    !Number.isFinite(maxQuoteAgeMs)||maxQuoteAgeMs<=0)
  return "production_evaluation_stale";
 const sourceAge=observedAtMs-evaluatedAtMs;
 if(sourceAge<0||sourceAge>maxQuoteAgeMs)
  return "production_evaluation_stale";
 for(const v of [input.btcProviderAgeMs,input.btcReceiveAgeMs,input.marketAgeMs]){
  if(typeof v!=="number"||!Number.isFinite(v)||v<0||v+sourceAge>maxQuoteAgeMs)
   return "production_source_feed_stale_or_changed";
 }
 return null;
}
