import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import ts from 'typescript';
import {ForwardTransactionTiming,observeForwardTransaction,serializeForwardTransaction,type ForwardTransactionPhase} from './forwardTransactionTiming';
const phases:ForwardTransactionPhase[]=['requested','transaction_callback','lease_locked','position_read','window_ready','history_ready','classified','work_complete','lease_renewed','committed'];
test('monotonic elapsed phases are fixed, complete and explicitly pool plus BEGIN',()=>{
 let at=0;const t=new ForwardTransactionTiming(()=>at);
 for(const phase of phases){t.mark(phase);at+=2.125;}
 const s=t.snapshot();assert.equal(s.complete,true);assert.equal(s.poolAndBeginMs,2.125);
 assert.equal(s.leaseLockMs,2.125);assert.equal(s.commitAndReleaseMs,2.125);assert.equal(Object.keys(s).length,10);
 assert.equal(Object.isFrozen(s),true);
});
test('missing, reordered, duplicate, regressed and broken clocks stay unknown',()=>{
 for(const clock of [()=>NaN,()=>Infinity,()=>-1,()=>{throw Error('clock');}]){
  const t=new ForwardTransactionTiming(clock);for(const p of phases)t.mark(p);assert.equal(t.snapshot().complete,false);
 }
 for(const order of [phases.slice(0,-1),[...phases.slice(0,2),'requested',...phases.slice(2)],[...phases].reverse()]){
  const t=new ForwardTransactionTiming(()=>1);for(const p of order)t.mark(p as ForwardTransactionPhase);
  assert.deepEqual(Object.values(t.snapshot()).filter(x=>x!==null),[false]);
 }
 let n=10;const t=new ForwardTransactionTiming(()=>n--);for(const p of phases)t.mark(p);assert.equal(t.snapshot().complete,false);
});
test('allowlist excludes caller extras; malformed completed intervals become unknown',()=>{
 const t=new ForwardTransactionTiming(()=>1);for(const p of phases)t.mark(p);
 const extra={...t.snapshot(),secret:'never'};const valid=serializeForwardTransaction(extra);assert.equal(JSON.stringify(valid).includes('never'),false);
 assert.equal(serializeForwardTransaction({...t.snapshot(),leaseLockMs:Infinity})?.complete,false);
 assert.equal(serializeForwardTransaction(undefined),null);
});
test('optional observer cannot throw into transaction flow',()=>{
 assert.doesNotThrow(()=>observeForwardTransaction(()=>{throw Error('observer');},'requested'));
 assert.doesNotThrow(()=>observeForwardTransaction(undefined,'requested'));
});
// Execute the unchanged transaction sequencing around mocked SQL results. Real
// PostgreSQL fencing/rollback remains the existing worker integration's remit.
const source=readFileSync(resolve('src/lib/forwardTestRepository.ts'),'utf8');
const start=source.indexOf('export async function withWorkerLeaseTransaction<');
const end=source.indexOf('\ntype EnginePatch',start);assert(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function repositoryHarness(lock=true,renew=true){
 const calls:string[]=[];const exports:Record<string,any>={};
 const tx={select:()=>({from:()=>({where:()=>({for:()=>({limit:async()=>{calls.push('lock');return lock?[{}]:[];}})})})}),
 update:()=>({set:()=>({where:()=>({returning:async()=>{calls.push('renew');return renew?[{}]:[];}})})})};
 const db={transaction:async(fn:(arg:typeof tx)=>unknown)=>{calls.push('begin');try{const result=await fn(tx);calls.push('commit');return result;}catch(e){calls.push('rollback');throw e;}}};
 runInNewContext(code,{exports,db,observeForwardTransaction,FORWARD_TEST_ENGINE_ID:'test',forwardTestEngineTable:{},
  and:()=>{},eq:()=>{},sql:()=>{},leaseDuration:()=>{},WorkerLeaseLostError:class extends Error{}});
 return {calls,run:exports.withWorkerLeaseTransaction};
}
test('actual repository transaction keeps result, SQL ordering and observer failure isolation',async()=>{
 const h=repositoryHarness();const value={original:true};
 assert.equal(await h.run('owner',1,async()=>{h.calls.push('work');return value;},'test',20,()=>{throw Error('observer');}),value);
 assert.deepEqual(h.calls,['begin','lock','work','renew','commit']);
});
test('work error identity and lease failures retain rollback with diagnostics present',async()=>{
 const h=repositoryHarness();const error=new Error('original');
 await assert.rejects(h.run('owner',1,async()=>{throw error;},'test',20,()=>{}),e=>e===error);
 assert.deepEqual(h.calls,['begin','lock','rollback']);
 for(const [lock,renew] of [[false,true],[true,false]]){
  const f=repositoryHarness(lock,renew);await assert.rejects(f.run('owner',1,async()=>{},'test',20,()=>{}));assert.equal(f.calls.at(-1),'rollback');
 }
});
test('repository emits only supported boundaries in order',async()=>{
 const h=repositoryHarness();const seen:string[]=[];
 await h.run('owner',1,async()=>{},'test',20,(p:string)=>seen.push(p));
 assert.deepEqual(seen,['requested','transaction_callback','lease_locked','work_complete','lease_renewed']);
});
