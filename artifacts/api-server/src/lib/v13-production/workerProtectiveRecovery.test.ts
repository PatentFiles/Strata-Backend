import test from "node:test";
import assert from "node:assert/strict";
import {ProductionWorker,nextSequentialPollDelayMs} from "./worker";
test("bounded sequential polling targets the start interval and never busy spins",()=>{
  assert.equal(nextSequentialPollDelayMs(2500,1800),700);
  assert.equal(nextSequentialPollDelayMs(2500,0),2500);
  assert.equal(nextSequentialPollDelayMs(2500,4000),250);
});
test("recovery-only owned worker invokes protective UNKNOWN audit before normal reconciliation",async()=>{
 const phases:string[]=[];
 const executor={startTiming:()=>()=>{},
  ledger:{readAccount:async()=>{phases.push("read-account");}},
  reconcile:async()=>{phases.push("reconcile");},
 };
 const worker=new ProductionWorker(executor as never,60000,()=>{throw Error("unexpected")},
   ()=>false,async()=>{phases.push("protective-read");});
 await worker.startRecovery();worker.stop();
 assert.deepEqual(phases,["read-account","protective-read","reconcile"]);
});
test("failed protective history cannot be silently bypassed by normal reconcile",async()=>{
 let reconcileCalls=0,reports=0;
 const executor={startTiming:()=>()=>{},ledger:{readAccount:async()=>{}},reconcile:async()=>{reconcileCalls++;}};
 const worker=new ProductionWorker(executor as never,60000,()=>{reports++;},
  ()=>true,async()=>{throw Error("exchange_history_unavailable");});
 await worker.startRecovery();worker.stop();
 assert.equal(reconcileCalls,0);
 assert.equal(reports,1);
});

test("owner production worker polls newest qualifying paper crosses within APPROVED quote age",async()=>{
 const now=Date.parse("2026-10-26T20:42:39.000Z");
 const queries:string[]=[];const sends:string[]=[];
 const executor={startTiming:()=>()=>{},
  accountOwnerUserId:"11111111-1111-4111-8111-111111111111",
  now:()=>now,
  ledger:{accountId:"acct-test",pool:{query:async(sql:string,params:unknown[])=>{
   queries.push(sql);
   if(sql.includes("FROM v13_production_position"))return {rows:[]};
   assert.match(sql,/JOIN v13_live_money_policy p/);
   assert.match(sql,/p\.max_quote_age_ms/);
   assert.match(sql,/ORDER BY e\.evaluated_at DESC,e\.id DESC/);
   assert.deepEqual(params,["acct-test",new Date(now)]);
   return {rows:[{id:"fresh-scout"},{id:"older-scout"}]};
  }}},
  reconcile:async()=>{},
  prepareEntry:async(id:string)=>id,
  dispatch:async(id:string)=>{sends.push(id);},
 };
 const worker=new ProductionWorker(executor as never,2_500,()=>{throw Error("unexpected")},
  ()=>true);
 await worker.tick();
 assert.deepEqual(sends,["fresh-scout","older-scout"]);
 assert.equal(queries.length,2);
});
test("closed entry gate continues reconciliation and never selects or submits a SCOUT",async()=>{
 const reasons:string[]=[];let reconciled=0,entriesQueried=0;
 const executor={startTiming:()=>()=>{},
  ledger:{accountId:"acct-test",pool:{query:async(sql:string)=>{
   if(sql.includes("FROM v13_production_position"))return {rows:[]};
   entriesQueried++;return {rows:[{id:"scout"}]};
  }}},
  reconcile:async()=>{reconciled++;},
 };
 const worker=new ProductionWorker(executor as never,2_500,(error)=>{
  reasons.push((error as Error).message);
 },()=>false);
 await worker.tick();await worker.tick();
 assert.equal(reconciled,2);
 assert.equal(entriesQueried,0);
 assert.deepEqual(reasons,["production_entries_not_authorized"]);
});

test("failed seen-trace is retried and cannot silently permit an entry",async()=>{
 let writes=0,entries=0,sweeps=0;
 const id='11111111-1111-4111-8111-111111111111';
 const executor={startTiming:()=>()=>{},accountOwnerUserId:'owner',now:()=>100000,
  ledger:{accountId:'acct',pool:{query:async(sql:string)=>({rows:sql.includes('FROM v13_production_position')?[]:[{id}]})}},
  reconcile:async()=>{},prepareEntry:async()=>{entries++;return 'intent';},dispatch:async()=>{},
 };
 const trace={record:async()=>{writes++;return writes>1;},sweep:async()=>{sweeps++;return 0;}};
 const worker=new ProductionWorker(executor as never,2500,()=>{},()=>true,async()=>{},undefined,trace);
 await assert.rejects(worker.tick(),/production_signal_trace_unavailable/);
 assert.equal(entries,0);
 await worker.tick();
 assert.equal(entries,1);
 assert.equal(writes,4,'seen failure is not cached; all three phases are retried/persisted');
 assert.equal(sweeps,1);
});

test("held entries still audit unseen signals without attempting orders",async()=>{
 let sweeps=0,entries=0;
 const executor={startTiming:()=>()=>{},now:()=>100000,ledger:{accountId:'acct',pool:{query:async()=>({rows:[]})}},
  reconcile:async()=>{},prepareEntry:async()=>{entries++;},dispatch:async()=>{entries++;}};
 const worker=new ProductionWorker(executor as never,2500,()=>{},()=>false,async()=>{},undefined,
  {record:async()=>true,sweep:async()=>{sweeps++;return 0;}});
 await worker.tick();
 assert.equal(sweeps,1);assert.equal(entries,0);
});
