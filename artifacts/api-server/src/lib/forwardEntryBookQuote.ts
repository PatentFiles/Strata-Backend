import {digest} from "./v13-production/types";
import {createHash} from "node:crypto";
import type {ForwardTestEvaluation} from "@workspace/db";
import type {BtcObservation,MarketObservation} from "./forwardTestFeeds";
import {simulateBookCapacity,type OrderbookRead,type ReadonlyResearchBook} from "./forwardTestOrderbookDepth";
export const ENTRY_BOOK_MAX_AGE_MS=5000;
export type EntryBookQuote={book:ReadonlyResearchBook;market:MarketObservation;
  evidence:NonNullable<ForwardTestEvaluation['entryQuoteEvidence']>};
const validClock=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
/** Original observations only. A later book must never restart any source clock. */
export function assertEntrySourceFresh(btc:BtcObservation,market:MarketObservation,cycleAt:number,now:number):void {
 for(const at of [cycleAt,btc.providerAt.getTime(),btc.receivedAt.getTime(),market.fetchedAt.getTime()]){
  if(!validClock(now)||!validClock(at)||now<at||now-at>ENTRY_BOOK_MAX_AGE_MS)
   throw Error('entry_book_source_stale');
 }
 if(!market.startsAt||!market.endsAt||market.startsAt.getTime()>now||market.endsAt.getTime()<=now||
    !['open','active'].includes(market.status))throw Error('entry_book_market_closed');
}
export function quoteFromEntryBook(book:ReadonlyResearchBook,market:MarketObservation,
 cycleAt:number,now:number,side:"YES"|"NO",paperStake:number):EntryBookQuote {
 if(!/^KXBTC15M-[A-Z0-9-]{5,90}$/.test(market.ticker)||book.source!=='KALSHI_PUBLIC_REST'||book.timestampAuthority!=='LOCAL_RECEIPT_ONLY'||book.ticker!==market.ticker)
  throw Error('entry_book_identity_invalid');
 const start=book.requestStartedAtMs,headers=book.receivedAtMs,body=book.bodyCompletedAtMs;
 if(!validClock(cycleAt)||!validClock(now)||now<cycleAt||now-cycleAt>ENTRY_BOOK_MAX_AGE_MS||
    !validClock(start)||!validClock(headers)||!validClock(body)||start<cycleAt||headers<start||body<headers||
    now<body||now-start>ENTRY_BOOK_MAX_AGE_MS)throw Error('entry_book_capture_stale');
 const bids=(levels:ReadonlyResearchBook['yesBids'])=>{
  if(!Array.isArray(levels)||!levels.length||levels.length>1000)throw Error('entry_book_depth_missing');
  const seen=new Set<number>();
  for(const l of levels){
   if(!Number.isSafeInteger(l.priceTicks)||l.priceTicks<=0||l.priceTicks>=10000||
      !Number.isSafeInteger(l.contractsHundredths)||l.contractsHundredths<=0||l.contractsHundredths>1_000_000_000||
      seen.has(l.priceTicks))throw Error('entry_book_depth_invalid');
   seen.add(l.priceTicks);
  }
  return levels.map(l=>Object.freeze({...l})).sort((a,b)=>b.priceTicks-a.priceTicks);
 };
 const yes=bids(book.yesBids),no=bids(book.noBids),yb=yes[0]!.priceTicks,nb=no[0]!.priceTicks;
 if(yb+nb>10000)throw Error('entry_book_crossed');
 const ya=10000-nb,na=10000-yb;
 const frozenBook=Object.freeze({...book,yesBids:Object.freeze(yes),noBids:Object.freeze(no)}) as unknown as ReadonlyResearchBook;
 const referencePriceTicks=side==='YES'?ya:na,stakeMicros=Math.round(paperStake*1_000_000);
 if(!['YES','NO'].includes(side)||!Number.isSafeInteger(stakeMicros)||stakeMicros<=0||paperStake*1_000_000!==stakeMicros)
  throw Error('entry_book_paper_stake_invalid');
 const requestedContracts=Math.floor(stakeMicros/(referencePriceTicks*100));
 const modeled=simulateBookCapacity(frozenBook,side==='YES'?'yes':'no','buy',requestedContracts,referencePriceTicks,BigInt(stakeMicros));
 const capacity=Object.freeze({side,referencePriceTicks,stakeMicros:String(stakeMicros),requestedContracts,
  modeledFilledContracts:modeled.modeledFilledContracts,modeledUnfilledContracts:modeled.modeledUnfilledContracts,
  modeledCashMicros:modeled.modeledCashMicros});
 const unsigned={version:1 as const,source:'KALSHI_PUBLIC_ORDERBOOK' as const,purpose:'PRE_QUALIFICATION' as const,
  marketTicker:market.ticker,requestStartedAtMs:start,responseHeadersAtMs:headers,bodyCompletedAtMs:body,
  yesBidTicks:yb,noBidTicks:nb,yesAskTicks:ya,noAskTicks:na,
  normalizedBookDigest:createHash('sha256').update(JSON.stringify({ticker:book.ticker,yes,no})).digest('hex'),
  capacity,rawResponseDigest:typeof book.rawResponseDigest==='string'&&/^[a-f0-9]{64}$/.test(book.rawResponseDigest)?book.rawResponseDigest:null};
 const evidence=Object.freeze({...unsigned,evidenceDigest:digest(unsigned)});
 if(Buffer.byteLength(JSON.stringify(evidence),'utf8')>2048)throw Error('entry_book_provenance_too_large');
 return Object.freeze({book:frozenBook,evidence,market:Object.freeze({...market,
  yesBid:yb/10000,noBid:nb/10000,yesAsk:ya/10000,noAsk:na/10000,
  yesPrice:(yb+ya)/20000,noPrice:(nb+na)/20000})});
}
export async function readEntryBookQuote(read:OrderbookRead|undefined,btc:BtcObservation,market:MarketObservation,
 cycleAt:number,clock:()=>number,signal?:AbortSignal,paperStake=5):Promise<EntryBookQuote>{
 if(!read)throw Error('entry_book_reader_unavailable');
 const before=clock();assertEntrySourceFresh(btc,market,cycleAt,before);
 const deadline=Math.min(cycleAt,btc.providerAt.getTime(),btc.receivedAt.getTime(),market.fetchedAt.getTime())+ENTRY_BOOK_MAX_AGE_MS;
 const remaining=Math.min(1900,deadline-before,market.endsAt!.getTime()-before);
 if(remaining<=0)throw Error('entry_book_source_stale');
 const timeout=AbortSignal.timeout(Math.max(1,Math.floor(remaining)));
 const scope=signal?AbortSignal.any([signal,timeout]):timeout;
 scope.throwIfAborted();
 // Await settlement even on timeout; the production transport honors this signal.
 const book=await read(market.ticker,scope);
 scope.throwIfAborted();
 const now=clock();if(now<before)throw Error('entry_book_clock_regressed');
 assertEntrySourceFresh(btc,market,cycleAt,now);
 return quoteFromEntryBook(book,market,cycleAt,now,btc.price>market.target!?'YES':'NO',paperStake);
}
