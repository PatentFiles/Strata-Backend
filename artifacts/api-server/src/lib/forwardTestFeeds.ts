import {rolloverReadShapeEvidence} from './rolloverReadShapeEvidence';
import {beginSourceQuoteRead} from "./sourceQuoteProvenance";
import {BtcFeedDiagnostics,type BtcFeedDiagnostic} from "./btcFeedDiagnostics";
import {publishHeldRolloverDiagnostics} from './rolloverStrikeDiagnostics';
import {marketStrikeEvidence,RolloverStrikeDiagnostics,type RolloverStrikeEvent} from "./rolloverStrikeDiagnostics";
import {createPublicFeedJsonReader,type PublicFeedReadEvidence} from "./publicFeedJson";
import { fetchKalshiPublicBook, type OrderbookRead } from "./forwardTestOrderbookDepth";
// Public market data only. This module never authenticates with a trading
// account and contains no order endpoint or trading capability.
export type BtcObservation = {
  price: number;
  receivedAt: Date;
  providerAt: Date;
};

export type MarketObservation = {
  ticker: string;
  target: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  yesPrice: number | null;
  noPrice: number | null;
  result: "yes" | "no" | null;
  status: string;
  fetchedAt: Date;
};

export type ForwardTestFeeds = {
  btc: (signal?: AbortSignal) => Promise<BtcObservation>;
  market: (ticker?: string, signal?: AbortSignal) => Promise<MarketObservation>;
  /** Optional research-only, post-decision book read. Injected tests omit it. */
  book?: OrderbookRead;
};

// Kalshi currently recommends the dedicated external Trade API origin.
const KALSHI = "https://external-api.kalshi.com/trade-api/v2/markets";
const COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, fields: string[]) {
  for (const key of fields) {
    const value = numeric(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(source: Record<string, unknown>, fields: string[]) {
  for (const key of fields) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function date(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Provider units come from the field, never from a value threshold. A present
 * fixed-point dollar field is authoritative, including when malformed; do not
 * silently substitute a rounded legacy cent field or invent a plausible quote.
 */
function marketPrice(source:Record<string,unknown>,dollars:string,legacyCents:string,aliases:string[]):number|null {
  if(Object.prototype.hasOwnProperty.call(source,dollars)) {
    const value=source[dollars];
    if(typeof value!=="string"||!/^\d+(?:\.\d{1,6})?$/.test(value))return null;
    const parsed=Number(value);
    return Number.isFinite(parsed)&&parsed>=0&&parsed<=1?parsed:null;
  }
  if(Object.prototype.hasOwnProperty.call(source,legacyCents)) {
    const value=source[legacyCents];
    if((typeof value!=="number"&&typeof value!=="string")||!/^\d+$/.test(String(value)))return null;
    const parsed=Number(value);
    return Number.isSafeInteger(parsed)&&parsed>=0&&parsed<=100?parsed/100:null;
  }
  // Historical non-provider aliases retain their existing convention only when
  // neither authoritative provider field exists.
  const value=firstNumber(source,aliases);
  if(value===null)return null;
  const parsed=value>1?value/100:value;
  return parsed>=0&&parsed<=1?parsed:null;
}

function targetOf(market: Record<string, unknown>) {
  return marketStrikeEvidence(market).value;
}

function normalizeMarket(value: unknown, fetchedAt: Date): MarketObservation | null {
  if (!value || typeof value !== "object") return null;
  const market = value as Record<string, unknown>;
  const ticker = firstString(market, ["ticker", "market_ticker"]);
  if (!ticker) return null;
  const yesBid = marketPrice(market, "yes_bid_dollars", "yes_bid", ["yesBid", "best_yes_bid"]);
  const yesAsk = marketPrice(market, "yes_ask_dollars", "yes_ask", ["yesAsk", "best_yes_ask"]);
  const noBid = marketPrice(market, "no_bid_dollars", "no_bid", ["noBid", "best_no_bid"]);
  const noAsk = marketPrice(market, "no_ask_dollars", "no_ask", ["noAsk", "best_no_ask"]);
  const last = marketPrice(market, "last_price_dollars", "last_price", ["lastPrice", "yes_price"]);
  const yesPrice = yesBid !== null && yesAsk !== null
    ? (yesBid + yesAsk) / 2 : yesAsk ?? yesBid ?? last;
  const noPrice = noBid !== null && noAsk !== null
    ? (noBid + noAsk) / 2 : noAsk ?? noBid ?? (yesPrice === null ? null : 1 - yesPrice);
  const result = firstString(market, ["result", "settlement_result"]);
  return {
    ticker,
    target: targetOf(market),
    startsAt: date(firstString(market, ["open_time", "openTime"])),
    endsAt: date(firstString(market, ["close_time", "closeTime", "expiration_time", "expirationTime"])),
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesPrice,
    noPrice,
    result: result === "yes" || result === "no" ? result : null,
    status: firstString(market, ["status"]) ?? "open",
    fetchedAt,
  };
}

/** Lists route discovery only. Their cached quotes/status are never promoted
 * into a current snapshot; refresh the selected exact contract every cycle.
 */
export function createPublicForwardTestFeeds(fetchImpl:typeof fetch=fetch,clock:()=>Date=()=>new Date(),monotonicClock:()=>number=()=>performance.now(),observe?:(event:RolloverStrikeEvent)=>void,observeBtc?:(event:BtcFeedDiagnostic)=>void):ForwardTestFeeds {
const getJson=createPublicFeedJsonReader(fetchImpl,()=>clock().getTime(),monotonicClock);
const diagnostics=new RolloverStrikeDiagnostics(observe);
const btcDiagnostics=new BtcFeedDiagnostics(observeBtc,monotonicClock);
// Cache routing identity only, never observations. Canonical 15-minute metadata
// bounds this hint to one window; every use still performs a fresh exact GET.
let route: {ticker:string; window:number} | null = null;
let lastCurrentReadAt = -Infinity;
return {
  book: fetchKalshiPublicBook,
  async btc(signal) {
    const attempt=btcDiagnostics.begin();
    let evidence:PublicFeedReadEvidence|null=null;
    try {
    const raw = await getJson("coinbase","btc_ticker",COINBASE,signal,event=>{evidence=event;});
    if (!raw || typeof raw !== "object") throw new Error("Coinbase returned malformed BTC data");
    const payload = raw as Record<string, unknown>;
    const price = numeric(payload.price);
    const providerAt = date(payload.time);
    if (price === null || price <= 0 || !providerAt) {
      throw new Error("Coinbase BTC price or timestamp is unavailable");
    }
    btcDiagnostics.finish(attempt,true,evidence);
    return { price, providerAt, receivedAt: clock() };
    }catch(error){btcDiagnostics.finish(attempt,false,evidence);throw error;}
  },
  async market(ticker, signal) {
    const started=clock();
    const startedMs=started.getTime();
    if(!Number.isFinite(startedMs))throw new Error('Kalshi current market clock invalid');
    const currentWindow=Math.floor(startedMs/900_000)*900_000;
    const windowStart=currentWindow/1000;
    if(!ticker){
      if(startedMs<lastCurrentReadAt||route?.window!==currentWindow)route=null;
      lastCurrentReadAt=startedMs;
    }
    let selectedTicker=ticker??route?.ticker;
    if(!selectedTicker){
      // Discovery provides identity only. Do not use status=open: it has
      // historically returned an expired contract after rollover.
      const raw=await getJson("kalshi","market_discovery",
        `${KALSHI}?series_ticker=KXBTC15M&min_close_ts=${windowStart+1}&max_close_ts=${windowStart+1800}&limit=100`,signal);
      if(!raw||typeof raw!=='object')throw new Error('Kalshi returned malformed market data');
      const payload=raw as {markets?:unknown[]};
      const fetchedAt=clock();
      const selected=(Array.isArray(payload.markets)?payload.markets:[])
        .map(value=>normalizeMarket(value,fetchedAt))
        .filter((value):value is MarketObservation=>value!==null)
        .filter(value=>/^KXBTC15M-[A-Z0-9-]+$/.test(value.ticker)&&
          value.startsAt&&value.startsAt.getTime()<=fetchedAt.getTime()&&
          value.endsAt&&value.endsAt.getTime()>fetchedAt.getTime())
        .sort((a,b)=>a.endsAt!.getTime()-b.endsAt!.getTime())[0];
      if(!selected)throw new Error('Kalshi returned no current market');
      selectedTicker=selected.ticker;
    }
    const captureQuoteRead=beginSourceQuoteRead(()=>clock().getTime(),monotonicClock);
    let transport:PublicFeedReadEvidence|null=null;
    let detailRaw:unknown;
    try{detailRaw=await getJson("kalshi","market_detail",`${KALSHI}/${encodeURIComponent(selectedTicker)}`,signal,event=>{transport=event;});}
    catch(error){
      try{const at=clock().getTime();if(!ticker&&Math.floor(at/900000)*900000===currentWindow)diagnostics.observe(at,selectedTicker,null,transport);}catch{}
      throw error;
    }
    const detailAt=clock();
    const detail=detailRaw&&typeof detailRaw==='object'
      ?normalizeMarket((detailRaw as {market?:unknown}).market,detailAt):null;
    if(!detail||detail.ticker!==selectedTicker){
      if(!ticker)route=null;
      throw new Error('Kalshi exact market detail mismatch');
    }
    captureQuoteRead(detail,detailAt.getTime(),transport);
    // Explicit reads also serve expired positions/settlement and never populate
    // or replace the current-market route.
    if(ticker)return detail;
    const detailMs=detailAt.getTime();
    if(!Number.isFinite(detailMs)||detailMs<startedMs){
      route=null;
      throw new Error('Kalshi current market clock invalid');
    }
    if(!detail.startsAt||detail.startsAt.getTime()>detailAt.getTime()||
       !detail.endsAt||detail.endsAt.getTime()<=detailAt.getTime()||
       (detail.status!=='open'&&detail.status!=='active')){
      route=null;
      throw new Error('Kalshi returned no current market');
    }
    // Do not pin noncanonical dates, a response crossing the window boundary,
    // or a response made obsolete by a newer concurrent current-market read.
    if(detailMs>=lastCurrentReadAt&&Math.floor(detailMs/900_000)*900_000===currentWindow&&
       detail.startsAt.getTime()===currentWindow&&detail.endsAt.getTime()===currentWindow+900_000){
      route={ticker:detail.ticker,window:currentWindow};
    }else route=null;
    const rawMarket=(detailRaw as {market:Record<string,unknown>}).market;
    // Diagnostic only: this uses the same exact response and never rescues a
    // malformed strike or treats metadata receipt as a fresh executable quote.
    let detailEvidence=null;
    try{detailEvidence=rolloverReadShapeEvidence(rawMarket,selectedTicker,currentWindow,detail,transport);}catch{/* optional evidence never changes reads */}
    diagnostics.observe(detailMs,detail.ticker,marketStrikeEvidence(rawMarket),transport,detailEvidence);
    // Strike/offer validity remains enforced by the producer feed gate.
    // Never infer a strike or reuse list prices when the detail is incomplete.
    return detail;
  },
};
}
export const publicForwardTestFeeds: ForwardTestFeeds = createPublicForwardTestFeeds(fetch,()=>new Date(),()=>performance.now(),event=>{console.info(JSON.stringify(event));publishHeldRolloverDiagnostics(event);},event=>{console.info(JSON.stringify(event));});
