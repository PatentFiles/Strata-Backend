import test from 'node:test';
import assert from 'node:assert/strict';
import {marketStrikeEvidence,RolloverStrikeDiagnostics,type RolloverStrikeEvent} from './rolloverStrikeDiagnostics';
import {createPublicForwardTestFeeds} from './forwardTestFeeds';
import {forwardTestFeedError} from './forwardTestFeedValidation';
import {BoundaryDiscoveryRecovery,producerDelayMs} from './forwardTestCadence';
const T=Date.parse('2026-10-31T03:45:00Z'),TICKER='KXBTC15M-26OCT310000-00';
const row=(strike:unknown)=>({ticker:TICKER,status:'active',open_time:new Date(T).toISOString(),close_time:new Date(T+900000).toISOString(),floor_strike:strike,yes_ask_dollars:'0.5000',no_ask_dollars:'0.5100'});
test('strike evidence retains only bounded types and finite values, same parser precedence',()=>{
 for(const [value,valid] of [[null,false],['secret key material',false],[{},false],['77080.15',true],[77080.15,true],[0,false],[-1,false],[Infinity,false]] as const){
  const e=marketStrikeEvidence({floor_strike:value,title:'secret title',cap_strike:'secret cap',strike_type:'secret type',updated_time:'secret date'});
  assert.equal(e.valid,valid);assert.ok(!JSON.stringify(e).includes('secret'));
 }
 const e=marketStrikeEvidence({floor_strike:0,strike:77080.15});assert.equal(e.selectedField,'floor_strike');assert.equal(e.value,0);assert.equal(e.valid,false);
 assert.equal(marketStrikeEvidence({floor_strike:null,strike:'77080.15'}).selectedField,'strike');
});
test('at most3 compact events per window; repeated/late callbacks cannot duplicate readiness',()=>{
 const events:RolloverStrikeEvent[]=[];const d=new RolloverStrikeDiagnostics(e=>events.push(e));
 for(let i=0;i<1000;i++)d.observe(T+i*500,TICKER,marketStrikeEvidence({floor_strike:null}),null);
 d.observe(T+500000,TICKER,marketStrikeEvidence({floor_strike:77080.15}),null);
 for(let i=0;i<1000;i++)d.observe(T+500000+i,TICKER,marketStrikeEvidence({floor_strike:77080.15}),null);
 assert.deepEqual(events.map(e=>e.phase),['first_unavailable','unresolved_30s','ready']);
 assert.equal(events[2].invalidStrikeReads,1000);assert.equal(events[2].detailReadAttempts,1001);
 assert.ok(JSON.stringify(events).length<5000);
 d.observe(T+900000,TICKER,marketStrikeEvidence({floor_strike:78000}),null);assert.equal(events.length,4);
 d.observe(T+1000,TICKER,marketStrikeEvidence({floor_strike:null}),null);assert.equal(events.length,4);
});
test('diagnostic sink failures do not change returned market, requests, or eligibility',async()=>{
 let calls=0;
 const api=createPublicForwardTestFeeds(async input=>{calls++;return new Response(JSON.stringify(String(input).includes('?')?{markets:[row(null)]}:{market:row(null)}));},()=>new Date(T),()=>0,()=>{throw Error('diagnostics offline');});
 assert.equal((await api.market()).target,null);assert.equal(calls,2);
});
test('existing exact reads emit typed missing strike then recovery, without extra discovery',async()=>{
 let now=T,mono=0,strike:unknown=null,calls=0;const events:RolloverStrikeEvent[]=[];
 const api=createPublicForwardTestFeeds(async input=>{calls++;mono+=12;return new Response(JSON.stringify(String(input).includes('?')?{markets:[row(99999)]}:{market:row(strike)}),{headers:{Date:new Date(now).toUTCString(),Age:'3','Cache-Control':'max-age=15, no-store','X-Secret':'never retain'}});},()=>new Date(now),()=>mono,e=>events.push(e));
 assert.equal((await api.market()).target,null);now+=1000;strike=77080.15;assert.equal((await api.market()).target,77080.15);
 assert.equal(calls,3);assert.deepEqual(events.map(e=>e.phase),['first_unavailable','ready']);
 assert.equal(events[0].strike?.fields[0].type,'null');assert.equal(events[1].detailReadAttempts,2);
 assert.equal(events[1].transport?.roundTripMs,12);assert.equal(events[1].transport?.ageSeconds,3);assert.equal(events[1].transport?.cacheMaxAgeSeconds,15);assert.equal(events[1].transport?.cacheNoStore,true);
 assert.ok(!JSON.stringify(events).includes('never retain'));
});
test('429/cooldown/abort and explicit settlement reads do not gain requests or fresh observations',async()=>{
 let now=T,mono=0,calls=0;const events:RolloverStrikeEvent[]=[];
 const api=createPublicForwardTestFeeds(async input=>{calls++;if(String(input).includes('?'))return new Response(JSON.stringify({markets:[row(null)]}));return new Response('',{status:429,headers:{'Retry-After':'30'}});},()=>new Date(now),()=>mono,e=>events.push(e));
 await assert.rejects(api.market(),/HTTP 429/);now+=1000;mono+=1000;await assert.rejects(api.market(),/cooldown/);assert.equal(calls,2);assert.equal(events.length,1);assert.equal(events[0].transport?.status,429);
 const abort=new AbortController();abort.abort();let abortCalls=0;
 const aborted=createPublicForwardTestFeeds(async(_input,init)=>{abortCalls++;assert.equal(init?.signal?.aborted,true);throw Error('secret transport');},()=>new Date(T),()=>0,e=>events.push(e));
 await assert.rejects(aborted.market(TICKER,abort.signal),/aborted=true/);assert.equal(abortCalls,1);assert.equal(events.length,1);
});
test('cross-boundary expired exact response cannot create ready event or pin next market',async()=>{
 let now=T,calls=0;const events:RolloverStrikeEvent[]=[];
 const api=createPublicForwardTestFeeds(async input=>{calls++;if(!String(input).includes('?'))now=T+900000;return new Response(JSON.stringify(String(input).includes('?')?{markets:[row(null)]}:{market:row(77080.15)}));},()=>new Date(now),()=>0,e=>events.push(e));
 await assert.rejects(api.market(),/no current market/);assert.equal(events.length,0);assert.equal(calls,2);
});
test('bounded schedule replay quantifies ready times without changing deployed cadence',()=>{
 const ready=[0,1,5,11,15,20,30],observed:number[]=[];
 for(const seconds of ready){
  const recovery=new BoundaryDiscoveryRecovery();let now=T,reads=0;
  while(now-T<60000){reads++;if(now-T>=seconds*1000)break;
   const period=recovery.periodMs('Kalshi exact market strike is missing or invalid',now);
   now+=150+producerDelayMs(period,150);
  }
  observed.push((now-T)/1000);assert.ok(reads<=15);
 }
 assert.deepEqual(observed,[0,1,5,15,15,20,30]);
});

test('valid strike diagnostics cannot rescue stale BTC or snapshot evidence',async()=>{
 const events:RolloverStrikeEvent[]=[];
 const api=createPublicForwardTestFeeds(async input=>new Response(JSON.stringify(String(input).includes('?')?{markets:[row(77080.15)]}:{market:row(77080.15)})),()=>new Date(T),()=>0,e=>events.push(e));
 const market=await api.market();assert.equal(events[0].phase,'ready');
 const btc={price:77081,receivedAt:new Date(T),providerAt:new Date(T-16000)};
 assert.match(forwardTestFeedError(btc,market,new Date(T),false)??'',/Coinbase.*stale/);
 btc.providerAt=new Date(T);market.fetchedAt=new Date(T-16000);
 assert.equal(forwardTestFeedError(btc,market,new Date(T),false),'Kalshi market snapshot is missing or stale');
});
test('alternating ticker identities cannot multiply per-window logs; malformed clocks stay nonfatal',()=>{
 const events:RolloverStrikeEvent[]=[];const d=new RolloverStrikeDiagnostics(e=>events.push(e));
 for(let i=0;i<100;i++)d.observe(T+i*500,`KXBTC15M-ALT-${i}`,marketStrikeEvidence({floor_strike:null}),null);
 d.observe(T+50000,TICKER,marketStrikeEvidence({floor_strike:77080.15}),null);
 assert.equal(events.length,3);assert.equal(events[0].ticker,'KXBTC15M-ALT-0');
 for(const bad of [NaN,Infinity,-1,Number.MAX_SAFE_INTEGER])assert.doesNotThrow(()=>d.observe(bad,'secret/invalid',null,null));
 assert.equal(events.length,3);
 d.observe(T+900000,TICKER,marketStrikeEvidence({floor_strike:78000}),null);
 assert.equal(events.length,4,'invalid huge clock must not poison subsequent valid windows');
 const throwing=new RolloverStrikeDiagnostics(()=>{throw Error('offline');});
 assert.doesNotThrow(()=>throwing.observe(T,TICKER,marketStrikeEvidence({floor_strike:null}),null));
});
