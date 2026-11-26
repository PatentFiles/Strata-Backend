import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BoundedAnalyticsQueue} from './boundedAnalyticsQueue';
test('transient and uncertain commits retry identical IDs without duplicate storage',async()=>{
 const stored=new Map<string,object>();let calls=0;
 const q=new BoundedAnalyticsQueue<{id:string}>(async rows=>{
  for(const r of rows)stored.set(r.id,r);
  if(++calls===1)throw Error('response lost after commit');
  return rows.filter(r=>stored.get(r.id)===r).length;
 });
 const a={id:'a'},b={id:'b'};q.enqueue(a);q.enqueue(b);
 assert.equal(await q.flush(),true);assert.equal(stored.size,2);assert.equal(calls,2);
 assert.deepEqual(q.snapshot(),{accepted:2,confirmed:2,overflow:0,retryExhausted:0,rejected:0,retries:2,afterClose:0,pending:0,accepting:false,complete:false});
});
test('capacity includes in-flight data and producers never await I/O',async()=>{
 let release!:(value:number)=>void;
 const q=new BoundedAnalyticsQueue<object>(()=>new Promise(r=>{release=r;}),{capacity:2,batchSize:2});
 assert.equal(q.enqueue({}),true);assert.equal(q.enqueue({}),true);
 const pending=q.drain();await Promise.resolve();assert.equal(q.enqueue({}),false);
 assert.equal(q.snapshot().pending,2);release(2);await pending;await q.flush();assert.equal(q.snapshot().overflow,1);
});
test('permanent failures have bounded attempts and visible delivery gaps',async()=>{
 let calls=0,gaps=0;const q=new BoundedAnalyticsQueue<object>(async()=>{calls++;throw Error('offline');},{onGap:()=>{gaps++;}});
 q.enqueue({});assert.equal(await q.flush(),true);assert.equal(calls,3);assert.equal(q.snapshot().retryExhausted,1);assert.equal(gaps,1);
 assert.equal(q.enqueue({}),false);assert.equal(q.snapshot().afterClose,1);
});
test('concurrent drains are single-flight and scope-rejected rows are counted',async()=>{
 let calls=0;const q=new BoundedAnalyticsQueue<object>(async()=>{calls++;return 0;});q.enqueue({});
 await Promise.all([q.drain(),q.drain(),q.drain()]);assert.equal(calls,1);assert.equal(q.snapshot().rejected,1);await q.flush();
});
test('shutdown timeout does not falsely report successful persistence',async()=>{
 let release!:(value:number)=>void;const q=new BoundedAnalyticsQueue<object>(()=>new Promise(r=>{release=r;}));q.enqueue({});
 assert.equal(await q.flush(10),false);assert.equal(q.snapshot().pending,1);assert.equal(q.snapshot().confirmed,0);
 release(1);await q.drain();assert.equal(q.snapshot().confirmed,1);
});
