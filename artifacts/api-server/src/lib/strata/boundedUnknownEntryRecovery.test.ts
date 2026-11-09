import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginUnknownEntryRecovery as begin,stepUnknownEntryRecovery as step} from './boundedUnknownEntryRecovery';
const initial=()=>begin('account','intent','4',100000);
const read=()=>step(initial(),{kind:'tick',now:100000,fence:'4'}).state;
test('one read in flight and no order authority',()=>{
 const one=step(initial(),{kind:'tick',now:100000,fence:'4'});
 assert.equal(one.action,'REQUEST_AUTHORIZED_READ');
 assert.equal(one.maySubmitOrder,false);assert.equal(one.entriesEnabled,false);
 assert.equal(step(one.state,{kind:'tick',now:100001,fence:'4'}).action,'NONE');
});
test('successful read is not accounting or trading authority',()=>{
 const s=read();const r=step(s,{kind:'read_completed',now:100001,fence:'4',attemptId:s.attemptId!});
 assert.equal(r.state.phase,'review');assert.equal(r.tradingAuthorized,false);
 assert.equal(r.state.reason,'snapshot_requires_native_ledger_validation');
 assert.equal(step(r.state,{kind:'tick',now:100002,fence:'4'}).action,'NONE');
});
for(const kind of ['read_failed','read_completed'] as const) {
 test(`${kind} rejects wrong attempt`,()=>assert.equal(step(read(),{kind,now:100001,fence:'4',attemptId:'other'}).state.phase,'halted'));
 test(`${kind} rejects changed fence`,()=>assert.equal(step(read(),{kind,now:100001,fence:'5',attemptId:read().attemptId!}).state.reason,'fence_changed'));
 test(`${kind} rejects expired evidence`,()=>assert.equal(step(read(),{kind,now:115000,fence:'4',attemptId:read().attemptId!}).state.reason,'recovery_deadline_exceeded'));
}
test('stop never restarts',()=>{
 const r=step(read(),{kind:'stop',now:100001,fence:'4'});
 assert.equal(r.state.phase,'halted');assert.equal(step(r.state,{kind:'tick',now:100002,fence:'4'}).action,'NONE');
});
test('three failed reads maximum with backoff',()=>{
 let s=initial();let now=100000;
 for(let i=1;i<=3;i++){
  s=step(s,{kind:'tick',now,fence:'4'}).state;assert.equal(s.attempts,i);
  s=step(s,{kind:'read_failed',now:now+1,fence:'4',attemptId:s.attemptId!}).state;
  if(i<3){assert.equal(step(s,{kind:'tick',now:now+2,fence:'4'}).action,'NONE');now+=1001;}
 }
 assert.equal(s.phase,'halted');assert.equal(s.reason,'recovery_attempts_exhausted');
});
test('regressing clock fails closed',()=>assert.equal(step(read(),{kind:'tick',now:99999,fence:'4'}).state.reason,'invalid_or_regressing_clock'));
test('invalid initial scope rejected',()=>{for(const n of [NaN,Infinity,-1,1.1]) assert.throws(()=>begin('a','b','4',n));});
test('late duplicate completion fails closed rather than starting another action',()=>{
 const s=read(),e={kind:'read_failed' as const,now:100001,fence:'4',attemptId:s.attemptId!};
 assert.equal(step(step(s,e).state,e).state.phase,'halted');
});
