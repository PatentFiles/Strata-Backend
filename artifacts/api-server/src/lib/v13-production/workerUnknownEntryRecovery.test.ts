import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionWorker} from './worker';
import {ProductionExecutor} from './executor';
const wait=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}throw Error('condition_not_reached');};
function fixture(){
 const executor={reconcile:async()=>{},ledger:{readAccount:async()=>({})}} as unknown as ProductionExecutor;
 return new ProductionWorker(executor,1000);
}
test('unhandled history failure retains original stop',async()=>{
 const w=fixture();w.tick=async()=>{throw Error('personal_exchange_history_unreconciled');};
 try{await w.startRecovery();await wait(()=>!w.isScheduled());}finally{w.stop();}
});
test('trusted successful entry recovery keeps same scheduler only',async()=>{
 const w=fixture();let calls=0;
 w.tick=async()=>{throw Error('personal_exchange_history_unreconciled');};
 w.recoverUnreconciledEntry=async()=>{calls++;return true;};
 try{await w.startRecovery();await wait(()=>calls===1);assert.equal(w.isScheduled(),true);assert.equal(calls,1);}finally{w.stop();}
});
test('refused or thrown recovery stops, never retries',async()=>{
 for(const throws of [false,true]){
  const w=fixture();let calls=0;w.tick=async()=>{throw Error('personal_exchange_history_unreconciled');};
  w.recoverUnreconciledEntry=async()=>{calls++;if(throws)throw Error('uncertain_commit');return false;};
  try{await w.startRecovery();await wait(()=>!w.isScheduled());assert.equal(calls,1);}finally{w.stop();}
 }
});
test('any error in held mode stops rather than entering normal error loop',async()=>{
 const w=fixture();let calls=0;w.heldRecoveryActive=()=>true;
 w.tick=async()=>{throw Error('other_failure');};w.recoverUnreconciledEntry=async()=>{calls++;return false;};
 try{await w.startRecovery();await wait(()=>!w.isScheduled());assert.equal(calls,1);}finally{w.stop();}
});
test('owner stop during successful async recovery cannot restart worker',async()=>{
 const w=fixture();let resolve!:(value:boolean)=>void,entered=false;
 w.tick=async()=>{throw Error('personal_exchange_history_unreconciled');};
 w.recoverUnreconciledEntry=()=>{entered=true;return new Promise(r=>{resolve=r;});};
 await w.startRecovery();await wait(()=>entered);w.stop();resolve(true);
 await new Promise(r=>setTimeout(r,10));assert.equal(w.isScheduled(),false);
});
test('held executor never invokes ordinary ledger or renewal callback',async()=>{
 let ordinary=0,held=0,renewed=0;
 const ledger={accountId:'a',readReconcileAccount:async()=>({account:{revision:'1',subaccount:'1',exchange_index:'2',key_fingerprint:'key'},earliest:null}),
  reconcile:async()=>{ordinary++;return {accountId:'a',observationId:'ordinary'};}};
 const exchange={mode:'LIVE',snapshot:async()=>({observedAtMs:1000})};
 const e=new ProductionExecutor(ledger as never,exchange as never,()=>1000);
 e.afterReconcile=async()=>{renewed++;};
 e.heldReconcile=async()=>{held++;return {accountId:'a',observationId:'held'};};
 await e.reconcile();await e.reconcile();assert.equal(held,2);assert.equal(ordinary,0);assert.equal(renewed,0);
});
test('held ledger failure cannot invoke renewal',async()=>{
 let renewed=0;
 const ledger={accountId:'a',readReconcileAccount:async()=>({account:{revision:'1',subaccount:'1',exchange_index:'2',key_fingerprint:'key'},earliest:null})};
 const e=new ProductionExecutor(ledger as never,{mode:'LIVE',snapshot:async()=>({observedAtMs:1000})} as never,()=>1000);
 e.afterReconcile=async()=>{renewed++;};e.heldReconcile=async()=>{throw Error('held_commit_uncertain');};
 await assert.rejects(e.reconcile(),/held_commit_uncertain/);assert.equal(renewed,0);
});
