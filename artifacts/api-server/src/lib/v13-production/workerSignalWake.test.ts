import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionWorker} from './worker';
import {notifyCommittedForwardSignal} from '../forwardTestSignalWake';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const until=async(f:()=>boolean)=>{const end=Date.now()+2000;while(!f()){if(Date.now()>end)throw Error('scheduler_timeout');await wait(5);}};
const schedule=(w:ProductionWorker)=>(w as unknown as {schedule():void}).schedule();
test('committed signal wakes an idle worker without waiting for the polling interval',async()=>{
 const w=new ProductionWorker({} as never,10000);let ticks=0;
 w.tick=async()=>{ticks++;};
 try{schedule(w);await until(()=>ticks===1);notifyCommittedForwardSignal();await until(()=>ticks===2);}
 finally{w.stop();}
 notifyCommittedForwardSignal();await wait(30);assert.equal(ticks,2);
});
test('signal bursts during reconciliation coalesce without concurrent ticks',async()=>{
 const w=new ProductionWorker({} as never,10000);let ticks=0,active=0,max=0,release!:()=>void;
 const held=new Promise<void>(r=>{release=r;});
 w.tick=async()=>{ticks++;active++;max=Math.max(max,active);if(ticks===1)await held;active--;};
 try{schedule(w);await until(()=>ticks===1);
 for(let n=0;n<100;n++)notifyCommittedForwardSignal();
 await wait(30);assert.equal(ticks,1);release();
 await until(()=>ticks===2);await wait(30);assert.equal(ticks,2);assert.equal(max,1);
 }finally{release();w.stop();}
});
test('STOP during an active tick cancels pending wake and scheduling',async()=>{
 const w=new ProductionWorker({} as never,10000);let ticks=0,release!:()=>void;
 const held=new Promise<void>(r=>{release=r;});
 w.tick=async()=>{ticks++;await held;};
 schedule(w);await until(()=>ticks===1);notifyCommittedForwardSignal();w.stop();release();
 await wait(300);notifyCommittedForwardSignal();await wait(30);
 assert.equal(ticks,1);assert.equal(w.isScheduled(),false);
});
