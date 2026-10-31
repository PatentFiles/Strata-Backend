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
  evaluated_at:new Date(now-5001),entry_policy_version:V13_LEGACY_ENTRY_POLICY,
  market_ticker:"KXBTC15M-TEST",target:77035,btc_price:77045,previous_side:"DOWN",
  velocity:38,signed_buffer:10,up_offer:.48,down_offer:.53,entry_offer:.48,
  btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0};
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

test("real prepare path preserves price refusal and records normalized book for each side",async()=>{
 for(const direction of ["DOWN","UP"] as const){
  const now=10000,down=direction==="DOWN";
  const source={evaluation_source:"paper",strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,
   strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,qualifying_trigger:true,fresh_cross:true,
   position_was_open:false,crossing_key:"cross",feed_freshness:"current",signal:"SCOUT",direction,
   evaluated_at:new Date(now-1000),entry_policy_version:V13_LEGACY_ENTRY_POLICY,
   market_ticker:"KXBTC15M-TEST",target:77035,btc_price:down?77025:77045,
   previous_side:down?"UP":"DOWN",velocity:down?-38:38,signed_buffer:down?-10:10,
   up_offer:down?.53:.48,down_offer:down?.48:.53,entry_offer:.48,
   btc_provider_age_ms:793,btc_receive_age_ms:0,market_age_ms:0};
  let writes=0,bookReads=0;
  const tx={query:async(sql:string)=>{
   if(sql.startsWith("INSERT")||sql.startsWith("UPDATE")){writes++;throw Error("unexpected_write");}
   if(sql.includes("FROM forward_test_evaluations"))return {rows:[source]};
   if(sql.includes("AS total_loss"))return {rows:[{basis:"0",total_loss:"0",daily_loss:"0",open:0}]};
   if(sql.includes("FROM strata_configured_stake"))return {rows:[{configured_stake_cents:500,revision:1}]};
   return {rows:[]};
  }};
  const ledger={accountId:"account",pool:{query:async()=>({rows:[source]})},
   transaction:async(fn:(tx:unknown,a:unknown)=>unknown)=>fn(tx,{id:"account",cash_micros:"25000000",reserved_micros:"0"}),
   policy:async()=>({entryPolicyVersion:V13_LEGACY_ENTRY_POLICY,maxQuoteAgeMs:5000,
    capitalLimitCents:2500,maxEntryStakeCents:500,strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash:V13_CHAMPION_PARAMETER_HASH})};
  const executor=new ProductionExecutor(ledger as never,{mode:"SIMULATION",market:async(_market:string,side:string)=>{
   bookReads++;assert.equal(side,down?"NO":"YES");
   return {bestAskDollars:"0.4900",bestBidDollars:"0.4800",observedAtMs:now,
    asks:[{priceDollars:"0.4900",availableContracts:"10"}],fee:{}};
  }} as never,()=>now);
  executor.gate=async()=>{};
  const events:StageTiming[]=[];executor.timingObserver=e=>{events.push(e);throw Error("observer_failure")};
  await assert.rejects(executor.prepareEntry("evaluation"),/live_money_best_ask_above_signal_ceiling/);
  assert.equal(writes,0);assert.equal(bookReads,1);
  const d=events.find(e=>e.stage==="prepare_entry")!;
  assert.equal(d.reason,"live_money_best_ask_above_signal_ceiling");
  assert.equal(d.entryPrice?.effectiveCeiling,.48);assert.equal(d.entryPrice?.bestAskDollars,.49);
 }
});
