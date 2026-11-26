import test from 'node:test';import assert from 'node:assert/strict';
import {capture,endpoint} from './capture.mjs';
const ticker='KXBTC15M-TEST';
test('absent signer never opens a socket',async()=>assert.deepEqual(await capture({ticker}),{status:'READ_ONLY_SIGNER_UNAVAILABLE',ordersEnabled:false}));
const stamp=1700000000000;
const snap={type:'orderbook_snapshot',sid:1,seq:2,sending_ts_ms:stamp,msg:{market_ticker:ticker,market_id:'mock',clock:100,yes_dollars_fp:[],no_dollars_fp:[]}};
const delta={type:'orderbook_delta',sid:1,seq:3,sending_ts_ms:stamp+10,msg:{market_ticker:ticker,market_id:'mock',clock:102,ts_ms:stamp+8,side:"yes",price_dollars:"0.4800",delta_fp:"1.25"}};
async function run(d){
 const it=[snap,d][Symbol.iterator]();
 return capture({ticker,now:()=>stamp+11,mono:()=>10,openReadOnly:async p=>{assert.equal(p.url,endpoint);return {subscribe:q=>assert.deepEqual(q,{channel:'orderbook_delta',ticker,updateIntervalMs:0}),next:()=>it.next(),close(){}};}});
}
test('separate venue event, send and receive times',async()=>{const a=await run(delta);assert.equal(a.status,'VENUE_TIMESTAMPED_BOOK_OBSERVED');assert.equal(a.eventAtMs,stamp+8);assert.equal(a.venueSentAtMs,stamp+10);assert.equal(a.localReceivedAtMs,stamp+11);assert.equal(a.ordersEnabled,false);});
test('gaps, mismatched channel/scope and missing old venue stamp fail closed',async()=>{for(const d of [{...delta,seq:4},{...delta,sid:2},{...delta,msg:{...delta.msg,market_ticker:'BAD'}},{...delta,msg:{...delta.msg,ts_ms:undefined}},{...delta,msg:{...delta.msg,ts_ms:stamp-5000}}])assert.equal((await run(d)).status,'VENUE_TIMESTAMPED_EVIDENCE_UNVERIFIED');});

test('a fresh delta cannot refresh an old snapshot; sequence time must not go backwards',async()=>{
 for (const sending_ts_ms of [stamp+5001,stamp-1]) {
   const d={...delta,sending_ts_ms,msg:{...delta.msg,ts_ms:sending_ts_ms}};
   const recv=sending_ts_ms>stamp?sending_ts_ms:stamp;
   const it=[snap,d][Symbol.iterator]();
   const out=await capture({ticker,now:()=>recv,openReadOnly:async()=>({subscribe(){},next:()=>it.next(),close(){}})});
   assert.equal(out.status,'VENUE_TIMESTAMPED_EVIDENCE_UNVERIFIED');
 }
});
