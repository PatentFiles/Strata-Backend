import test from "node:test";
import assert from "node:assert/strict";
import {ProductionExecutor} from "./executor";
import type {StageTiming} from "./stageTiming";
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_LEGACY_ENTRY_POLICY} from "@workspace/v13-strategy";

test("reconciliation stages preserve snapshot / commit / callback order with failing observers",async()=>{
 const order:string[]=[];
 const snapshot={identity:{}};
 const ledger={accountId:"account",readAccount:async()=>({id:"account"}),
  pool:{query:async()=>({rows:[{earliest:null}]})},
  reconcile:async()=>{order.push("commit")}};
 const exchange={mode:"SIMULATION",snapshot:async()=>{order.push("snapshot");return snapshot}};
 const executor=new ProductionExecutor(ledger as never,exchange as never,()=>1000);
 executor.afterReconcile=async()=>{order.push("after")};
 const events:StageTiming[]=[];
 executor.timingObserver=event=>{events.push(event);throw Error("observer_failure")};
 await executor.reconcile();
 assert.deepEqual(order,["snapshot","commit","after"]);
 assert.deepEqual(events.map(e=>e.stage),["signed_snapshot","ledger_reconcile_commit","after_reconcile","reconciliation"]);
 assert.ok(events.every(e=>e.mode==="SIMULATION"&&e.outcome==="completed"));
});
test("failed ledger reconciliation never renews authority and emits no successful afterReconcile",async()=>{
 let after=0;const error=Error("production_snapshot_incomplete");
 const executor=new ProductionExecutor({accountId:"account",readAccount:async()=>({id:"account"}),
  pool:{query:async()=>({rows:[{}]})},reconcile:async()=>{throw error}} as never,
  {mode:"SIMULATION",snapshot:async()=>({})} as never,()=>1000);
 const events:StageTiming[]=[];executor.timingObserver=e=>{events.push(e)};
 executor.afterReconcile=async()=>{after++};
 await assert.rejects(executor.reconcile(),e=>e===error);
 assert.equal(after,0);assert.deepEqual(events.map(e=>[e.stage,e.outcome]),[
  ["signed_snapshot","completed"],["ledger_reconcile_commit","rejected"],["reconciliation","rejected"]]);
});
test("5001ms source remains rejected under the unchanged five-second policy and reports exact age",async()=>{
 const now=10000;
 const source={evaluation_source:"paper",strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
  strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,qualifying_trigger:true,fresh_cross:true,
  position_was_open:false,crossing_key:"cross",feed_freshness:"current",signal:"SCOUT",direction:"UP",
  evaluated_at:new Date(now-5001),entry_policy_version:V13_LEGACY_ENTRY_POLICY};
 const ledger={accountId:"account",pool:{query:async()=>({rows:[source]})},
  transaction:async(fn:(tx:unknown,a:unknown)=>unknown)=>fn({query:async()=>({rows:[]})},{id:"account"}),
  policy:async()=>({entryPolicyVersion:V13_LEGACY_ENTRY_POLICY,maxQuoteAgeMs:5000})};
 let posts=0;
 const executor=new ProductionExecutor(ledger as never,{mode:"SIMULATION",market:async()=>({}),submit:async()=>{posts++}} as never,()=>now);
 executor.gate=async()=>{};
 const events:StageTiming[]=[];executor.timingObserver=e=>{events.push(e);return new Promise<void>(()=>{})};
 await assert.rejects(executor.prepareEntry("evaluation"),/production_evaluation_stale/);
 assert.equal(posts,0);
 assert.deepEqual(events.map(e=>[e.stage,e.outcome,e.reason]),[
  ["evaluation_age_admission","rejected","production_evaluation_stale"],
  ["prepare_entry","rejected","production_evaluation_stale"]]);
 assert.equal(events[0]!.sourceAgeMs,5001);
});
