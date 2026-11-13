import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionWorker} from './worker';
import {notifyCommittedForwardSignal} from '../forwardTestSignalWake';
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(f:()=>boolean){const end=Date.now()+2000;while(!f()){if(Date.now()>end)throw Error('lifecycle_test_timeout');await wait(2);}}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
 const held=deferred();let reconciles=0,gates=0,ticks=0;
 const executor={ledger:{readAccount:async()=>({}),transaction:async(fn:(tx:unknown,a:unknown)=>Promise<void>)=>fn({}, {})},
  reconcile:async()=>{reconciles++;await held.promise;},gate:async()=>{gates++;}};
 const worker=new ProductionWorker(executor as never,60_000);
 worker.tick=async()=>{ticks++;};
 return {worker,held,counts:()=>({reconciles,gates,ticks})};
}
for(const mode of ['start','startRecovery'] as const)test(`STOP during pending ${mode} prevents later scheduling`,async()=>{
 const f=fixture();
 try{
  const pending=f.worker[mode]();await until(()=>f.counts().reconciles===1);
  f.worker.stop();f.held.resolve();await pending;await wait(20);
  assert.equal(f.worker.isScheduled(),false);assert.equal(f.counts().ticks,0);
  notifyCommittedForwardSignal();await wait(20);assert.equal(f.counts().ticks,0);
 }finally{f.held.resolve();f.worker.stop();}
});
test('concurrent starts share one startup and one scheduler',async()=>{
 const f=fixture();
 try{
  const first=f.worker.start(),second=f.worker.start();
  await until(()=>f.counts().reconciles>=1);f.held.resolve();await Promise.all([first,second]);
  await until(()=>f.counts().ticks>=1);await wait(20);
  assert.equal(f.counts().reconciles,1);assert.equal(f.counts().gates,1);assert.equal(f.counts().ticks,1);
 }finally{f.held.resolve();f.worker.stop();}
});
test('old loop completion cannot install a timer after STOP and restart',async()=>{
 const f=fixture(),old=deferred();let ticks=0;
 f.worker.tick=async()=>{ticks++;if(ticks===1)await old.promise;};
 try{
  f.held.resolve();await f.worker.start();await until(()=>ticks===1);
  notifyCommittedForwardSignal();f.worker.stop();await f.worker.start();await until(()=>ticks===2);
  old.resolve();await wait(30);assert.equal(ticks,2,'the stopped generation must discard its pending wake');
 }finally{old.resolve();f.worker.stop();}
});
test('old rejected loop cannot stop a restarted scheduler',async()=>{
 const f=fixture(),old=deferred();let ticks=0;
 f.worker.tick=async()=>{ticks++;if(ticks===1){await old.promise;throw Error('stale_worker_fence');}};
 try{
  f.held.resolve();await f.worker.start();await until(()=>ticks===1);
  f.worker.stop();await f.worker.start();await until(()=>ticks===2);
  old.resolve();await wait(20);assert.equal(f.worker.isScheduled(),true);
 }finally{old.resolve();f.worker.stop();}
});

test('late startup rejection after STOP cannot reject a newer startup',async()=>{
 const held=deferred();let reconciles=0;
 const worker=new ProductionWorker({ledger:{transaction:async(fn:(tx:unknown,a:unknown)=>Promise<void>)=>fn({}, {})},
  gate:async()=>{},reconcile:async()=>{reconciles++;if(reconciles===1){await held.promise;throw Error('old_start_failed');}}} as never,60000);
 worker.tick=async()=>{};
 try{
  const old=worker.start();await until(()=>reconciles===1);worker.stop();
  await worker.start();assert.equal(worker.isScheduled(),true);
  held.resolve();await old;assert.equal(worker.isScheduled(),true);
 }finally{held.resolve();worker.stop();}
});
for(const outcome of ['refused','throws'] as const)test(`stopped async recovery ${outcome} cannot stop new scheduler`,async()=>{
 const f=fixture(),held=deferred();let ticks=0,recoveries=0;
 f.worker.tick=async()=>{ticks++;if(ticks===1)throw Error('personal_exchange_history_unreconciled');};
 f.worker.recoverUnreconciledEntry=async()=>{recoveries++;await held.promise;if(outcome==='throws')throw Error('old_recovery_failed');return false;};
 try{
  f.held.resolve();await f.worker.start();await until(()=>recoveries===1);f.worker.stop();
  await f.worker.start();await until(()=>ticks===2);held.resolve();await wait(20);
  assert.equal(f.worker.isScheduled(),true);
 }finally{held.resolve();f.worker.stop();}
});
for(const firstMode of ['start','startRecovery'] as const)test(`concurrent mixed starts keep ${firstMode} mode until explicit STOP`,async()=>{
 const f=fixture();
 try{
  const first=f.worker[firstMode]();
  const other=f.worker[firstMode==='start'?'startRecovery':'start']();
  await until(()=>f.counts().reconciles===1);f.held.resolve();await Promise.all([first,other]);
  await until(()=>f.counts().ticks===1);
  assert.equal(f.counts().reconciles,1);assert.equal(f.counts().gates,firstMode==='start'?1:0);
  notifyCommittedForwardSignal();await wait(20);
  assert.equal(f.counts().ticks,firstMode==='start'?2:1,'recovery mode must ignore entry wake notifications');
 }finally{f.held.resolve();f.worker.stop();}
});
