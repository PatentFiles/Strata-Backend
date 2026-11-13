import test from "node:test";
import assert from "node:assert/strict";
import {ProductionWorker} from "./worker";
import {notifyCommittedForwardSignal,type CommittedForwardSourceHint} from "../forwardTestSignalWake";
import {CommittedPublicMetadataCoordinator,type MetadataPrefetchAttempt} from "../strata/committedPublicMetadata";
import {createEntryMetadataSnapshot} from "../strata/entryMetadataSnapshot";
const market="KXBTC15M-26NOV021145-00",event="KXBTC15M-26NOV021145",at=Date.parse("2026-11-02T11:31:00Z");
const scope={accountId:"account",ownerId:"owner",holderId:"holder",releaseSha:"a".repeat(40),policyHash:"b".repeat(64),fence:"1"};
const hint:CommittedForwardSourceHint={evaluationId:"evaluation",marketTicker:market,evaluatedAtMs:at-100,committedAtMs:at,qualifyingTrigger:true,btcProviderAgeMs:100,btcReceiveAgeMs:0,marketAgeMs:0};
const paths=[`/markets/${market}`,"/series/KXBTC15M","/series/fee_changes?series_ticker=KXBTC15M&show_historical=false",`/events/${event}`,`/events/fee_changes?event_ticker=${event}&limit=100`];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const turn=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const until=async(f:()=>boolean)=>{for(let i=0;!f();i++){if(i>200)throw Error("test_timeout");await new Promise(r=>setTimeout(r,1));}};
function fixture(mode="ok"){
 const calls:string[]=[],order:string[]=[],errors:unknown[]=[],held=deferred();let current:MetadataPrefetchAttempt|null=null,open=true,prepares=0,dispatches=0,nowReads=0;
 const fetchImpl=(async(input)=>{const path=String(input).replace("https://external-api.kalshi.com/trade-api/v2","");calls.push(path);order.push("public");
  if(mode==="provider-failure")throw Error("metadata_failed");
  return Response.json(path===paths[0]?{market:{ticker:market,event_ticker:event,exchange_index:2}}:{});
 }) as typeof fetch;
 const c=new CommittedPublicMetadataCoordinator(fetchImpl,()=>at,()=>0);
 const executor={now:()=>{nowReads++;return at;},startTiming:()=>()=>{},accountOwnerUserId:"owner",ledger:{accountId:"account",pool:{query:async(sql:string)=>({rows:sql.includes("v13_production_position")?[]:[{id:"evaluation",evaluated_at:new Date(hint.evaluatedAtMs)}]})}},
  prefetchCommittedPublicMetadata:(h:CommittedForwardSourceHint)=>{current=c.start(scope,h);return current;},
  reconcile:async()=>{order.push("reconcile-start");await held.promise;order.push("reconcile-end");if(mode==="authority-failure"||mode==="provider-failure")throw Error("stale_worker_fence");},
  prepareEntry:async()=>{prepares++;order.push("prepare");const snapshot=current!.consume(scope,hint);await Promise.all(paths.map(snapshot.read));return "intent";},
  dispatch:async()=>{dispatches++;order.push("final");const fresh=createEntryMetadataSnapshot(market,fetchImpl);await Promise.all(paths.map(fresh.read));worker.stop();},
 };
 const worker=new ProductionWorker(executor as never,60_000,e=>{errors.push(e);worker.stop();},()=>open,
   async()=>{order.push("recover");if(mode==="unknown")throw Error("production_uncertain_order_blocks_mutation");});
 return {worker,c,calls,order,errors,held,start:()=>{(worker as unknown as {schedule():void}).schedule();},stop:()=>{open=false;worker.stop();},current:()=>current,counts:()=>({prepares,dispatches,nowReads})};
}
test("actual worker accepts typed wake DURING mandatory reconciliation and consumes once only in prepare; final repeats five reads",async()=>{
 const f=fixture();try{f.start();await until(()=>f.order.includes("reconcile-start"));notifyCommittedForwardSignal(hint);
 await until(()=>f.calls.length===5);assert.equal(f.order.includes("reconcile-end"),false);assert.equal(f.counts().prepares,0);
 f.held.resolve();await until(()=>f.counts().dispatches===1);await until(()=>!f.worker.isScheduled());await turn();
 assert.equal(f.calls.length,10);assert.equal(f.counts().prepares,1);assert.deepEqual(f.errors,[]);assert.equal(f.c.diagnostics().accounts,0);
 assert.ok(f.order.indexOf("recover")<f.order.indexOf("reconcile-start"));assert.ok(f.order.indexOf("reconcile-end")<f.order.indexOf("prepare"));
 }finally{f.stop();f.held.resolve();}
});
test("reconciliation fence/authority failure wins over an already-failed speculative provider read; no prepare or dispatch",async()=>{
 const f=fixture("provider-failure");try{f.start();await until(()=>f.order.includes("reconcile-start"));notifyCommittedForwardSignal(hint);await until(()=>f.calls.length===3);
 f.held.resolve();await until(()=>f.errors.length===1);assert.equal((f.errors[0] as Error).message,"stale_worker_fence");assert.equal(f.counts().prepares,0);assert.equal(f.counts().dispatches,0);await turn();assert.equal(f.c.diagnostics().accounts,0);
 }finally{f.stop();f.held.resolve();}
});
test("STOP/revoked entries while reconciliation waits discards prefetched data and sends nothing",async()=>{
 const f=fixture();try{f.start();await until(()=>f.order.includes("reconcile-start"));notifyCommittedForwardSignal(hint);await until(()=>f.calls.length===5);f.stop();f.held.resolve();await until(()=>f.order.includes("reconcile-end"));await turn();
 assert.equal(f.counts().prepares,0);assert.equal(f.counts().dispatches,0);assert.equal(f.calls.length,5);assert.equal(f.c.diagnostics().accounts,0);
 }finally{f.stop();f.held.resolve();}
});
test("UNKNOWN protective recovery failure precedes reconciliation and any public speculation",async()=>{
 const f=fixture("unknown");(f.worker as unknown as {pendingSourceHint:CommittedForwardSourceHint}).pendingSourceHint=hint;
 await assert.rejects(f.worker.tick("committed_signal"),/uncertain_order/);assert.equal(f.calls.length,0);assert.equal(f.order.includes("reconcile-start"),false);assert.equal(f.counts().dispatches,0);
});
test("new-source wake invalidates old attempt rather than sharing by market or starting a second concurrent attempt",async()=>{
 const f=fixture();try{f.start();await until(()=>f.order.includes("reconcile-start"));notifyCommittedForwardSignal(hint);await until(()=>f.calls.length===5);
 notifyCommittedForwardSignal({...hint,evaluationId:"next-source"});await assert.rejects(f.current()!.consume(scope,hint).read(paths[0]),/source_changed/);assert.equal(f.calls.length,5);f.stop();f.held.resolve();await turn();
 assert.equal(f.counts().dispatches,0);
 }finally{f.stop();f.held.resolve();}
});

test("abort-ignoring speculative requests cannot block the next mandatory recovery/reconcile or create replacement work",async()=>{
 let calls=0,reconciles=0,recoveries=0;const signals:AbortSignal[]=[];
 const c=new CommittedPublicMetadataCoordinator((async(_input,init)=>{calls++;signals.push(init!.signal!);return new Promise<Response>(()=>{});}) as typeof fetch,()=>at,()=>0);
 const executor={now:()=>at,startTiming:()=>()=>{},ledger:{accountId:"account",pool:{query:async()=>({rows:[]})}},
   prefetchCommittedPublicMetadata:(h:CommittedForwardSourceHint)=>c.start(scope,h),reconcile:async()=>{reconciles++;await turn();}};
 const worker=new ProductionWorker(executor as never,60_000,()=>{},()=>false,async()=>{recoveries++;});
 (worker as unknown as {pendingSourceHint:CommittedForwardSourceHint}).pendingSourceHint=hint;
 await worker.tick("committed_signal");assert.equal(calls,3);assert.equal(signals.every(s=>s.aborted),true);
 for(let n=0;n<10;n++){
  (worker as unknown as {pendingSourceHint:CommittedForwardSourceHint}).pendingSourceHint={...hint,evaluationId:"different-"+n};
  await worker.tick("committed_signal");
 }
 worker.stop();assert.equal(reconciles,11);assert.equal(recoveries,11);assert.equal(calls,3);
 assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.diagnostics().accounts,1);assert.equal(c.diagnostics().queuedRequests,0);
});

import {ProductionExecutor} from "./executor";
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_LEGACY_ENTRY_POLICY} from "@workspace/v13-strategy";
test("actual executor source denial remains ahead of metadata and original 5001ms denial/clock count are unchanged",async()=>{
 const source={evaluation_source:"paper",strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
  qualifying_trigger:true,fresh_cross:true,position_was_open:false,crossing_key:"cross",feed_freshness:"current",signal:"SCOUT",direction:"UP",
  evaluated_at:new Date(at-5001),entry_policy_version:V13_LEGACY_ENTRY_POLICY,market_ticker:market,target:77035,btc_price:77045,previous_side:"DOWN",
  velocity:38,signed_buffer:10,up_offer:.48,down_offer:.53,entry_offer:.48,btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0};
 let clockReads=0,marketReads=0,submits=0,context:unknown;
 const ledger={accountId:"account",pool:{query:async()=>({rows:[source]})},transaction:async(fn:(tx:unknown,a:unknown)=>unknown)=>fn({query:async()=>({rows:[]})},{id:"account"}),policy:async()=>({entryPolicyVersion:V13_LEGACY_ENTRY_POLICY,maxQuoteAgeMs:5000})};
 const e=new ProductionExecutor(ledger as never,{mode:"SIMULATION",market:async(_market:string,_side:string,ctx:unknown)=>{marketReads++;context=ctx;return {};},submit:async()=>{submits++;}} as never,()=>{clockReads++;return at;});e.gate=async()=>{};
 source.qualifying_trigger=false;await assert.rejects(e.prepareEntry("evaluation"),/source_not_qualifying/);assert.equal(marketReads,0);assert.equal(clockReads,0);
 source.qualifying_trigger=true;await assert.rejects(e.prepareEntry("evaluation"),/production_evaluation_stale/);assert.equal(clockReads,1);assert.equal(marketReads,1);assert.equal(submits,0);
 assert.deepEqual(context,{stage:"prepare",evaluationId:"evaluation",marketTicker:market,evaluatedAtMs:at-5001,btcProviderAgeMs:0,btcReceiveAgeMs:0,marketAgeMs:0});
 source.evaluated_at=new Date(at-5824);source.btc_provider_age_ms=1163;clockReads=0;
 await assert.rejects(e.prepareEntry("evaluation"),/production_evaluation_stale/);
 assert.equal(at-source.evaluated_at.getTime()+source.btc_provider_age_ms,6987);
 assert.equal(clockReads,1);assert.equal(submits,0);
});

test("unsettled streaming cancellation retains advisory budget without blocking STOP or later mandatory recovery",async()=>{
 let calls=0,cancels=0,reconciles=0,recoveries=0;let release!:()=>void;
 const cancellation=new Promise<void>(resolve=>{release=resolve;});
 const c=new CommittedPublicMetadataCoordinator((async()=>{calls++;return new Response(new ReadableStream({cancel(){cancels++;return cancellation;}}),{headers:{"content-type":"application/json"}});}) as typeof fetch,()=>at,()=>0);
 let attempt:MetadataPrefetchAttempt|null=null;
 const executor={now:()=>at,startTiming:()=>()=>{},ledger:{accountId:"account",pool:{query:async()=>({rows:[]})}},
  prefetchCommittedPublicMetadata:(h:CommittedForwardSourceHint)=>{const admitted=c.start(scope,h);if(admitted)attempt=admitted;return admitted;},
  reconcile:async()=>{reconciles++;await turn();}};
 const worker=new ProductionWorker(executor as never,60_000,()=>{},()=>false,async()=>{recoveries++;});
 (worker as unknown as {pendingSourceHint:CommittedForwardSourceHint}).pendingSourceHint=hint;
 await worker.tick("committed_signal");worker.stop();assert.equal(calls,3);assert.equal(cancels,3);
 for(let n=0;n<10;n++){
  (worker as unknown as {pendingSourceHint:CommittedForwardSourceHint}).pendingSourceHint={...hint,evaluationId:"next-"+n};
  await worker.tick("committed_signal");
 }
 assert.equal(reconciles,11);assert.equal(recoveries,11);assert.equal(calls,3);assert.equal(c.diagnostics().activeRequests,3);assert.equal(c.diagnostics().accounts,1);assert.equal(c.diagnostics().queuedRequests,0);
 release();await (attempt as MetadataPrefetchAttempt|null)?.drained;await turn();assert.equal(c.diagnostics().activeRequests,0);assert.equal(c.diagnostics().accounts,0);
});
