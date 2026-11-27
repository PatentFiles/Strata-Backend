import test from 'node:test';
import assert from 'node:assert/strict';
import {beginExecutionStage,type StageTiming} from './stageTiming';
import {isPrepareReadTiming,observePrepareRead,PrepareReadCapture} from './prepareReadTiming';

test('fast preparations are sampled; errors and slow queries keep exact bounded aggregates',async()=>{
 let now=0;
 const c=new PrepareReadCapture(()=>now,false);
 const fast=Promise.resolve(4);
 assert.equal(observePrepareRead(c,'duplicate_lookup',()=>fast),fast);
 await fast;assert.equal(c.snapshot(false),undefined);
 for(const n of [25,80]){
  await observePrepareRead(c,'canonical_receipt',()=>{now+=n;return Promise.resolve();});
 }
 const rows=c.snapshot(false)!;
 assert.deepEqual(rows,[{phase:'duplicate_lookup',count:1,totalMs:0,maxMs:0,failed:false},
  {phase:'canonical_receipt',count:2,totalMs:105,maxMs:80,failed:false,firstReceiptMs:[25,80]}]);
 assert.ok(isPrepareReadTiming(rows)&&Object.isFrozen(rows)&&rows.every(Object.isFrozen));
 assert.equal(isPrepareReadTiming([...rows]),false);
 for(let i=0;i<7;i++)await observePrepareRead(c,'canonical_receipt',()=>{now+=1;return Promise.resolve();});
 const later=c.snapshot(false)!.find(r=>r.phase==='canonical_receipt')!;
 assert.equal(later.count,9);assert.deepEqual(later.firstReceiptMs,[25,80,1,1]);
 assert.ok(Object.isFrozen(later.firstReceiptMs));assert.deepEqual(rows[1]?.firstReceiptMs,[25,80]);
 const sampled=new PrepareReadCapture(()=>0,true);
 await observePrepareRead(sampled,'pool_checkout',()=>Promise.resolve());
 assert.equal(sampled.snapshot(false)?.length,1);
});

test('one invocation, same refusal and promise, with no error strings or SQL in the report',async()=>{
 const failure=new Error('sensitive driver detail');
 const c=new PrepareReadCapture(()=>0,false);let calls=0;
 const pending=Promise.reject(failure);
 assert.equal(observePrepareRead(c,'receipt_rows',()=>{calls++;return pending;}),pending);
 await assert.rejects(pending,e=>e===failure);
 assert.throws(()=>observePrepareRead(c,'initial_authority',()=>{calls++;throw failure;}),e=>e===failure);
 assert.equal(calls,2);assert.equal(c.snapshot(false)?.length,2);
 assert.ok(c.snapshot(false)?.every(x=>x.failed));
 assert.equal(JSON.stringify(c.snapshot(true)).includes(failure.message),false);
 const broken=new PrepareReadCapture(()=>{throw failure;},true);
 assert.equal(await observePrepareRead(broken,'authority_gate',()=>Promise.resolve(3)),3);
 assert.equal(broken.snapshot(true),undefined);
});

test('only a genuine report on the prepare event reaches its observer',async()=>{
 const c=new PrepareReadCapture(()=>1,true);
 await observePrepareRead(c,'remaining_ids',()=>Promise.resolve());
 const rows=c.snapshot(false)!;
 const events:StageTiming[]=[];
 const emit=(stage:'prepare_entry'|'dispatch',report:typeof rows)=>
  beginExecutionStage(e=>{events.push(e);},stage,{accountId:'a',mode:'SIMULATION'},()=>1)('completed',{prepareReadTiming:report});
 emit('prepare_entry',rows);emit('dispatch',rows);emit('prepare_entry',[...rows]);
 await Promise.resolve();
 assert.equal(events[0]?.prepareReadTiming,rows);
 assert.equal(events[1]?.prepareReadTiming,undefined);assert.equal(events[2]?.prepareReadTiming,undefined);
});
