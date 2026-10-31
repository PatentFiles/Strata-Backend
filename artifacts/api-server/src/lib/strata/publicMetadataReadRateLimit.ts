import {createReadOnlyRateLimit,emitReadRateLimitDiagnostic} from "../readOnlyRateLimit";
const origin="https://external-api.kalshi.com";
function endpoint(path:string):string {
 if(/^\/markets\?series_ticker=KXBTC15M&status=open&limit=100(?:&cursor=[^&]*)?$/.test(path))return "/trade-api/v2/markets";
 if(/^\/markets\/KXBTC15M-[A-Za-z0-9-]+$/.test(path))return "/trade-api/v2/markets/:ticker";
 if(path==="/series/KXBTC15M")return "/trade-api/v2/series/KXBTC15M";
 if(path==="/series/fee_changes?series_ticker=KXBTC15M&show_historical=false")return "/trade-api/v2/series/fee_changes";
 if(/^\/events\/KXBTC15M-[A-Za-z0-9-]+$/.test(path))return "/trade-api/v2/events/:ticker";
 if(/^\/events\/fee_changes\?event_ticker=KXBTC15M-[A-Za-z0-9-]+&limit=100$/.test(path))return "/trade-api/v2/events/fee_changes";
 throw Error("public_metadata_rate_limit_scope_invalid");
}
export function createPublicMetadataReadLimiter(wallNow=Date.now,monotonicNow=()=>performance.now()){
 const limiter=createReadOnlyRateLimit(wallNow,monotonicNow);
 return (path:string)=>{
  const label=endpoint(path),attempt=limiter.begin(origin+label,label);
  if(attempt.blocked){emitReadRateLimitDiagnostic(attempt.blocked);throw Error("public_metadata_read_cooldown");}
  return {
   response(response:Response){if(response.status===429)emitReadRateLimitDiagnostic(attempt.limited(response.headers.get("retry-after")));},
   success:attempt.success,
  };
 };
}
// Only backoff state is shared across fresh snapshots. No account credentials,
// observations, producer/private budget or order path is retained here.
const limiters=new WeakMap<typeof fetch,ReturnType<typeof createPublicMetadataReadLimiter>>();
export function beginPublicMetadataRead(fetchImpl:typeof fetch,path:string){
 let limiter=limiters.get(fetchImpl);
 if(!limiter){limiter=createPublicMetadataReadLimiter();limiters.set(fetchImpl,limiter);}
 return limiter(path);
}
