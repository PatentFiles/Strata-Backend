import test from 'node:test';
import assert from 'node:assert/strict';
import {readStrictUnsettledPositions} from './strictUnsettledPositions';
const page=(market_positions:unknown[]=[],cursor='',event_positions:unknown[]=[])=>({market_positions,cursor,event_positions});
const read=(...pages:unknown[])=>readStrictUnsettledPositions(async()=>pages.shift(),new AbortController().signal);
const row={ticker:'KXBTC15M-FIXTURE',exchange_index:2,position_fp:'0.00'};
test('explicit empty terminal and correct pair; never pending cash or flat authority',async()=>{
 const r=await read(page());assert.equal(r.laneComplete,true);assert.equal(r.inventoryRowsPresent,false);
 assert.equal(r.pendingCashCompletenessVerified,false);assert.equal(r.authenticatedExchangeFlat,false);
});
test('zero net market or event inventory remains potential unsettled obligations',async()=>{
 assert.equal((await read(page([row]))).inventoryRowsPresent,true);
 assert.equal((await read(page([], '',[{event_ticker:'FIXTURE'}]))).inventoryRowsPresent,true);
});
test('strict scope, typed quantity, cursor and uniqueness',async()=>{
 for(const p of [{...page(),cursor:undefined},{...page(),cursor:null},{...page(),cursor:' '},
  {...page(),subaccount:2},{...page(),exchange_index:1},page([{...row,position_fp:undefined}]),
  page([{...row,position_fp:'garbage'}]),page([{...row,exchange_index:undefined}]),page([row,row]),
  page([], '',[{event_ticker:7}])])assert.equal((await read(p)).laneComplete,false);
 assert.equal((await read(page([], 'next'),page([], 'next'))).reason,'cursor_cycle');
 assert.equal((await read(...Array.from({length:20},(_,i)=>page([],String(i))))).reason,'page_cap');
});
test('exact archive-free scope and encoded cursor; cancellation refuses before another read',async()=>{
 const q:string[]=[];
 const r=await readStrictUnsettledPositions(async query=>{q.push(query);return q.length===1?page([],'a&subaccount=0'):page([row]);},new AbortController().signal);
 assert.equal(r.inventoryRowsPresent,true);
 assert.deepEqual(q,['?limit=200&subaccount=1&exchange_index=2&settlement_status=unsettled','?limit=200&subaccount=1&exchange_index=2&settlement_status=unsettled&cursor=a%26subaccount%3D0']);
 const stop=new AbortController();let calls=0;
 const refused=await readStrictUnsettledPositions(async()=>{calls++;stop.abort();return page([],'next');},stop.signal);
 assert.equal(refused.reason,'deadline');assert.equal(calls,1);
});
