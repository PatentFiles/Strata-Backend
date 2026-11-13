import test from 'node:test';
import assert from 'node:assert/strict';
import {rolloverReadShapeEvidence} from './rolloverReadShapeEvidence';
import {createPublicForwardTestFeeds} from './forwardTestFeeds';
import {RolloverStrikeDiagnostics,marketStrikeEvidence,type RolloverStrikeEvent} from './rolloverStrikeDiagnostics';
const T=Date.parse('2026-10-31T14:30:00Z'),ticker='KXBTC15M-26OCT311045-45';
const raw=()=>({ticker,event_ticker:'KXBTC15M-26OCT311045',series_ticker:'KXBTC15M',exchange_index:2,status:'active',open_time:new Date(T).toISOString(),close_time:new Date(T+900000).toISOString(),floor_strike:null,yes_ask_dollars:'0.5000',no_ask_dollars:'0.5100'});
const market=()=>({ticker,target:null,startsAt:new Date(T),endsAt:new Date(T+900000),yesBid:.49,yesAsk:.5,noBid:.48,noAsk:.51,yesPrice:.495,noPrice:.495,result:null,status:'active',fetchedAt:new Date(T+2392)} as const);
test('bounded non-strike shape evidence preserves origin uncertainty and raw field presence',()=>{
 const e=rolloverReadShapeEvidence({...raw(),secret:'never log'},ticker,T,market(),null);
 assert.equal(e.nonStrikeScopeAndOffersPresent,true);assert.equal(e.quoteOriginAtMs,null);assert.equal(e.quoteOriginAgeMs,null);
 assert.equal(e.quoteExecutability,'NOT_PROVEN');assert.equal(e.eventSeriesIdentityVerified,false);
 const absent=rolloverReadShapeEvidence({...raw(),exchange_index:undefined,series_ticker:undefined},ticker,T,market(),null);
 assert.equal(absent.marketIndexCompatible,true);assert.equal(absent.exchangeIndexVerified,false);
 assert.equal(absent.nonStrikeScopeAndOffersPresent,true);assert.equal(absent.eventSeriesIdentityVerified,false);
 assert.equal(e.quoteReceiptAtMs,T+2392);assert.equal(e.fields.exchange_index,'number');assert.ok(Object.isFrozen(e));
 assert.doesNotMatch(JSON.stringify(e),/never log/);
 for(const mutation of [{exchange_index:null},{exchange_index:'2'},{exchange_index:0},{open_time:new Date(T-900000).toISOString()},{status:'closed'},{ticker:'KXBTC15M-WRONG'}]){
  assert.equal(rolloverReadShapeEvidence({...raw(),...mutation},ticker,T,market(),null).nonStrikeScopeAndOffersPresent,false);
 }
 assert.equal(rolloverReadShapeEvidence(raw(),ticker,T,{...market(),yesAsk:null},null).nonStrikeScopeAndOffersPresent,false);
 assert.equal(rolloverReadShapeEvidence(raw(),ticker,T,{...market(),fetchedAt:new Date(T+900000)},null).nonStrikeScopeAndOffersPresent,false);
});
test('existing exact read records early scope/offers with cache metadata but no strike rescue or extraGET',async()=>{
 let calls=0;const events:RolloverStrikeEvent[]=[];
 const feed=createPublicForwardTestFeeds(async input=>{calls++;return new Response(JSON.stringify(String(input).includes('?')?{markets:[raw()]}:{market:raw()}),{headers:{Date:new Date(T).toUTCString(),Age:'2','Cache-Control':'max-age=15'}});},()=>new Date(T+2392),()=>0,e=>events.push(e));
 const m=await feed.market();assert.equal(calls,2);assert.equal(m.target,null);assert.equal(m.fetchedAt.getTime(),T+2392);
 assert.equal(events.length,1);const e=events[0].detailEvidence!;assert.equal(e.nonStrikeScopeAndOffersPresent,true);
 assert.equal(e.httpDateAtMs,T);assert.equal(e.httpAgeSeconds,2);assert.equal(e.cacheMaxAgeSeconds,15);
 assert.equal(e.quoteOriginAgeMs,null);assert.equal(events[0].phase,'first_unavailable');
 assert.equal(e.requestStartedAtMs,T+2392);assert.equal(e.requestToParsedDetailMs,0);
 assert.equal(e.priceUnits,'DOLLARS_PER_CONTRACT');
});
test('one extra bounded shape phase covers initial transport failure without more reads or events',()=>{
 const events:RolloverStrikeEvent[]=[];const d=new RolloverStrikeDiagnostics(e=>events.push(e));
 d.observe(T,ticker,null,null);
 const shape=rolloverReadShapeEvidence(raw(),ticker,T,market(),null);
 for(let i=0;i<100;i++)d.observe(T+2392+i,ticker,marketStrikeEvidence(raw()),null,shape);
 d.observe(T+30000,ticker,marketStrikeEvidence(raw()),null,shape);
 d.observe(T+31000,ticker,marketStrikeEvidence({...raw(),floor_strike:77322.12}),null,shape);
 assert.deepEqual(events.map(e=>e.phase),['first_unavailable','non_strike_fields_ready','unresolved_30s','ready']);
});
