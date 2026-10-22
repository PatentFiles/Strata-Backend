/**
 * Read-only Kalshi KXBTC15M market-depth research. No order or account authority.
 *
 * Kalshi REST /markets/{ticker}/orderbook returns YES/NO bids only.
 * Opposite-side bids create asks at (1 - bid), same quantity.
 * REST has NO exchange snapshot timestamp, clock or sequence guarantee:
 * local request start/end timestamps are provenance, NOT an atomic trade-time book.
 *
 * Fixed-point: prices in 1/10000 USD ticks; quantities in 1/100 contracts.
 */
export type OrderbookSide = "yes" | "no";
export type ResearchBookLevel = {priceTicks:number; contractsHundredths:number};
export type ReadonlyResearchBook = {
  ticker:string;
  requestStartedAtMs:number;
  receivedAtMs:number;
  source:"KALSHI_PUBLIC_REST"|"KALSHI_SEQUENCED_WEBSOCKET";
  timestampAuthority:"LOCAL_RECEIPT_ONLY"|"KALSHI_EXCHANGE_SENDING_TIMESTAMP";
  yesBids:ResearchBookLevel[];
  noBids:ResearchBookLevel[];
};
export type DepthQuote = {
  orderSide:"buy" | "sell";
  contractSide:OrderbookSide;
  requestedContracts:number;
  modeledFilledContracts:number;
  modeledUnfilledContracts:number;
  modeledCashMicros:string;
  modeledAveragePriceTicks:number|null;
  bestPriceTicks:number|null;
  usedPriceLevels:number;
  interpretation:"BOOK_CAPACITY_ONLY_NOT_EXECUTION";
};
const MAX_LEVELS=1000;
const MAX_QUANTITY_HUNDREDTHS=1_000_000_000;
function priceTicks(x:unknown):number {
  if(typeof x!=="string"||! /^(?:0|1)\.[0-9]{1,4}$/.test(x))throw Error("invalid_book_price");
  const [d,f]=x.split(".");
  const result=Number(d)*10000+Number(f.padEnd(4,"0"));
  if(!Number.isSafeInteger(result)||result<0||result>10000)throw Error("invalid_book_price");
  return result;
}
function quantityHundredths(x:unknown):number {
  if(typeof x!=="string"||! /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(x))
    throw Error("invalid_book_quantity");
  const [d,f=""]=x.split(".");
  const n=Number(d)*100+Number(f.padEnd(2,"0"));
  if(!Number.isSafeInteger(n)||n<=0||n>MAX_QUANTITY_HUNDREDTHS)throw Error("invalid_book_quantity");
  return n;
}
function levels(value:unknown):ResearchBookLevel[]{
  if(!Array.isArray(value)||value.length>MAX_LEVELS)throw Error("invalid_book_levels");
  const seen=new Set<number>();
  const mapped=value.map((raw:unknown)=>{
    if(!Array.isArray(raw)||raw.length!==2)throw Error("invalid_book_level_tuple");
    const price=priceTicks(raw[0]),qty=quantityHundredths(raw[1]);
    if(seen.has(price))throw Error("duplicate_book_price");
    seen.add(price);
    return {priceTicks:price,contractsHundredths:qty};
  });
  return mapped.sort((a,b)=>b.priceTicks-a.priceTicks);
}
export function parseKalshiResearchOrderbook(
 raw:unknown,ticker:string,startedAtMs:number,receivedAtMs:number,
):ReadonlyResearchBook{
 if(!/^KXBTC15M-[A-Z0-9-]{5,90}$/.test(ticker)||
    !Number.isSafeInteger(startedAtMs)||!Number.isSafeInteger(receivedAtMs)||
    startedAtMs<=0||receivedAtMs<startedAtMs||receivedAtMs-startedAtMs>5_000)
   throw Error("invalid_book_identity_or_capture_time");
 if(!raw||typeof raw!=="object")throw Error("missing_orderbook");
 const o=(raw as Record<string,unknown>).orderbook_fp;
 if(!o||typeof o!=="object")throw Error("missing_fixed_point_orderbook");
 const b=o as Record<string,unknown>;
 // Do not silently interpret absent book arrays as empty zero-liquidity levels.
 if(!Array.isArray(b.yes_dollars)||!Array.isArray(b.no_dollars))
   throw Error("incomplete_fixed_point_orderbook");
 return {ticker,requestStartedAtMs:startedAtMs,receivedAtMs,
  source:"KALSHI_PUBLIC_REST",timestampAuthority:"LOCAL_RECEIPT_ONLY",
  yesBids:levels(b.yes_dollars),noBids:levels(b.no_dollars)};
}
/**
 * A deterministic, no-order walk of whole-contract capacity at a strict
 * price limit. No queue, hidden liquidity, book persistence or fill guarantee.
 * A fractional quantity at an individual price is conservatively rounded down.
 */
export function simulateBookCapacity(
 book:ReadonlyResearchBook, contractSide:OrderbookSide,
 orderSide:"buy"|"sell", requestedContracts:number,
 limitPriceTicks:number, maxPriceCashMicros?:bigint,
):DepthQuote{
 if(!Number.isSafeInteger(requestedContracts)||requestedContracts<1||
    requestedContracts>1_000_000||
    !Number.isSafeInteger(limitPriceTicks)||limitPriceTicks<0||limitPriceTicks>10000||
    (maxPriceCashMicros!==undefined&&maxPriceCashMicros<0n))
    throw Error("invalid_depth_simulation_request");
 const own=contractSide==="yes"?book.yesBids:book.noBids;
 const opposite=contractSide==="yes"?book.noBids:book.yesBids;
 const ladder=(orderSide==="sell"?own:opposite).map(l=>({
   priceTicks:orderSide==="sell"?l.priceTicks:10000-l.priceTicks,
   contracts:Math.floor(l.contractsHundredths/100),
 })).sort((a,b)=>orderSide==="sell"?b.priceTicks-a.priceTicks:a.priceTicks-b.priceTicks);
 let filled=0,cash=0n,used=0,first:number|null=null;
 for(const l of ladder){
   if(orderSide==="buy"?l.priceTicks>limitPriceTicks:l.priceTicks<limitPriceTicks)break;
   let count=Math.min(l.contracts,requestedContracts-filled);
   if(orderSide==="buy"&&maxPriceCashMicros!==undefined&&l.priceTicks>0){
     const remaining=maxPriceCashMicros-cash;
     count=Math.min(count,remaining>0n?Number(remaining/BigInt(l.priceTicks*100)):0);
   }
   if(count>0){
     filled+=count;cash+=BigInt(count)*BigInt(l.priceTicks)*100n;
     used++;first??=l.priceTicks;
   }
   if(filled===requestedContracts)break;
 }
 return {orderSide,contractSide,requestedContracts,
   modeledFilledContracts:filled,modeledUnfilledContracts:requestedContracts-filled,
   modeledCashMicros:cash.toString(),
   modeledAveragePriceTicks:filled>0?Math.round(Number(cash)/100/filled):null,
   bestPriceTicks:first,usedPriceLevels:used,
   interpretation:"BOOK_CAPACITY_ONLY_NOT_EXECUTION"};
}
export type OrderbookRead=(ticker:string,signal?:AbortSignal)=>Promise<ReadonlyResearchBook>;
export async function fetchKalshiPublicBook(ticker:string,signal?:AbortSignal):Promise<ReadonlyResearchBook>{
 if(!/^KXBTC15M-[A-Z0-9-]{5,90}$/.test(ticker))throw Error("invalid_research_ticker");
 const origin="https://external-api.kalshi.com";
 const uri=origin+"/trade-api/v2/markets/"+encodeURIComponent(ticker)+"/orderbook";
 const started=Date.now();
 const timeout=AbortSignal.timeout(1900);
 const combined=signal?AbortSignal.any([signal,timeout]):timeout;
 const resp=await fetch(uri,{method:"GET",cache:"no-store",redirect:"error",
    headers:{Accept:"application/json"},signal:combined});
 const received=Date.now();
 if(!resp.ok||resp.url!==uri)throw Error("book_http_or_origin_invalid");
 const size=resp.headers.get("content-length");
 if(size&&Number(size)>320_000)throw Error("book_payload_too_large");
 const text=await resp.text();
 if(text.length>320_000)throw Error("book_payload_too_large");
 let raw:unknown;
 try{raw=JSON.parse(text)}catch{throw Error("book_response_malformed")}
 return parseKalshiResearchOrderbook(raw,ticker,started,received);
}
