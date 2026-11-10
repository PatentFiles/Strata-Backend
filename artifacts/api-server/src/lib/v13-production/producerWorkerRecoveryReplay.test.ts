import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionExecutor} from './executor';
import {ProductionWorker} from './worker';
import {receiptFixture} from './entryQuoteEvidence.fixture';
import {signalTraceSourceAgeMs} from './signalTraceSourceAge';
import {ForwardTransactionTiming,type ForwardTransactionPhase} from '../forwardTransactionTiming';
import {createBoundedUnknownEntryReadRunner} from '../strata/boundedUnknownEntryReadRunner';
import {readUnresolvedIntentMode} from '../strata/workerUncertainOrderGate';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_LEGACY_ENTRY_POLICY} from '@workspace/v13-strategy';
import type {StageTiming} from './stageTiming';

// OFFLINE ORCHESTRATION TEST ONLY. Real worker/executor methods, deterministic
// clocks and synthetic DB/provider ports. No SQL/authority/production-latency
// proof. Fresh paths deliberately stop BEFORE planning/reserving any order.
const epoch=Date.parse('2026-11-02T11:31:00.373Z');
const afterFreshness='replay_stopped_after_freshness_before_planning';
function replay(options:{producerMs:number;reconcileMs?:number;bookMs?:number;providerAgeMs?:number;held?:boolean;snapshotFails?:boolean}){
 let now=epoch+options.producerMs;
 const source={...receiptFixture(epoch),id:'offline-source',evaluation_source:'paper',
  strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
  qualifying_trigger:true,fresh_cross:true,position_was_open:false,crossing_key:'offline-cross',
  feed_freshness:'current',signal:'SCOUT',entry_policy_version:V13_LEGACY_ENTRY_POLICY,
  target:77035,btc_price:77045,previous_side:'DOWN',velocity:38,signed_buffer:10,
  btc_provider_age_ms:options.providerAgeMs??0,btc_receive_age_ms:0,market_age_ms:0};
 const original=JSON.stringify(source),order:string[]=[],events:StageTiming[]=[],reports:unknown[]=[],decisions:unknown[]=[];
 const counts={books:0,submits:0,writes:0,renewals:0,reconciles:0,heldReconciles:0,protected:0,discovered:0};
 const account={id:'offline-account',revision:'1',subaccount:'1',exchange_index:'2',key_fingerprint:'offline-only',minimum_exit_micros:400000};
 const position={id:'offline-position',market:source.market_ticker,side:'YES',quantity_hundredths:'200'};
 const exitSource={...source,btc_price:77025,signed_buffer:-10,velocity:-38};
 const tx={query:async(sql:string)=>{
  if(/^(INSERT|UPDATE|DELETE)/.test(sql)){counts.writes++;throw Error('offline_write_forbidden');}
  if(sql.includes('FROM v13_production_position'))return {rows:[position]};
  if(sql.includes('FROM forward_test_evaluations'))return {rows:[source]};
  if(sql.includes("state='PREPARED'"))throw Error(afterFreshness);
  return {rows:[]};
 }};
 const ledger={accountId:account.id,readReconcileAccount:async()=>({account,earliest:null}),
  reconcile:async()=>{counts.reconciles++;order.push('ledger-reconcile');},observe:async()=>{},
  pool:{query:async(sql:string,args:unknown[])=>{
   if(sql.includes('FROM v13_production_position'))return {rows:options.held?[position]:[]};
   if(sql.includes("WHERE evaluation_source='paper' AND market_ticker"))return {rows:[exitSource]};
   if(sql.includes('JOIN v13_live_money_policy')){
    counts.discovered++;order.push('discovery');
    assert.match(sql,/p\.max_quote_age_ms/);assert.match(sql,/ORDER BY e\.evaluated_at DESC,e\.id DESC LIMIT 100/);
    assert.equal((args[1] as Date).getTime(),now);
    // Synthetic equivalent of this query's age predicate, not a SQL test.
    return {rows:now-epoch<=5000&&now>=epoch?[{id:source.id,evaluated_at:source.evaluated_at}]:[]};
   }
   assert.match(sql,/SELECT \* FROM forward_test_evaluations WHERE id=\$1/);
   return {rows:[source]};
  }},
  transaction:async(fn:(t:unknown,a:unknown)=>unknown)=>fn(tx,account),
  policy:async()=>({entryPolicyVersion:V13_LEGACY_ENTRY_POLICY,maxQuoteAgeMs:5000})};
 const exchange={mode:'LIVE',snapshot:async()=>{
   order.push('signed-snapshot');now+=options.reconcileMs??0;
   if(options.snapshotFails)throw Error('personal_exchange_history_unreconciled');
   return {observedAtMs:now};
  },market:async()=>{counts.books++;order.push('book');now+=options.bookMs??0;
   return {bestAskDollars:'0.5000',bestBidDollars:'0.5000',observedAtMs:now,fee:{}};
  },submit:async()=>{counts.submits++;throw Error('offline_submit_forbidden');}};
 const executor=new ProductionExecutor(ledger as never,exchange as never,()=>now);
 executor.accountOwnerUserId='offline-owner';
 // Explicit synthetic authority boundary. This suite does NOT certify gate SQL.
 executor.gate=async()=>{};
 executor.timingObserver=e=>{events.push(e);};
 executor.afterReconcile=async()=>{counts.renewals++;};
 if(options.held)executor.heldReconcile=async()=>{counts.heldReconciles++;order.push('held-reconcile');return undefined as never;};
 const worker=new ProductionWorker(executor,2500,error=>{reports.push(error);},()=>!options.held,
  async()=>{order.push('unknown-audit');},async()=>{counts.protected++;order.push('protect');},
  {record:async d=>{decisions.push(d);return true;},sweep:async()=>0});
 return {source,original,executor,worker,counts,order,events,reports,decisions,now:()=>now};
}

for(const [age,expected] of [[4999,afterFreshness],[5000,afterFreshness],[5001,'production_entry_quote_evidence_expired']] as const){
 test(`exact ${age}ms boundary never resets source or submits`,async()=>{
  const f=replay({producerMs:age});
  await assert.rejects(f.executor.prepareEntry('offline-source'),new RegExp(expected));
  assert.equal(f.counts.submits,0);assert.equal(f.counts.writes,0);
  assert.equal(JSON.stringify(f.source),f.original);
  if(age<=5000)assert.equal(f.events.find(e=>e.stage==='evaluation_age_admission')?.outcome,'eligible');
 });
}

test('producer transaction, reconcile and late book consume one immutable five-second source budget',async()=>{
 const f=replay({producerMs:2000,reconcileMs:2000,bookMs:1001});
 try{await f.worker.tick('committed_signal');}finally{f.worker.stop();}
 assert.deepEqual(f.order,['unknown-audit','signed-snapshot','ledger-reconcile','discovery','book']);
 const admission=f.events.find(e=>e.stage==='evaluation_age_admission');
 assert.equal(admission?.sourceAgeMs,5001);assert.equal(admission?.outcome,'rejected');
 assert.equal(admission?.reason,'production_evaluation_stale');
 assert.equal(f.counts.books,1);assert.equal(f.counts.submits,0);assert.equal(f.counts.writes,0);
 assert.equal(f.counts.renewals,1);assert.equal(JSON.stringify(f.source),f.original);
 assert.deepEqual(f.decisions.map(d=>(d as {phase:string}).phase),['QUALIFYING_SEEN','PREPARE_REJECTED']);
});

test('reconciliation that exhausts the budget leaves no rediscovered or replayed historical entry',async()=>{
 const f=replay({producerMs:2000,reconcileMs:3001});
 try{await f.worker.tick('committed_signal');await f.worker.tick('committed_signal');}finally{f.worker.stop();}
 assert.equal(f.counts.discovered,2);assert.equal(f.counts.books,0);assert.equal(f.counts.submits,0);
 assert.deepEqual(f.decisions,[]);assert.equal(JSON.stringify(f.source),f.original);
});

test('historical regression totals remain 5824ms source + 1163ms provider = 6987ms, not fresh',async()=>{
 // Existing workerPublicMetadataPrefetch regression values, NOT new live data
 // or an inferred breakdown of the historical producer/DB/provider intervals.
 const f=replay({producerMs:5824,providerAgeMs:1163});
 assert.equal(signalTraceSourceAgeMs(f.source.evaluated_at,f.now()),5824);
 assert.equal(f.now()-f.source.evaluated_at.getTime()+f.source.btc_provider_age_ms,6987);
 await assert.rejects(f.executor.prepareEntry('offline-source'),/production_entry_quote_evidence_expired/);
 assert.equal(f.counts.books,0);assert.equal(f.counts.submits,0);
 assert.equal(JSON.stringify(f.source),f.original);
});

test('fresh source cannot erase already-old provider evidence or revive it with a late quote',async()=>{
 const f=replay({producerMs:4000,providerAgeMs:1163});
 await assert.rejects(f.executor.prepareEntry('offline-source'),/production_source_feed_stale_or_changed/);
 assert.equal(f.counts.books,0);assert.equal(f.counts.submits,0);assert.equal(f.counts.writes,0);
 assert.equal(JSON.stringify(f.source),f.original);
});

test('producer phase replay uses independent monotonic intervals and incomplete timing stays unknown',()=>{
 const phases:ForwardTransactionPhase[]=['requested','transaction_callback','lease_locked','position_read',
  'window_ready','history_ready','classified','work_complete','lease_renewed','committed'];
 const points=[0,100,200,300,400,500,600,1800,1900,2000]; // Synthetic, not observed timings.
 let at=0;const timing=new ForwardTransactionTiming(()=>at);
 phases.forEach((phase,i)=>{at=points[i]!;timing.mark(phase);});
 const snapshot=timing.snapshot();assert.equal(snapshot.complete,true);
 assert.equal(Object.entries(snapshot).reduce((sum,[key,value])=>sum+(key==='complete'?0:Number(value)),0),2000);
 assert.equal(snapshot.strategyPersistenceMs,1200);
 const missing=new ForwardTransactionTiming(()=>0);missing.mark('requested');
 assert.equal(missing.snapshot().complete,false);assert.equal(missing.snapshot().poolAndBeginMs,null);
 assert.equal(signalTraceSourceAgeMs(undefined,epoch),null);
 assert.equal(signalTraceSourceAgeMs(new Date(epoch+1),epoch),null);
});

for(const state of ['UNKNOWN','DISPATCHED','TERMINAL','BLOCKED']){
 test(`${state} synthetic stored intent cannot be submitted again after repeated calls or executor reconstruction`,async()=>{
  let writes=0,markets=0,submits=0;
  const ledger={accountId:'offline-account',transaction:async(fn:(t:unknown,a:unknown)=>unknown)=>fn({query:async(sql:string)=>{
   assert.match(sql,/^SELECT .* FOR UPDATE$/);assert.doesNotMatch(sql,/UPDATE v13/);
   return {rows:[{id:'offline-intent',state,kind:'ENTRY'}]};
  }},{id:'offline-account'}),persist:async()=>{writes++;}};
  const exchange={mode:'LIVE',market:async()=>{markets++;throw Error('unexpected_book');},submit:async()=>{submits++;}};
  for(let restart=0;restart<2;restart++){
   const executor=new ProductionExecutor(ledger as never,exchange as never,()=>epoch);
   for(let retry=0;retry<3;retry++)await executor.dispatch('offline-intent');
  }
  assert.deepEqual({writes,markets,submits},{writes:0,markets:0,submits:0});
 });
}

test('UNKNOWN mode remains held and read-only reconciliation preserves protection without entry or renewal',async()=>{
 const mode=await readUnresolvedIntentMode(async(sql,args)=>{
  assert.match(sql,/state IN \('DISPATCHED','UNKNOWN'\)/);assert.match(sql,/strata_emergency_exit_reservations/);
  assert.deepEqual(args,['offline-account',null]);return {rows:[{n:'1'}]};
 },'offline-account');
 assert.deepEqual(mode,{ok:true,mode:'recovery'});
 const f=replay({producerMs:100,held:true});
 try{await f.worker.tick();await f.worker.tick();}finally{f.worker.stop();}
 assert.equal(f.counts.heldReconciles,2);assert.equal(f.counts.reconciles,0);assert.equal(f.counts.renewals,0);
 assert.equal(f.counts.protected,2);assert.equal(f.counts.discovered,0);assert.equal(f.counts.submits,0);
 assert.deepEqual(f.order.slice(0,4),['unknown-audit','signed-snapshot','held-reconcile','protect']);
});

test('incomplete signed history prevents protective dispatch and entry even in held recovery',async()=>{
 const f=replay({producerMs:100,held:true,snapshotFails:true});
 try{await assert.rejects(f.worker.tick(),/personal_exchange_history_unreconciled/);}finally{f.worker.stop();}
 assert.equal(f.counts.heldReconciles,0);assert.equal(f.counts.protected,0);
 assert.equal(f.counts.discovered,0);assert.equal(f.counts.submits,0);assert.equal(f.counts.renewals,0);
});

test('bounded recovery late completion cannot become proof, retry or grant authority',async()=>{
 let now=epoch,reads=0,authorized=0;
 const run=createBoundedUnknownEntryReadRunner({now:()=>now,authorizeRead:async()=>{authorized++;},
  read:async()=>{reads++;now=epoch+15000;return {complete:true};}});
 const result=await run();
 assert.deepEqual(result,{ok:false,reason:'recovery_clock_or_deadline',attempts:1,tradingAuthorized:false});
 assert.deepEqual(await run(),{ok:false,reason:'recovery_runner_already_consumed',attempts:0,tradingAuthorized:false});
 assert.equal(reads,1);assert.equal(authorized,1);
});
