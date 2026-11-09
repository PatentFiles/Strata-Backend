import test from 'node:test';import assert from 'node:assert/strict';
import {expectedPaperBookCoverage as audit,readExpectedPaperBookCoverage as read} from './paperBookExpectedCoverage';
test('absent receipts count even with no persisted receipt',()=>{
 const r=audit([{id:'p',status:'CLOSED'}],[],false);
 assert.equal(r.expectedEvents,2);assert.equal(r.absentReceipts,2);assert.equal(r.unavailableReceipts,0);
});
test('recorded unavailable distinct from absent',()=>{
 const r=audit([{id:'p',status:'CLOSED'}],[{paperPositionId:'p',phase:'ENTRY',status:'UNAVAILABLE'}],false);
 assert.equal(r.unavailableReceipts,1);assert.equal(r.absentReceipts,1);assert.equal(r.missingOrUnavailable,2);
});
test('settled positions do not imply a sale exit',()=>{
 const r=audit([{id:'p',status:'SETTLED'},{id:'q',status:'OPEN'}],[],false);assert.equal(r.expectedEvents,2);
});
test('unrelated receipts do not hide gaps',()=>{
 const r=audit([{id:'p',status:'OPEN'}],[{paperPositionId:'q',phase:'ENTRY',status:'CAPTURED'}],false);
 assert.equal(r.absentReceipts,1);
});
test('full matched coverage and truncation are independent',()=>{
 const r=audit([{id:'p',status:'CLOSED'}],['ENTRY','EXIT'].map(phase=>({paperPositionId:'p',phase,status:'CAPTURED'})),true);
 assert.equal(r.absentReceipts,0);assert.equal(r.capturedReceipts,2);assert.equal(r.positionsTruncated,true);
 assert.equal(r.proofOfActualExecution,false);
});
test('empty history is empty not global completeness',()=>{assert.equal(audit([],[],false).expectedEvents,0)});
test('invalid or duplicate evidence rejected',()=>{
 assert.throws(()=>audit([{id:'p',status:'UNKNOWN'}],[],false));
 assert.throws(()=>audit([{id:'p',status:'OPEN'},{id:'p',status:'OPEN'}],[],false));
 const r={paperPositionId:'p',phase:'ENTRY',status:'CAPTURED'};
 assert.throws(()=>audit([{id:'p',status:'OPEN'}],[r,r],false));
});
test('bounded position input enforced',()=>{assert.throws(()=>audit(Array.from({length:1001},(_,i)=>({id:String(i),status:'OPEN'})),[],true))});

test('reader bounds IDs and query limit and passes engine scope',async()=>{
 const positions=Array.from({length:1001},(_,i)=>({id:String(i),status:'CLOSED'}));
 const r=await read('engine-a',positions,async(engine,ids,limit)=>{
  assert.equal(engine,'engine-a');assert.equal(ids.length,1000);assert.equal(ids[999],'999');assert.equal(limit,2000);
  return ids.flatMap(paperPositionId=>['ENTRY','EXIT'].map(phase=>({paperPositionId,phase,status:'CAPTURED'})));
 });
 assert.equal(r.positionsTruncated,true);assert.equal(r.expectedEvents,2000);assert.equal(r.absentReceipts,0);
});
test('reader does not query empty selection',async()=>{
 const r=await read('engine',[],async()=>{throw Error('unexpected read')});assert.equal(r.expectedEvents,0);
});
test('reader matches receipts regardless of recent-window membership',async()=>{
 const r=await read('engine',[{id:'old-position',status:'OPEN'}],async()=>[
  {paperPositionId:'old-position',phase:'ENTRY',status:'CAPTURED'}]);assert.equal(r.absentReceipts,0);
});
test('pending asynchronous capture is explicitly point-in-time',async()=>{
 const positions=[{id:'p',status:'OPEN'}];
 const first=await read('engine',positions,async()=>[]);
 const later=await read('engine',positions,async()=>[{paperPositionId:'p',phase:'ENTRY',status:'CAPTURED'}]);
 assert.equal(first.absentReceipts,1);assert.equal(later.absentReceipts,0);
 assert.equal(first.absentMayBePending,true);assert.equal(first.consistency,'POINT_IN_TIME_NON_ATOMIC');
});
