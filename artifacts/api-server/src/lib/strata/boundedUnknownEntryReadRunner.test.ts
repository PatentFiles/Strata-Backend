import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedUnknownEntryReadRunner as create} from './boundedUnknownEntryReadRunner';
test('single-use runner never overlaps or grants trading authority',async()=>{
 let reads=0,active=0,max=0,auth=0;
 const run=create({now:()=>100000,authorizeRead:async()=>{auth++;},read:async()=>{
  reads++;active++;max=Math.max(max,active);await Promise.resolve();active--;if(reads<3)throw Error();return 'snapshot';
 }});
 const result=await run();assert.equal(result.ok,true);assert.equal(result.tradingAuthorized,false);
 assert.equal(reads,3);assert.equal(auth,3);assert.equal(max,1);
 assert.equal((await run()).ok,false);assert.equal(reads,3);
});
test('authorization failure is terminal before read',async()=>{
 let reads=0;const r=await create({now:()=>100000,authorizeRead:async()=>{throw Error();},read:async()=>{reads++;}})();
 assert.equal(r.ok,false);assert.equal(reads,0);
});
test('clock expiry after read cannot accept snapshot',async()=>{
 let now=100000;const r=await create({now:()=>now,authorizeRead:async()=>{},read:async()=>{now+=15000;return 'late';}})();
 assert.equal(r.ok,false);assert.equal(r.attempts,1);
});
test('timeout abandoning abort-ignoring read never retries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reads=0;let signal:AbortSignal|undefined;
 const run=create({now:()=>100000,authorizeRead:async()=>{},read:async s=>{reads++;signal=s;return await new Promise<string>(()=>{});}});
 const pending=run();for(let i=0;i<8;i++)await Promise.resolve();
 t.mock.timers.tick(15000);const result=await pending;
 assert.equal(result.ok,false);assert.equal(reads,1);assert.equal(signal?.aborted,true);
 assert.equal((await run()).ok,false);assert.equal(reads,1);
});
test('concurrent invocation refused before transport',async()=>{
 let release!:(s:string)=>void,reads=0;
 const run=create({now:()=>100000,authorizeRead:async()=>{},read:async()=>{reads++;return new Promise<string>(r=>{release=r;});}});
 const pending=run();for(let i=0;i<8;i++)await Promise.resolve();
 const second=await run();assert.equal(second.ok,false);assert.equal(reads,1);release('done');await pending;
});

test('authorization consuming deadline cannot begin transport',async()=>{
 let now=100000,reads=0;const result=await create({now:()=>now,authorizeRead:async()=>{now+=15000;},read:async()=>{reads++;}})();
 assert.equal(result.ok,false);assert.equal(reads,0);
});
test('dependency mutation cannot replace held transport',async()=>{
 let original=0,replacement=0;const deps={now:()=>100000,authorizeRead:async()=>{deps.read=async()=>{replacement++;return 'bad';};},read:async()=>{original++;return 'good';}};
 const result=await create(deps)();assert.equal(result.ok,true);assert.equal(original,1);assert.equal(replacement,0);
});

test('external KILL aborts pending read and forbids new attempts',async()=>{
 const kill=new AbortController();let reads=0,signal:AbortSignal|undefined;
 const run=create({now:()=>100000,externalSignal:kill.signal,authorizeRead:async()=>{},read:async s=>{reads++;signal=s;return await new Promise(()=>{});}});
 const pending=run();for(let i=0;i<8;i++)await Promise.resolve();kill.abort();
 assert.equal((await pending).ok,false);assert.equal(signal?.aborted,true);assert.equal(reads,1);
});
test('expired caller episode deadline never authorizes read',async()=>{
 let auth=0;const r=await create({now:()=>100000,deadlineMs:99999,authorizeRead:async()=>{auth++;},read:async()=>{}})();
 assert.equal(r.ok,false);assert.equal(auth,0);
});
