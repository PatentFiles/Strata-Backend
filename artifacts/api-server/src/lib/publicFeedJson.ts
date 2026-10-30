/** Public GETs only. Cooldowns reject without returning cached observations;
 * neither source timestamps nor the live five-second freshness rule change. */
type Provider='coinbase'|'kalshi';
type Endpoint='btc_ticker'|'market_discovery'|'market_detail';
type Cooldown={until:number;failures:number};
const FALLBACK_MS=30_000,MAX_FALLBACK_MS=300_000;
/** Retry-After dates are converted once at receipt to a duration. Subsequent
 * wall-clock jumps cannot expire a provider's monotonic cooldown early. */
export function publicFeedRetryAfterMs(value:string|null,wallNow:number):number|null{
 if(value===null||value.length>128)return null;
 const s=value.trim();
 if(/^\d+$/.test(s)){
  const seconds=Number(s);
  return Math.min(Number.MAX_SAFE_INTEGER,seconds*1000);
 }
 // Reject numeric, exponential and timezone-less values, rather than letting
 // Date.parse reinterpret malformed seconds as a calendar date.
 if(!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(s)||!Number.isFinite(wallNow))return null;
 const at=Date.parse(s);
 return Number.isFinite(at)?Math.max(0,at-wallNow):null;
}
export function createPublicFeedJsonReader(fetchImpl:typeof fetch=fetch,
 wallNow:()=>number=Date.now,monotonicNow:()=>number=()=>performance.now()){
 const state=new Map<Provider,Cooldown>();
 let lastMono=0;
 const mono=()=>{
  const value=monotonicNow();
  if(!Number.isFinite(value)||value<0)throw Error('Public market feed monotonic_clock_invalid');
  // Fail closed if a supplied clock regresses; normal performance.now is monotonic.
  lastMono=Math.max(lastMono,value);return lastMono;
 };
 return async(provider:Provider,endpoint:Endpoint,url:string,signal?:AbortSignal):Promise<unknown>=>{
  const label=`Public market feed provider=${provider} endpoint=${endpoint}`;
  const before=mono(),held=state.get(provider);
  if(held&&before<held.until)
   throw Error(`${label} cooldown remainingMs=${Math.ceil(held.until-before)}`);
  let response:Response;
  try{response=await fetchImpl(url,{signal,cache:'no-store',redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});}
  catch{throw Error(`${label} request_failed${signal?.aborted?' aborted=true':''}`);}
  if(!response.ok){
   if(response.status===429){
    const received=mono(),current=state.get(provider),failures=Math.min(5,(current?.failures??0)+1);
    const retryAfter=publicFeedRetryAfterMs(response.headers.get('retry-after'),wallNow());
    const delay=retryAfter===null?Math.min(MAX_FALLBACK_MS,FALLBACK_MS*2**(failures-1)):Math.max(1000,retryAfter);
    state.set(provider,{until:Math.max(current?.until??0,Math.min(Number.MAX_SAFE_INTEGER,received+delay)),failures});
    throw Error(`${label} HTTP 429 retryAfterMs=${retryAfter===null?'unavailable':retryAfter} cooldownMs=${delay}`);
   }
   throw Error(`${label} HTTP ${response.status}`);
  }
  let result:unknown;
  try{result=await response.json();}catch{throw Error(`${label} invalid_json`);}
  // An older in-flight success cannot clear a newer concurrent 429 hold.
  if(state.get(provider)===held)state.delete(provider);
  return result;
 };
}
