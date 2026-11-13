import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateV13Strategy,needsV13EntryPrice} from '@workspace/v13-strategy';
import {quoteFromEntryBook,readEntryBookQuote,assertEntrySourceFresh} from './forwardEntryBookQuote';
import type {MarketObservation,BtcObservation} from './forwardTestFeeds';
import {fetchKalshiPublicBook,type ReadonlyResearchBook} from './forwardTestOrderbookDepth';
const at=1793450000000,ticker='KXBTC15M-26OCT310715-15';
const market:MarketObservation={ticker,target:100000,startsAt:new Date(at-10000),endsAt:new Date(at+900000),
 yesAsk:.007,noAsk:.994,yesBid:.006,noBid:.993,yesPrice:.0065,noPrice:.9935,
 fetchedAt:new Date(at),status:'open',result:null};
const btc:BtcObservation={price:100010,providerAt:new Date(at),receivedAt:new Date(at)};
const book=(changes:Partial<ReadonlyResearchBook>={}):ReadonlyResearchBook=>({ticker,source:'KALSHI_PUBLIC_REST',
 timestampAuthority:'LOCAL_RECEIPT_ONLY',requestStartedAtMs:at+20,receivedAtMs:at+30,bodyCompletedAtMs:at+40,
 yesBids:[{priceTicks:5100,contractsHundredths:100000}],noBids:[{priceTicks:4800,contractsHundredths:100000}],...changes});
test('price-independent predicate covers all canonical qualifiers at champion boundaries',()=>{
 let qualifiers=0;
 for(const buffer of [-25,-20,-19.999,-15.001,-15,-8,-7.999,0,7.999,8,15,15.001,19.999,20,25])
 for(const previousBuffer of [null,-1,0,1])for(const velocity of [null,-1,0,1])
 for(const offer of [.007,.25,.52,.5201,.53,.5301,.99]){
  const input={marketTicker:ticker,btcPrice:100000+buffer,target:100000,previousBuffer,velocity,
   freshness:'current' as const,position:null};
  if(evaluateV13Strategy({...input,upOffer:offer,downOffer:offer}).qualifyingTrigger){qualifiers++;assert.equal(needsV13EntryPrice(input),true);}
  assert.equal(needsV13EntryPrice({...input,position:{status:'open',direction:'up'}}),false);
 }
 assert.ok(qualifiers>0);
});
test('coherent bids, asks and marks replace detail together without changing metadata timestamps',()=>{
 const q=quoteFromEntryBook(book(),market,at,at+50,'YES',5);
 assert.deepEqual([q.market.yesBid,q.market.yesAsk,q.market.noBid,q.market.noAsk],[.51,.52,.48,.49]);
 assert.deepEqual([q.market.yesPrice,q.market.noPrice],[.515,.485]);assert.equal(q.market.fetchedAt,market.fetchedAt);
 assert.equal(market.yesAsk,.007);assert.equal(q.evidence.purpose,'PRE_QUALIFICATION');
 assert.equal(q.evidence.responseHeadersAtMs,at+30);assert.equal(q.evidence.bodyCompletedAtMs,at+40);
 assert.match(q.evidence.normalizedBookDigest,/^[a-f0-9]{64}$/);assert.match(q.evidence.evidenceDigest,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(q.book.yesBids));
});
test('fractional prices/quantity and unsorted maxima retain exact complementary side',()=>{
 const q=quoteFromEntryBook(book({yesBids:[{priceTicks:5000,contractsHundredths:99},{priceTicks:9930,contractsHundredths:150}],
  noBids:[{priceTicks:60,contractsHundredths:200}]}),market,at,at+50,'YES',5);
 assert.equal(q.market.noAsk,.007);assert.equal(q.market.yesAsk,.994);assert.equal(q.book.yesBids[0]!.contractsHundredths,150);
});
test('missing/wrong/crossed/duplicate/malformed book cannot create quote',()=>{
 for(const change of [{ticker:'KXBTC15M-WRONG'}, {bodyCompletedAtMs:undefined},{noBids:[]},
  {yesBids:[{priceTicks:5100,contractsHundredths:0}]},{yesBids:[{priceTicks:5100,contractsHundredths:1.1}]},
  {yesBids:[{priceTicks:5100,contractsHundredths:100},{priceTicks:5100,contractsHundredths:200}]},
  {noBids:[{priceTicks:5000,contractsHundredths:100}]}])assert.throws(()=>quoteFromEntryBook(book(change),market,at,at+50,'YES',5));
});
test('headers do not establish body freshness; original deadline/close/regressed clocks fail',async()=>{
 let n=0;await assert.rejects(readEntryBookQuote(async()=>book({bodyCompletedAtMs:at+5001}),btc,market,at,()=>n++?at+5001:at),/source_stale/);
 assert.throws(()=>quoteFromEntryBook(book({bodyCompletedAtMs:at+5001}),market,at,at+5001,'YES',5),/capture_stale/);
 assert.throws(()=>assertEntrySourceFresh(btc,market,at,at-1),/source_stale/);
 let c=0;await assert.rejects(readEntryBookQuote(async()=>book(),btc,{...market,endsAt:new Date(at+40)},at,()=>c++?at+40:at),/market_closed/);
 assert.doesNotThrow(()=>assertEntrySourceFresh(btc,market,at,at+5000));assert.throws(()=>assertEntrySourceFresh(btc,market,at,at+5001),/source_stale/);
});
test('no fallback/retry; shutdown checked after original read settles',async()=>{
 let calls=0;await assert.rejects(readEntryBookQuote(undefined,btc,market,at,()=>at),/reader_unavailable/);
 await assert.rejects(readEntryBookQuote(async()=>{calls++;throw Error('HTTP 429');},btc,market,at,()=>at),/429/);assert.equal(calls,1);
 const controller=new AbortController();await assert.rejects(readEntryBookQuote(async()=>{calls++;controller.abort();return book();},btc,market,at,()=>at+50,controller.signal));assert.equal(calls,2);
});

test('actual public reader records header and full body separately without restamping source',async()=>{
 const originalFetch=globalThis.fetch,originalNow=Date.now;let time=at;
 Date.now=()=>time;
 globalThis.fetch=(async input=>{
  const response=new Response('{}',{status:200});Object.defineProperty(response,'url',{value:String(input)});
  Object.defineProperty(response,'text',{value:async()=>{time=at+5001;return JSON.stringify({orderbook_fp:{yes_dollars:[['0.5100','100.00']],no_dollars:[['0.4800','100.00']]}});}});
  return response;
 }) as typeof fetch;
 try{const received=await fetchKalshiPublicBook(ticker);assert.equal(received.receivedAtMs,at);
  assert.equal(received.bodyCompletedAtMs,at+5001);assert.match(received.rawResponseDigest!,/^[a-f0-9]{64}$/);
  assert.throws(()=>quoteFromEntryBook(received,market,at,time,'YES',5),/capture_stale/);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});
test('largest bounded identity and selected capacity remain compact, full ladders never stored in provenance',()=>{
 const longTicker='KXBTC15M-'+ 'A'.repeat(90),m={...market,ticker:longTicker};
 const q=quoteFromEntryBook(book({ticker:longTicker,rawResponseDigest:'f'.repeat(64)}),m,at,at+50,'YES',5);
 const encoded=JSON.stringify(q.evidence);assert.ok(Buffer.byteLength(encoded)<2048);
 assert.equal(q.evidence.capacity.requestedContracts,9);assert.equal(q.evidence.capacity.modeledUnfilledContracts,0);
 assert.equal(encoded.includes('contractsHundredths'),false);
});

test('a backward clock after read is refused even when all observation timestamps remain earlier',async()=>{
 let n=0;await assert.rejects(readEntryBookQuote(async()=>book(),btc,market,at,()=>n++?at+50:at+100),/clock_regressed/);
});
