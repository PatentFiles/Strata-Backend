/** Cold-path strike metadata only; never a quote or order authorization. */
import type {PublicFeedReadEvidence} from "./publicFeedJson";
const TICKER=/^KXBTC15M-[A-Z0-9-]{1,80}$/;
const row=(x:unknown):Record<string,unknown>|null=>
 x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:null;
const time=(x:unknown)=>typeof x==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(x)?Date.parse(x):NaN;
const active=(x:Record<string,unknown>)=>x.status==="active"||x.status==="open";
const floorContract=(x:Record<string,unknown>)=>
 x.strike_type==="greater_or_equal"&&x.cap_strike==null&&
 x.functional_strike==null&&x.custom_strike==null&&x.market_type==="binary";
export function rolloverEventScope(detail:Record<string,unknown>,ticker:string,window:number){
 const event=detail.event_ticker;
 return TICKER.test(ticker)&&detail.ticker===ticker&&detail.exchange_index===2&&
  typeof event==="string"&&TICKER.test(event)&&floorContract(detail)&&active(detail)&&
  time(detail.open_time)===window&&time(detail.close_time)===window+900_000&&
  ["floor_strike","floorStrike","strike","target","threshold"].every(k=>detail[k]==null)
  ? event : null;
}
export function verifiedRolloverEventStrike(input:{
 payload:unknown;detail:Record<string,unknown>;ticker:string;window:number;
 requestedAt:number;receivedAt:number;transport:PublicFeedReadEvidence|null;
}):number|null {
 const {payload,detail,ticker,window,requestedAt,receivedAt,transport}=input;
 const expected=rolloverEventScope(detail,ticker,window),event=row(row(payload)?.event);
 const servedAt=transport?.responseDate==null?NaN:Date.parse(transport.responseDate);
 // No quote clock update; this independently rejects old or regressed metadata.
 if(!expected||!event||event.event_ticker!==expected||event.series_ticker!=="KXBTC15M"||
  (event.exchange_index!==undefined&&event.exchange_index!==2)||
  !Number.isSafeInteger(requestedAt)||!Number.isSafeInteger(receivedAt)||
  requestedAt<window||receivedAt<requestedAt||receivedAt>=window+30_000||receivedAt-requestedAt>750||
  transport?.provider!=="kalshi"||transport.endpoint!=="market_event_metadata"||
  transport.status!==200||(transport.ageSeconds!==null&&transport.ageSeconds!==0)||
  servedAt<window||servedAt>receivedAt||!(receivedAt-servedAt<=5_000)||
  !Array.isArray(event.markets)||event.markets.length!==1)return null;
 const market=row(event.markets[0]);
 if(!market||market.ticker!==ticker||market.event_ticker!==expected||
  market.exchange_index!==2||!active(market)||!floorContract(market)||
  time(market.open_time)!==window||time(market.close_time)!==window+900_000||
  (market.series_ticker!==undefined&&market.series_ticker!=="KXBTC15M")||
  typeof market.floor_strike!=="number"||!Number.isFinite(market.floor_strike)||market.floor_strike<=0||
  !["floorStrike","strike","target","threshold"].every(k=>market[k]==null))return null;
 return market.floor_strike;
}
