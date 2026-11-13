import {getSourceQuoteProvenance} from './sourceQuoteProvenance';
import type {MarketObservation} from './forwardTestFeeds';
import type {PublicFeedReadEvidence} from './publicFeedJson';
const FIELDS=['ticker','event_ticker','series_ticker','exchange_index','market_type','open_time','close_time','status','yes_ask_dollars','no_ask_dollars','yes_ask','no_ask'] as const;
export type EvidenceFieldType='missing'|'null'|'number'|'string'|'other';
export function evidenceFieldType(row:Record<string,unknown>,key:string):EvidenceFieldType{
 const x=row[key];return !Object.prototype.hasOwnProperty.call(row,key)?'missing':x===null?'null':typeof x==='number'?'number':typeof x==='string'?'string':'other';
}
const safeTime=(x:unknown):number|null=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000?x:null;
const time=(x:unknown):number|null=>typeof x==='string'&&x.length<=64?safeTime(Date.parse(x)):null;
const price=(x:unknown):number|null=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1?x:null;
/** Bounded observations only; no source promotion, eligibility or clock repair. */
export function rolloverReadShapeEvidence(raw:Record<string,unknown>,expectedTicker:string,window:number,
 market:MarketObservation,transport:PublicFeedReadEvidence|null){
 const ticker=typeof raw.ticker==='string'&&/^KXBTC15M-[A-Z0-9-]{1,80}$/.test(raw.ticker)?raw.ticker:null;
 const eventTicker=typeof raw.event_ticker==='string'&&/^KXBTC15M-[A-Z0-9-]{1,80}$/.test(raw.event_ticker)?raw.event_ticker:null;
 const seriesTicker=raw.series_ticker==='KXBTC15M'?'KXBTC15M':null;
 const index=typeof raw.exchange_index==='number'&&Number.isSafeInteger(raw.exchange_index)&&raw.exchange_index>=0&&raw.exchange_index<=1000?raw.exchange_index:null;
 const open=time(raw.open_time),close=time(raw.close_time),receipt=safeTime(market.fetchedAt.getTime());
 const status=typeof raw.status==='string'&&['open','active','initialized','inactive','closed','settled','determined','disputed','amended','finalized'].includes(raw.status)?raw.status:null;
 const yesAsk=price(market.yesAsk),noAsk=price(market.noAsk);
 const canonicalWindow=safeTime(window)!==null&&window%900000===0&&open===window&&close===window+900000;
 const exactTicker=ticker!==null&&ticker===expectedTicker;
 const currentAtReceipt=receipt!==null&&open!==null&&close!==null&&open<=receipt&&receipt<close;
 const marketIndexCompatible=raw.exchange_index===undefined||index===2;
 const exactMarketWindowStatusFieldsVerified=exactTicker&&eventTicker!==null&&canonicalWindow&&currentAtReceipt&&(status==='open'||status==='active');
 const duration=(x:unknown):number|null=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=Number.MAX_SAFE_INTEGER?x:null;
 const provenance=getSourceQuoteProvenance(market);
 return Object.freeze({version:1 as const,diagnosticOnly:true as const,
  fields:Object.freeze(Object.fromEntries(FIELDS.map(key=>[key,evidenceFieldType(raw,key)]))),
  ticker,eventTicker,seriesTicker,exchangeIndex:index,openAtMs:open,closeAtMs:close,status,
  exactTicker,canonicalWindow,currentAtReceipt,exchangeIndexVerified:index===2,marketIndexCompatible,exactMarketWindowStatusFieldsVerified,
  marketType:raw.market_type==='binary'||raw.market_type==='scalar'?raw.market_type:null,
  eventSeriesIdentityVerified:false as const, // requires an independent event/series join, not ticker parsing
  yesAsk,noAsk,bothSideOffersPresent:yesAsk!==null&&noAsk!==null,
  nonStrikeScopeAndOffersPresent:exactMarketWindowStatusFieldsVerified&&marketIndexCompatible&&yesAsk!==null&&noAsk!==null,
  priceUnits:'DOLLARS_PER_CONTRACT' as const,
  quoteReceiptAtMs:receipt,quoteOriginAtMs:null,quoteOriginAgeMs:null,
  quoteExecutability:'NOT_PROVEN' as const,
  requestStartedAtMs:safeTime(provenance?.requestStartedAtMs),requestToParsedDetailMs:duration(provenance?.requestToParsedDetailMs),
  responseHeadersAtMs:time(transport?.receivedAt),headersElapsedMs:duration(transport?.roundTripMs),
  httpDateAtMs:time(transport?.responseDate),httpAgeSeconds:duration(transport?.ageSeconds),
  cacheMaxAgeSeconds:duration(transport?.cacheMaxAgeSeconds),cacheNoStore:transport?.cacheNoStore===true});
}
export type RolloverReadShapeEvidence=ReturnType<typeof rolloverReadShapeEvidence>;
