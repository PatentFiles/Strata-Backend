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

// Trace precision does not change discovery SQL, executor admission or wire gates.
import {signalTraceSourceAgeMs} from './signalTraceSourceAge';
test('trace retains pg Date milliseconds and matches ISO source timestamps',()=>{
 const iso='2026-10-31T04:47:52.373Z';
 const now=Date.parse('2026-10-31T04:47:55.125Z');
 assert.equal(signalTraceSourceAgeMs(new Date(iso),now),2752);
 assert.equal(signalTraceSourceAgeMs(iso,now),2752);
 assert.equal(signalTraceSourceAgeMs('2026-10-30T23:47:52.373-05:00',now),2752);
 assert.equal(now-Date.parse(String(new Date(iso))),3125);
 assert.equal(signalTraceSourceAgeMs(new Date(now),now),0);
});
test('trace reports invalid, missing and future source ages honestly as unknown',()=>{
 const now=Date.parse('2026-10-31T04:47:55.125Z');
 for(const value of [null,undefined,0,{},new Date(NaN),'not a date',
  '2026-02-30T00:00:00Z','2026-10-31T04:47:52.373',
  '2026-10-31T24:00:00Z','2026-10-31T04:47:52.373+24:00',
  new Date(now+1),new Date(now+1).toISOString()])assert.equal(signalTraceSourceAgeMs(value,now),null);
 for(const invalidNow of [NaN,Infinity,-1,now+.5])assert.equal(signalTraceSourceAgeMs(new Date(now),invalidNow),null);
 assert.equal(signalTraceSourceAgeMs({toString(){throw Error('not touched')}},now),null);
});
