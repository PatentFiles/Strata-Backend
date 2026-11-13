import test from 'node:test';import assert from 'node:assert/strict';
import {ProductionWorker} from './worker';import {notifyCommittedForwardSignal} from '../forwardTestSignalWake';
import type {ReconcileSchedulingContext,ReconcileSchedulingResult} from './executor';
function fixture(outcomes:(ReconcileSchedulingResult|Error)[]){
 const contexts:ReconcileSchedulingContext[]=[];
 const executor={now:()=>Date.now(),startTiming:()=>()=>{},ledger:{accountId:'acct',readAccount:async()=>{},pool:{query:async()=>({rows:[]})},transaction:async(fn:any)=>fn({},{} )},gate:async()=>{},
  reconcile:async(context:ReconcileSchedulingContext=Object.freeze({origin:'normal',allowEarlyTechnicalLeaseReuse:false}))=>{contexts.push(context);const result=outcomes.shift();if(result instanceof Error)throw result;return result;}};
 const worker=new ProductionWorker(executor as never,60000,()=>{},()=>false);
 return {worker,contexts};
}
test('one source deferral forces next tick normal and clears only settled proof',async()=>{
 const {worker,contexts}=fixture([{technicalRenewal:'deferred'},undefined,new Error('renewal_failed'),{technicalRenewal:'settled'},{technicalRenewal:'deferred'}]);
 await worker.tick('committed_signal');await worker.tick('committed_signal');await assert.rejects(worker.tick('committed_signal'));await worker.tick('committed_signal');await worker.tick('committed_signal');
 assert.deepEqual(contexts.map(c=>c.allowEarlyTechnicalLeaseReuse),[true,false,false,false,true]);assert.deepEqual(contexts.map(c=>c.origin),['committed_signal','normal','normal','normal','committed_signal']);assert.ok(contexts.every(Object.isFrozen));
});
test('partial callback failure conservatively retains debt and STOP does not erase it',async()=>{
 const {worker,contexts}=fixture([new Error('after_reuse_failure'),undefined,{technicalRenewal:'settled'}]);
 await assert.rejects(worker.tick('committed_signal'));worker.stop();await worker.tick('committed_signal');await worker.tick();
 assert.deepEqual(contexts.map(c=>c.allowEarlyTechnicalLeaseReuse),[true,false,false]);
});
test('normal polling, startup and recovery never request early reuse',async()=>{
 const {worker,contexts}=fixture([{technicalRenewal:'settled'},{technicalRenewal:'settled'},{technicalRenewal:'settled'}]);
 await worker.tick();await worker.start();worker.stop();await worker.startRecovery();worker.stop();await worker.tick('committed_signal');
 assert.ok(contexts.every(c=>!c.allowEarlyTechnicalLeaseReuse&&c.origin==='normal'));
});
test('fresh current lease settles reserved debt without unnecessary forced renewal next source tick',async()=>{
 const {worker,contexts}=fixture([{technicalRenewal:'settled'},{technicalRenewal:'settled'}]);await worker.tick('committed_signal');await worker.tick('committed_signal');assert.deepEqual(contexts.map(c=>c.allowEarlyTechnicalLeaseReuse),[true,true]);
});
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));const until=async(f:()=>boolean)=>{const end=Date.now()+2000;while(!f()){if(Date.now()>end)throw Error('scheduler_timeout');await wait(5);}};
test('source flood cannot starve mandatory renewal; STOP cancels queued source tick',async()=>{
 const {worker,contexts}=fixture([{technicalRenewal:'settled'},{technicalRenewal:'deferred'},{technicalRenewal:'settled'}]);
 try{(worker as any).schedule();await until(()=>contexts.length===1);notifyCommittedForwardSignal();await until(()=>contexts.length===2);for(let i=0;i<100;i++)notifyCommittedForwardSignal();await until(()=>contexts.length===3);worker.stop();notifyCommittedForwardSignal();await wait(30);
 assert.deepEqual(contexts.map(c=>c.allowEarlyTechnicalLeaseReuse),[false,true,false]);assert.equal(worker.isScheduled(),false);
 }finally{worker.stop();}
});
