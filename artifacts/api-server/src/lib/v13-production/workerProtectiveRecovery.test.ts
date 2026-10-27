import test from "node:test";
import assert from "node:assert/strict";
import {ProductionWorker,nextSequentialPollDelayMs} from "./worker";
test("worker poll cadence overlaps neither signed reconciliation nor entry and preserves quote-age checks",()=>{
  // Starts are targeted every 2.5 seconds even if the preceding signed
  // exchange reconciliation takes 1.8s (old worker waited an EXTRA 2.5s).
  assert.equal(nextSequentialPollDelayMs(2500,1800),700);
  assert.equal(nextSequentialPollDelayMs(2500,0),2500);
  // A provider stall never creates a zero-delay hammer loop.
  assert.equal(nextSequentialPollDelayMs(2500,4000),250);
});
test("recovery-only owned worker invokes protective UNKNOWN audit before normal reconciliation",async()=>{
 const phases:string[]=[];
 const executor={
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
 const executor={ledger:{readAccount:async()=>{}},reconcile:async()=>{reconcileCalls++;}};
 const worker=new ProductionWorker(executor as never,60000,()=>{reports++;},
  ()=>true,async()=>{throw Error("exchange_history_unavailable");});
 await worker.startRecovery();worker.stop();
 assert.equal(reconcileCalls,0);
 assert.equal(reports,1);
});

test("owner production worker polls newest qualifying paper crosses within APPROVED quote age",async()=>{
 const now=Date.parse("2026-10-26T20:42:39.000Z");
 const queries:string[]=[];const sends:string[]=[];
 const executor={
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
 const executor={
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
