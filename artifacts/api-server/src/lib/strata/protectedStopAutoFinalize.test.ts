import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnedTradingSupervisor} from './personalExecutionSupervisor';
const OWNER='11111111-1111-4111-8111-111111111111',ACCOUNT='synthetic-protected-account';
function fixture(){
 let scheduled=true,exposed=true;
 const calls:{kind:string;exposed?:boolean}[]=[];
 const worker={
  onTickFinished:null as (()=>Promise<void>)|null,
  start:async()=>{calls.push({kind:'start'});scheduled=true;},
  startRecovery:async()=>{calls.push({kind:'recovery'});scheduled=true;},
  stop:()=>{scheduled=false;calls.push({kind:'worker_stop'});},
  isScheduled:()=>scheduled,
 };
 const state={entriesAuthorized:true,accountKill:false};
 const supervisor=createOwnedTradingSupervisor(async()=>({
  ok:true as const,worker,state:state as never,
  disarm:async (action:'STOP'|'KILL')=>{
   calls.push({kind:action,exposed});
   state.entriesAuthorized=false;
   if(action==='KILL')state.accountKill=true;
   return {entriesBlocked:true,managingExposure:action==='STOP'&&exposed};
  },
 }));
 return {worker,calls,state,supervisor,get exposed(){return exposed},
  set exposed(v:boolean){exposed=v},
  start:()=>supervisor.start({userId:OWNER,accountId:ACCOUNT,action:'START'})};
}
test('STOP retains protective worker, forbids new entries, and releases automatically after verified flat readback',async()=>{
 const h=fixture();const start=await h.start();assert.equal(start.ok,true);
 const stopped=await h.supervisor.stop({userId:OWNER,accountId:ACCOUNT,action:'STOP'});
 assert.equal(stopped.workerStopped,true);assert.equal(stopped.managingExposure,true);
 assert.equal(h.supervisor.isScheduled(OWNER,ACCOUNT),true);
 assert.equal(h.state.entriesAuthorized,false);
 assert.equal(typeof h.worker.onTickFinished,'function');
 h.exposed=false;
 await h.worker.onTickFinished?.();
 assert.equal(h.supervisor.isScheduled(OWNER,ACCOUNT),false);
 assert.deepEqual(h.calls.filter(x=>x.kind==='STOP').map(x=>x.exposed),[true,false]);
 assert.equal(h.calls.filter(x=>x.kind==='start').length,0);
});
test('STOP cannot finalize while exposure remains and KILL supersedes protected callback without restarting',async()=>{
 const h=fixture();await h.start();
 await h.supervisor.stop({userId:OWNER,accountId:ACCOUNT,action:'STOP'});
 await h.worker.onTickFinished?.();
 assert.equal(h.supervisor.isScheduled(OWNER,ACCOUNT),true);
 await h.supervisor.stop({userId:OWNER,accountId:ACCOUNT,action:'KILL'});
 assert.equal(h.supervisor.isScheduled(OWNER,ACCOUNT),false);
 assert.equal(h.state.accountKill,true);
 assert.equal(h.worker.onTickFinished,null);
 assert.equal(h.calls.filter(x=>x.kind==='recovery').length,0);
});
test('foreign account cannot STOP or replace another owner protective worker',async()=>{
 const h=fixture();await h.start();
 const r=await h.supervisor.stop({userId:'22222222-2222-4222-8222-222222222222',
  accountId:ACCOUNT,action:'STOP'});
 assert.equal(r.workerStopped,false);
 assert.equal(h.supervisor.isScheduled(OWNER,ACCOUNT),true);
 assert.equal(h.calls.some(x=>x.kind==='STOP'),false);
});
