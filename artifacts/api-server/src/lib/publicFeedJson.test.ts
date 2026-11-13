import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicFeedJsonReader,publicFeedRetryAfterMs} from './publicFeedJson';
const NOW=Date.parse('2026-10-30T17:00:00Z');
test('Retry-After accepts seconds and HTTP date; malformed values use bounded fallback',()=>{
 assert.equal(publicFeedRetryAfterMs('12',NOW),12000);
 assert.equal(publicFeedRetryAfterMs('0',NOW),0);
 assert.equal(publicFeedRetryAfterMs(new Date(NOW+45000).toUTCString(),NOW),45000);
 assert.equal(publicFeedRetryAfterMs(new Date(NOW-1000).toUTCString(),NOW),0);
 for(const bad of [null,'','-1','1.5','1e3','tomorrow','2026-10-30','x'.repeat(129)])assert.equal(publicFeedRetryAfterMs(bad,NOW),null,bad??'null');
 assert.equal(publicFeedRetryAfterMs('9'.repeat(100),NOW),Number.MAX_SAFE_INTEGER);
});
test('provider-separated monotonic cooldown honors date and wall-clock changes without requests',async()=>{
 let wall=NOW,mono=100,calls=0;
 const read=createPublicFeedJsonReader(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':new Date(NOW+60000).toUTCString()}})},()=>wall,()=>mono);
 await assert.rejects(read('coinbase','btc_ticker','https://example.test'),/HTTP 429.*60000/);
 mono+=5000;wall+=86400000;
 await assert.rejects(read('coinbase','btc_ticker','https://example.test'),/remainingMs=55000/);
 mono=1;wall-=2*86400000;
 await assert.rejects(read('coinbase','btc_ticker','https://example.test'),/remainingMs=55000/);
 assert.equal(calls,1);
 await assert.rejects(read('kalshi','market_discovery','https://example.test'),/provider=kalshi.*HTTP 429/);
 assert.equal(calls,2);
});
test('missing or malformed 429 hints back off 30s to 5min and success resets only its provider',async()=>{
 let mono=0,calls=0,success=false;
 const read=createPublicFeedJsonReader(async()=>{calls++;return success?new Response('{"fresh":true}'):new Response('',{status:429,headers:{'Retry-After':'bad'}})},()=>NOW,()=>mono);
 for(const delay of [30000,60000,120000,240000,300000,300000]){
  await assert.rejects(read('kalshi','market_detail','https://example.test'),new RegExp(`cooldownMs=${delay}`));
  const before=calls;mono+=delay-1;
  await assert.rejects(read('kalshi','market_discovery','https://example.test'),/cooldown remainingMs=1/);assert.equal(calls,before);
  mono++;
 }
 success=true;assert.deepEqual(await read('kalshi','market_detail','https://example.test'),{fresh:true});
 success=false;await assert.rejects(read('kalshi','market_detail','https://example.test'),/cooldownMs=30000/);
});
test('non-429 errors identify provider without persistent cooldown or leaking body',async()=>{
 let calls=0;
 const read=createPublicFeedJsonReader(async()=>{calls++;return new Response('do not log me',{status:503})},()=>NOW,()=>0);
 for(let i=0;i<2;i++)await assert.rejects(read('kalshi','market_detail','https://example.test'),e=>e instanceof Error&&e.message==='Public market feed provider=kalshi endpoint=market_detail HTTP 503');
 assert.equal(calls,2);
});
test('older concurrent success cannot erase a newer rate-limit hold',async()=>{
 let complete!:(r:Response)=>void,calls=0;
 const read=createPublicFeedJsonReader(async()=>{calls++;if(calls===1)return new Promise<Response>(r=>{complete=r});return new Response('',{status:429,headers:{'Retry-After':'60'}})},()=>NOW,()=>0);
 const old=read('kalshi','market_detail','https://example.test');
 await assert.rejects(read('kalshi','market_discovery','https://example.test'),/HTTP 429/);
 complete(new Response('{}'));await old;
 await assert.rejects(read('kalshi','market_detail','https://example.test'),/cooldown/);assert.equal(calls,2);
});
test('transport and JSON failures retain bounded provider diagnostics; no clock failure dispatch',async()=>{
 const failed=createPublicFeedJsonReader(async()=>{throw Error('private transport detail')},()=>NOW,()=>0);
 await assert.rejects(failed('coinbase','btc_ticker','https://example.test'),/^Error: Public market feed provider=coinbase endpoint=btc_ticker request_failed$/);
 const bad=createPublicFeedJsonReader(async()=>new Response('not json'),()=>NOW,()=>0);
 await assert.rejects(bad('coinbase','btc_ticker','https://example.test'),/invalid_json/);
 let calls=0;const clock=createPublicFeedJsonReader(async()=>{calls++;return new Response('{}')},()=>NOW,()=>NaN);
 await assert.rejects(clock('coinbase','btc_ticker','https://example.test'),/monotonic_clock_invalid/);assert.equal(calls,0);
});
