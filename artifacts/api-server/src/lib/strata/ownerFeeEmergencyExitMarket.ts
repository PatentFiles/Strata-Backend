import {verifyOwnedFeeMetadata} from "./ownedMarketFeeMetadata";
import {PERSONAL_MARKET_METADATA_HOST} from "./personalExchangeRead";
/**
 * Exact-market Kalshi fee verification for READ-ONLY emergency-exit assessment.
 * This cannot approve a PDF, a fee-source grant, an execution policy or an order.
 * No trade is ever sent. Every request is GET, fixed-host and fail-closed.
 */
export type EmergencyExactFee =
  | {ok:true;marketTicker:string;fingerprint:string;observedAtMs:number;marketOpen:true}
  | {ok:false;reason:string};
const fail=(reason:string):EmergencyExactFee=>({ok:false,reason});
const TICKER=/^KXBTC15M-[A-Za-z0-9-]+$/;
const MAX_BYTES=256000;
async function json(path:string,transport:typeof fetch):Promise<Record<string,unknown>>{
  const url=PERSONAL_MARKET_METADATA_HOST+path;
  const response=await transport(url,{method:"GET",redirect:"error",cache:"no-store",
    headers:{Accept:"application/json"},signal:AbortSignal.timeout(8000)});
  if(response.status!==200||(response.url&&response.url!==url)||
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")
    throw Error("emergency_exact_market_api_unavailable");
  const len=Number(response.headers.get("content-length")??"0");
  if(!Number.isSafeInteger(len)||len>MAX_BYTES)throw Error("emergency_exact_market_response_invalid");
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<2||bytes.length>MAX_BYTES)
    throw Error("emergency_exact_market_response_invalid");
  const value=JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw Error("emergency_exact_market_response_invalid");
  return value as Record<string,unknown>;
}
export async function readExactEmergencyFeeEvidence(
  ticker:string,clock:()=>number=Date.now,transport:typeof fetch=fetch,
):Promise<EmergencyExactFee>{
  if(!TICKER.test(ticker))return fail("emergency_exact_market_invalid");
  const begun=clock();
  if(!Number.isSafeInteger(begun)||begun<=0)return fail("emergency_exact_market_clock_invalid");
  try {
    const marketPayload=await json("/markets/"+encodeURIComponent(ticker),transport);
    const market=marketPayload.market as Record<string,unknown>|null;
    if(!market||typeof market!=="object"||Array.isArray(market)||
       market.ticker!==ticker||!["open","active"].includes(String(market.status??""))||
       (market.exchange_index!==undefined&&market.exchange_index!==2))
      return fail("emergency_exact_market_closed_or_mismatched");
    const eventTicker=market.event_ticker;
    if(typeof eventTicker!=="string"||!TICKER.test(eventTicker))
      return fail("emergency_exact_market_event_invalid");
    const [seriesPayload,eventPayload,seriesChangesPayload,eventChangesPayload]=await Promise.all([
      json("/series/KXBTC15M",transport),
      json("/events/"+encodeURIComponent(eventTicker),transport),
      json("/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100",transport),
      json("/events/fee_changes?event_ticker="+encodeURIComponent(eventTicker)+
          "&show_historical=false&limit=100",transport),
    ]);
    const finished=clock();
    if(!Number.isSafeInteger(finished)||finished<begun||finished-begun>3000)
      return fail("emergency_exact_market_evidence_stale");
    const proof=verifyOwnedFeeMetadata({
      marketTicker:ticker,marketPayload,seriesPayload,eventPayload,
      seriesChangesPayload,eventChangesPayload,observedAtMs:begun,nowMs:finished,
    });
    if(!proof.ok)return fail(proof.reason);
    return {ok:true,marketTicker:ticker,fingerprint:proof.fingerprint,
      observedAtMs:proof.verifiedAtMs,marketOpen:true};
  }catch{return fail("emergency_exact_market_api_unavailable");}
}
