/**
 * Normalize a real Kalshi Retry-After header, never a locally fabricated 429.
 * Dates and delta seconds are bounded to 24 hours, matching the issuer-lease
 * persistence contract. Unknown or invalid values fall back to the existing
 * 30-minute shared capture lease, never to an immediate retry.
 */
const MAX_PROVIDER_WAIT_MS=86_400_000;
export function providerRetryDeadline(header:string|null,now:number):string|null{
 if(!Number.isSafeInteger(now)||now<=0||header===null)return null;
 const raw=header.trim();
 if(raw.length===0||raw.length>96)return null;
 let target:number;
 if(/^\d{1,9}$/.test(raw)){
  const delay=Number(raw);
  if(!Number.isSafeInteger(delay)||delay<0)return null;
  target=now+Math.min(MAX_PROVIDER_WAIT_MS,delay*1000);
 }else if(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)){
  const parsed=Date.parse(raw);
  if(!Number.isFinite(parsed))return null;
  target=Math.min(now+MAX_PROVIDER_WAIT_MS,parsed);
 }else return null;
 if(!Number.isFinite(target)||target<now)return null;
 return new Date(target).toISOString();
}
