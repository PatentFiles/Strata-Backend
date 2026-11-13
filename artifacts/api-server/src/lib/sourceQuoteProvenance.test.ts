import test from 'node:test';import assert from 'node:assert/strict';
import {beginSourceQuoteRead,getSourceQuoteProvenance,emitCommittedSourceQuote} from './sourceQuoteProvenance';
import {createPublicForwardTestFeeds} from './forwardTestFeeds';
const at=Date.parse('2026-10-31T12:45:03Z'),ticker='KXBTC15M-26OCT310900-00';
const committed={evaluationId:'11111111-1111-4111-8111-111111111111',engineId:'v1.3-paper',signal:'SCOUT',marketTicker:ticker,evaluatedAtMs:at,commitReturnObservedAtMs:at+100,qualifyingTrigger:true};
test('existing exact GET captures only safe HTTP provenance without extra reads or timestamp changes',async()=>{
 let wall=at,mono=10,calls=0;
 const transport=(async()=>{calls++;wall+=20;mono+=20;return Response.json({market:{ticker,status:'active',open_time:'2026-10-31T12:45:00Z',close_time:'2026-10-31T13:00:00Z',floor_strike:80000,yes_bid_dollars:'0.9920',yes_ask_dollars:'0.9930',no_bid_dollars:'0.0060',no_ask_dollars:'0.0070'}},
  {headers:{Date:'Sat, 31 Oct 2026 12:44:59 GMT',Age:'4','Cache-Control':'public, max-age=15','Set-Cookie':'SECRET','Authorization':'SECRET'}});}) as typeof fetch;
 const feeds=createPublicForwardTestFeeds(transport,()=>new Date(wall),()=>mono);
 const market=await feeds.market(ticker);const d=getSourceQuoteProvenance(market)!;
 assert.equal(calls,1);assert.equal(market.fetchedAt.getTime(),at+20);assert.equal(market.noAsk,.007);
 assert.equal(d.requestStartedAtMs,at);assert.equal(d.responseHeadersAtMs,at+20);assert.equal(d.parsedDetailReceivedAtMs,at+20);
 assert.equal(d.headersElapsedMs,20);assert.equal(d.requestToParsedDetailMs,20);assert.equal(d.httpStatus,200);
 assert.equal(d.httpResponseAgeSeconds,4);assert.equal(d.cacheMaxAgeSeconds,15);assert.equal(d.httpDateAtMs,Date.parse('2026-10-31T12:44:59Z'));
 assert.equal(d.quoteOriginAtMs,null);assert.equal(d.quoteOriginAgeAtReceiptMs,null);assert.equal(d.noAsk,.007);
 assert.ok(Object.isFrozen(d));assert.ok(!JSON.stringify(d).includes('SECRET'));
 assert.ok(!JSON.stringify(market).includes('httpStatus'));
 const emitted:unknown[]=[];emitCommittedSourceQuote(market,committed,e=>emitted.push(e));await Promise.resolve();
 assert.equal((emitted[0] as any).evaluationId,committed.evaluationId);assert.equal((emitted[0] as any).provenance,d);
 assert.equal((emitted[0] as any).evaluatedAtMs,at);
});
test('unknown origin stays unknown even with Date/Age; fake diagnostics cannot be injected',async()=>{
 const market={yesAsk:.5,noAsk:.5,raw:'SECRET',provenance:{httpStatus:200}};
 beginSourceQuoteRead(()=>at,()=>10)(market,at,null);
 const d=getSourceQuoteProvenance(market)!;assert.equal(d.httpDateAtMs,null);assert.equal(d.httpResponseAgeSeconds,null);
 assert.equal(d.quoteOriginAgeAtReceiptMs,null);assert.equal(getSourceQuoteProvenance({...market}),undefined);
 const events:any[]=[];emitCommittedSourceQuote({},committed,e=>events.push(e));await Promise.resolve();
 assert.equal(events[0].provenanceAvailable,false);assert.equal(events[0].provenance,null);
});
test('qualifier-only logging, invalid diagnostics and observer errors never change observations',async()=>{
 const market={yesAsk:.5,noAsk:.5};const before=JSON.stringify(market);
 beginSourceQuoteRead(()=>{throw Error('SECRET');},()=>NaN)(market,NaN,null);
 assert.equal(JSON.stringify(market),before);assert.equal(getSourceQuoteProvenance(market)!.requestStartedAtMs,null);
 let emitted=0;
 for(const patch of [{signal:'PASS'},{engineId:'challenger'},{qualifyingTrigger:false},{evaluationId:'bad'}])
  emitCommittedSourceQuote(market,{...committed,...patch},()=>emitted++);
 await Promise.resolve();assert.equal(emitted,0);
 emitCommittedSourceQuote(market,committed,()=>{throw Error('logger');});
 emitCommittedSourceQuote(market,committed,()=>Promise.reject(Error('logger')));
 await Promise.resolve();await Promise.resolve();assert.equal(JSON.stringify(market),before);
});
