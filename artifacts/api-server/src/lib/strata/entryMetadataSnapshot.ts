import {annotateFeeFailure} from "./feeFailureDiagnostics";
import {beginPublicMetadataRead} from "./publicMetadataReadRateLimit";
import {KALSHI_API_ORIGIN} from "./twoSourceFeeEvidence";

type JsonObject=Record<string,unknown>;
const plain=(x:unknown):x is JsonObject=>!!x&&typeof x==="object"&&!Array.isArray(x);
const tickerPattern=/^KXBTC15M-[A-Za-z0-9-]+$/;
const MAX_BYTES=256_000;
function freezeJson(value:unknown):void {
 // JSON is acyclic. Iterative traversal avoids deep-input stack overflow.
 const pending:unknown[]=[value];
 while(pending.length){const item=pending.pop();if(item&&typeof item==="object"){
  for(const child of Object.values(item))if(child&&typeof child==="object")pending.push(child);
  Object.freeze(item);
 }}
}
/** Exactly one readMarket invocation owns this five-key snapshot map.
 * No listing, signed request, response object or cross-attempt cache is shared.
 * Both callers still run their own semantic validators on the same immutable
 * public bytes. This is not an atomic provider snapshot or a freshness renewal.
 */
export function createEntryMetadataSnapshot(market:string,fetchImpl:typeof fetch=globalThis.fetch,
 options:{timeoutMs?:number}={}) {
 if(!tickerPattern.test(market))throw Error("entry_metadata_scope_invalid");
 const timeoutMs=options.timeoutMs??8_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>8_000)throw Error("entry_metadata_timeout_invalid");
 const marketPath=`/markets/${encodeURIComponent(market)}`;
 const fixed=new Set([marketPath,"/series/KXBTC15M","/series/fee_changes?series_ticker=KXBTC15M&show_historical=false"]);
 const snapshots=new Map<string,Promise<JsonObject>>();
 let failed=false,firstError:unknown;
 async function load(path:string):Promise<JsonObject>{
  const attempt=beginPublicMetadataRead(fetchImpl,path);
  const started=performance.now();
  const controller=new AbortController();
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let httpStatus:number|undefined;
  let failureReason="provider_request_failed";
  let timer:ReturnType<typeof setTimeout>|undefined;
  const unavailable=()=>Error("production_market_metadata_unavailable");
  const cancel=()=>{controller.abort();try{void reader?.cancel().catch(()=>{});}catch{}};
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancel();reject(unavailable());},timeoutMs);});
  try {
   return await Promise.race([deadline,(async()=>{
    const url=KALSHI_API_ORIGIN+path;
    const response=await fetchImpl(url,{method:"GET",redirect:"error",cache:"no-store",credentials:"omit",
     headers:{Accept:"application/json"},signal:controller.signal});
    httpStatus=response.status;
    failureReason=response.status!==200?"provider_http_rejected":"provider_response_invalid";
    attempt.response(response);
    if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw unavailable();}
    const length=Number(response.headers.get("content-length")??"0");
    if(response.status!==200||(response.url&&response.url!==url)||
       response.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json"||
       !Number.isSafeInteger(length)||length<0||length>MAX_BYTES||!response.body){
     void response.body?.cancel().catch(()=>{});throw unavailable();
    }
    reader=response.body.getReader();
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const next=await reader.read();if(next.done)break;
     size+=next.value.byteLength;if(size>MAX_BYTES)throw unavailable();chunks.push(next.value);
    }
    if(controller.signal.aborted||size<2)throw unavailable();
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const parsed:unknown=JSON.parse(new TextDecoder().decode(bytes));
    if(!plain(parsed))throw unavailable();freezeJson(parsed);
    if(controller.signal.aborted||performance.now()-started>timeoutMs)throw unavailable();
    attempt.success();
    return parsed;
   })()]);
  }catch(error){const timedOut=controller.signal.aborted;cancel();throw annotateFeeFailure(unavailable(),
    {phase:"provider_transport",reason:timedOut?"provider_read_timeout":failureReason,path,httpStatus},error);}
  finally{if(timer)clearTimeout(timer);try{reader?.releaseLock();}catch{}}
 }
 function memo(path:string):Promise<JsonObject>{
  if(failed)return Promise.reject(firstError);
  const previous=snapshots.get(path);if(previous)return previous;
  if(snapshots.size>=5)return Promise.reject(Error("entry_metadata_scope_invalid"));
  const promise=load(path).catch(error=>{if(!failed){failed=true;firstError=error;}throw error;});
  snapshots.set(path,promise);return promise;
 }
 async function read(path:string):Promise<JsonObject>{
  if(fixed.has(path))return memo(path);
  // No arbitrary route gets sent to the provider, even before identity resolves.
  if(!/^\/events\/(?:KXBTC15M-[A-Za-z0-9-]+|fee_changes\?event_ticker=KXBTC15M-[A-Za-z0-9-]+&limit=100)$/.test(path))
   throw Error("entry_metadata_scope_invalid");
  const payload=await memo(marketPath),row=payload.market;
  if(!plain(row)||row.ticker!==market||row.exchange_index!==2||typeof row.event_ticker!=="string"||!tickerPattern.test(row.event_ticker))
   throw Error("entry_metadata_scope_invalid");
  const event=encodeURIComponent(row.event_ticker);
  if(path!==`/events/${event}`&&path!==`/events/fee_changes?event_ticker=${event}&limit=100`)
   throw Error("entry_metadata_scope_invalid");
  return memo(path);
 }
 return Object.freeze({read});
}
