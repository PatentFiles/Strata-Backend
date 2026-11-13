import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionWorker} from './worker';
import {notifyCommittedForwardSignal} from '../forwardTestSignalWake';
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const until=async(f:()=>boolean)=>{const end=Date.now()+2000;while(!f()){if(Date.now()>end)throw Error('scheduler_timeout');await wait(2);}};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
function fixture(sweep:()=>Promise<number>, entriesOpen=()=>false){
 let clock=100000,reconciles=0,prepared=0,dispatched=0;
 const phases:string[]=[];const reports:string[]=[];
 const executor={startTiming:()=>()=>{},accountOwnerUserId:'owner',now:()=>clock,
  ledger:{accountId:'acct',pool:{query:async(sql:string)=>({rows:sql.includes('FROM v13_production_position')?[]:[{id:'source',evaluated_at:new Date(clock)}]})}},
  reconcile:async()=>{reconciles++;},prepareEntry:async()=>{prepared++;return 'intent';},dispatch:async()=>{dispatched++;}};
 const trace={record:async({phase}:{phase:string})=>{phases.push(phase);return true;},sweep};
 const worker=new ProductionWorker(executor as never,10000,e=>reports.push((e as Error).message),entriesOpen,async()=>{},undefined,trace);
 return {worker,trace,phases,reports,get reconciles(){return reconciles;},get prepared(){return prepared;},get dispatched(){return dispatched;},advance:(ms:number)=>{clock+=ms;}};
}
const schedule=(w:ProductionWorker)=>(w as unknown as {schedule():void}).schedule();
test('held catch-up sweep does not hold next committed-signal trading wake',async()=>{
 const held=deferred();let sweeps=0;const f=fixture(async()=>{sweeps++;await held.promise;return 0;});
 try{schedule(f.worker);await until(()=>sweeps===1);notifyCommittedForwardSignal();
  await until(()=>f.reconciles===2);assert.equal(sweeps,1);
 }finally{f.worker.stop();held.resolve();}
});
test('slow audit is single-flight even across multiple elapsed audit intervals',async()=>{
 const held=deferred();let sweeps=0;const f=fixture(async()=>{sweeps++;await held.promise;return 0;});
 try{await f.worker.tick();for(let n=0;n<10;n++){f.advance(30001);await f.worker.tick();}
  assert.equal(f.reconciles,11);assert.equal(sweeps,1);
 }finally{f.worker.stop();held.resolve();}
});
test('completed audit remains rate-limited and later eligible tick starts next audit',async()=>{
 let sweeps=0;const f=fixture(async()=>{sweeps++;return 0;});
 try{await f.worker.tick();await wait(0);f.advance(29999);await f.worker.tick();assert.equal(sweeps,1);
  f.advance(1);await f.worker.tick();await wait(0);assert.equal(sweeps,2);
 }finally{f.worker.stop();}
});
test('audit rejection is caught, sanitized, and does not stop later ticks',async()=>{
 let sweeps=0;const f=fixture(async()=>{sweeps++;throw Error('private SQL payload');});
 try{await f.worker.tick();await wait(0);f.advance(30000);await f.worker.tick();await wait(0);
  assert.equal(f.reconciles,2);assert.equal(sweeps,2);
  assert.equal(f.reports.filter(x=>x==='production_signal_trace_sweep_unavailable').length,2);
  assert.ok(!f.reports.some(x=>x.includes('private')));
 }finally{f.worker.stop();}
});
test('STOP during active audit cannot wake, submit, or schedule another audit',async()=>{
 const held=deferred();let sweeps=0;const f=fixture(async()=>{sweeps++;await held.promise;return 0;});
 schedule(f.worker);await until(()=>sweeps===1);f.worker.stop();held.resolve();notifyCommittedForwardSignal();await wait(30);
 assert.equal(f.reconciles,1);assert.equal(f.prepared,0);assert.equal(f.dispatched,0);assert.equal(sweeps,1);assert.equal(f.worker.isScheduled(),false);
 f.advance(30001);await f.worker.tick();await wait(0);assert.equal(sweeps,1);
});
test('durable per-signal decision receipt still blocks prepare and failure still prevents entry',async()=>{
 const held=deferred();const f=fixture(async()=>0,()=>true);let writes=0;
 f.trace.record=async({phase})=>{f.phases.push(phase);writes++;await held.promise;return false;};
 const tick=f.worker.tick();await until(()=>writes===1);assert.equal(f.prepared,0);assert.equal(f.dispatched,0);
 held.resolve();await assert.rejects(tick,/production_signal_trace_unavailable/);assert.equal(f.prepared,0);assert.equal(f.dispatched,0);f.worker.stop();
});
test('audit offload preserves recovery/reconcile/entry trace and dispatch ordering',async()=>{
 const held=deferred();const f=fixture(async()=>{await held.promise;return 0;},()=>true);
 try{await f.worker.tick();assert.equal(f.reconciles,1);assert.equal(f.prepared,1);assert.equal(f.dispatched,1);
  assert.deepEqual(f.phases,['QUALIFYING_SEEN','ENTRY_PREPARED','DISPATCH_COMPLETED']);
 }finally{f.worker.stop();held.resolve();}
});
