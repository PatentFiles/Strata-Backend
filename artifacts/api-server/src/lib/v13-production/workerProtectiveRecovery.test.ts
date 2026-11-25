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

import {consumeOwnedPosition} from "./consumer";
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from "@workspace/v13-strategy";
test("LIVE owned exits require reviewed dispatcher, never generic fallback, even while entries are held",async()=>{
 const pos={id:"owned-position",account_id:"account",market:"KXBTC15M-TEST",side:"YES",quantity_hundredths:"200"};
 const source={id:"exit-source",market_ticker:pos.market,evaluated_at:new Date(1000),
  strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
  feed_freshness:"current",btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0,
  btc_price:99999,target:100000,signed_buffer:-1,velocity:-1,up_offer:.5,down_offer:.5};
 let generic=0,reviewed=0,reconciles=0;
 const tx={query:async()=>({rows:[pos]})};
 const executor={startTiming:()=>()=>{},now:()=>1000,exchange:{mode:"LIVE"},gate:async()=>{},containLiveEntries:()=>{},
  ledger:{accountId:"account",pool:{query:async(sql:string)=>({rows:sql.includes("forward_test_evaluations")?[source]:[pos]})},
   transaction:async(fn:(t:unknown,a:unknown)=>Promise<unknown>)=>fn(tx,{minimum_exit_micros:400000}),
   policy:async()=>({maxQuoteAgeMs:5000,policyHash:"test"}),observe:async()=>{}},
  reconcile:async()=>{reconciles++;},prepareExit:async()=>{generic++;throw Error("generic forbidden");},dispatch:async()=>{generic++;},
 };
 await assert.rejects(consumeOwnedPosition(executor as never),/reviewed_protective_exit_worker_not_bound/);
 const worker=new ProductionWorker(executor as never,2500,()=>{},()=>false,async()=>{},async()=>{reviewed++;});
 try{await worker.tick();assert.equal(reconciles,1);assert.equal(reviewed,1);assert.equal(generic,0);}
 finally{worker.stop();}
});

test("flat unbound live startup is refused; UNKNOWN recovery stays paper-free",async()=>{
 let recoveries=0,reconciles=0,traceReads=0,entries=0;
 const queries:string[]=[];
 const executor={exchange:{mode:"LIVE"},liveEntryContained:true,
  now:()=>100000,ledger:{accountId:"scoped-account",readAccount:async()=>{},
    pool:{query:async(sql:string,args:unknown[])=>{queries.push(sql);assert.deepEqual(args,["scoped-account"]);
      assert.match(sql,/FROM v13_production_position/);return {rows:[]};}},
    transaction:async()=>{throw Error("unbound_should_not_enter");}},
  reconcile:async()=>{reconciles++;},prepareEntry:async()=>{entries++;}};
 const trace={record:async()=>true,sweep:async()=>{traceReads++;return 0;}};
 const worker=new ProductionWorker(executor as never,60000,()=>{},()=>true,async()=>{recoveries++;},undefined,trace,true);
 try{
   await assert.rejects(worker.start(),{message:"production_independent_entry_source_unavailable"});
   assert.equal(worker.isScheduled(),false);assert.equal(queries.length,0);
   await worker.startRecovery();await worker.tick();
   assert.ok(recoveries>=3 && reconciles>=3);assert.equal(queries.length,0);
   assert.equal(traceReads,0);assert.equal(entries,0);
 }finally{worker.stop();}
});

test("API startup with an existing unbound holding cannot consult paper",async()=>{
 let paper=0,protectedCalls=0;
 const executor={exchange:{mode:"LIVE"},independentSourceBound:false,liveEntryContained:true,
   ledger:{accountId:"acct",pool:{query:async()=>{paper++;return {rows:[{id:"existing-owned"}]};}},
    transaction:async()=>{}},reconcile:async()=>{}};
 const worker=new ProductionWorker(executor as never,60000,()=>{},()=>false,
   async()=>{},async()=>{protectedCalls++;},null,true);
 try{
   await assert.rejects(worker.start(),{message:"production_independent_entry_source_unavailable"});
   await worker.tick();
   assert.equal(worker.isScheduled(),false);assert.equal(paper,0);assert.equal(protectedCalls,0);
 }finally{worker.stop();}
});

test("history held in recovery keeps one scheduled loop without ordinary order paths; STOP ends it",async()=>{
 let polls=0,heartbeats=0,reconciles=0,dispatched=0,errors=0;
 const {markBlockedProtectiveRecoveryLiveness}=await import("../strata/protectiveRecoveryLiveness");
 const port={query:async()=>{heartbeats++;return {rows:[{}]};}};
 const executor={ledger:{readAccount:async()=>({})},reconcile:async()=>{reconciles++;},
  exchange:{mode:"LIVE"},dispatch:async()=>{dispatched++;},independentSourceBound:true};
 const worker=new ProductionWorker(executor as never,250,()=>{errors++;},()=>false,async()=>{
  polls++;
  const reason="authenticated_restart_history_unproven";
  const result=await markBlockedProtectiveRecoveryLiveness(port,{enabled:true,sameFencedSession:()=>true,
   recovery:{reason,attempted:1},ownerId:"owner",accountId:"account",holderId:"worker",fencingToken:7,
   fingerprint:"fixture",observedAt:new Date().toISOString()});
  assert.equal(result,"RECOVERY_ONLY");throw Error(reason);
 });
 try{
  await worker.startRecovery();
  const until=Date.now()+2500;
  while(errors<3&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
  assert.equal(worker.isScheduled(),true);
  assert.ok(polls>=3);assert.equal(heartbeats,polls);assert.equal(reconciles,0);assert.equal(dispatched,0);
  worker.stop();await worker.whenIdle();const stoppedPolls=polls;
  await new Promise(r=>setTimeout(r,320));assert.equal(polls,stoppedPolls);
 }finally{worker.stop();await worker.whenIdle();}
});
