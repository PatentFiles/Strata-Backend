import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {eq} from 'drizzle-orm';
import {db,pool,forwardTestEngineTable,type PoolClient} from '@workspace/db';
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH,V13_ENTRY_POLICY_VERSION} from '@workspace/v13-strategy';
import {ensureWorkerEngine,acquireWorkerLease} from '../forwardTestRepository';
import {runForwardTestCycle,type CycleResult} from '../forwardTestWorker';
import {onCommittedForwardSignal,type CommittedForwardSourceHint} from '../forwardTestSignalWake';
import type {ForwardTestFeeds,MarketObservation} from '../forwardTestFeeds';
import {computeV13LiveMoneyPolicyHash,type V13ApprovedLiveMoneyPolicy} from '../v13LiveMoneyRisk';
import {ProductionLedger} from './ledger';
import {ProductionExecutor} from './executor';
import {ProductionWorker} from './worker';
import {assertCanonicalEntryQuoteEvidence} from './entryQuoteEvidence';
import type {Exchange,MarketEvidence,Snapshot} from './types';
import type {StageTiming} from './stageTiming';

// NATIVE DISPOSABLE TEST ONLY. No substitutes for producer SQL, commit, wake,
// scheduler, worker discovery, entry gate, reconciliation or reservation SQL.
// Provider/fee responses are synthetic. Execution stops before order dispatch.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(url??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL,url);
assert.equal(process.env.NODE_ENV,'test');
const target=new URL(url!);
after(()=>pool.end());

async function assertTarget(){
 const {rows:[actual]}=await pool.query(`SELECT current_database() AS name,current_user AS username,
  host(inet_server_addr()) AS host,inet_server_port() AS port`);
 assert.deepEqual(actual,{name:target.pathname.slice(1),username:'v13_test',host:'127.0.0.1',port:Number(target.port)});
 assert.equal((await pool.query('SHOW fsync')).rows[0].fsync,'on');
 assert.equal((await pool.query('SHOW synchronous_commit')).rows[0].synchronous_commit,'on');
}
async function until(check:()=>boolean|Promise<boolean>,label:string){
 const deadline=Date.now()+8000;
 while(!await check()){if(Date.now()>deadline)throw Error('producer_commit_wake_timeout:'+label);await delay(5);}
}
function policy():V13ApprovedLiveMoneyPolicy{
 const p:V13ApprovedLiveMoneyPolicy={id:'commit-wake-policy',version:1,supersedesPolicyId:null,state:'APPROVED',
  strategyVersion:'V1.3',strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
  strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,entryPolicyVersion:V13_ENTRY_POLICY_VERSION,
  championSelectionReviewId:'offline-review',championSelectionEvidenceHash:'a'.repeat(64),
  championSelectedBy:'synthetic-owner',championSelectedAt:new Date(0),
  capitalLimitCents:10000,maxEntryStakeCents:500,maxEntryAllInCents:550,maxOpenPositions:1,
  maxDailyLossCents:1000,maxTotalLossCents:2000,maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:5000,
  feePolicyVersion:'test-fees',feeSourceUrl:'https://invalid.test/fees',feeFormulaVersion:'test-v1',
  requireFullDepth:true,entryTimeInForce:'IOC',entryLimitSource:'SIGNAL_REFERENCE_OFFER',
  policyHash:null,createdBy:'synthetic-owner',approvedBy:'synthetic-owner',approvedAt:new Date(1)};
 p.policyHash=computeV13LiveMoneyPolicyHash(p);return p;
}

type Scenario='committed'|'rollback'|'late_book'|'stop_before_commit';
async function runScenario(scenario:Scenario){
 await assertTarget();
 await pool.query(`TRUNCATE v13_production_observation,v13_production_event,v13_production_position,
  v13_production_intent,v13_production_account,forward_test_evaluations,forward_test_book_snapshots,
  forward_test_positions,forward_test_btc_points,forward_test_windows,forward_test_engine,
  v13_live_money_policy,strata_configured_stake,live_execution_config CASCADE`);
 await pool.query('UPDATE producer_commit_wake_probe SET fail_commit=$1',[scenario==='rollback']);
 const id=randomUUID(),owner=randomUUID(),account='commit-wake-account',engine='COMMIT-WAKE-'+id;
 const ticker='KXBTC15M-COMMIT-'+id.toUpperCase();
 const sourceAt=Date.now()+2000;let producerNow=sourceAt-2000,consumerNow=sourceAt,price=99999;
 const p=policy(),keys=Object.keys(p);
 await pool.query(`INSERT INTO v13_live_money_policy(${keys.map(k=>k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())).join(',')},execution_account_id)
  VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')},$${keys.length+1})`,[...Object.values(p),account]);
 await pool.query(`INSERT INTO v13_production_account(id,owner_user_id,policy_id,subaccount,exchange_index,
  key_fingerprint,commissioning_digest,minimum_exit_micros,fee_artifact_digest,cash_precision_verified,
  commissioned,kill_switch,execution_enabled,cash_micros,initial_cash_micros)
  VALUES($1,$2,$3,1,2,$4,$5,400000,$5,true,true,false,true,100000000,100000000)`,
 [account,owner,p.id,'b'.repeat(64),'c'.repeat(64)]);
 await pool.query(`INSERT INTO strata_configured_stake(id,execution_account_id,configured_stake_cents,revision,updated_at)
  VALUES('production',$1,500,1,now())`,[account]);
 await pool.query(`INSERT INTO live_execution_config(id,mode,live_execution_enabled,manual_kill_switch)
  VALUES('singleton','V13_PRODUCTION',true,false)`);
 await ensureWorkerEngine(engine);
 await db.update(forwardTestEngineTable).set({enabled:true}).where(eq(forwardTestEngineTable.id,engine));
 const lease=await acquireWorkerLease(owner,engine);assert.ok(lease);
 const market=():MarketObservation=>({ticker,target:100000,startsAt:new Date(sourceAt-30000),
  endsAt:new Date(sourceAt+900000),yesAsk:.50,noAsk:.51,yesBid:.49,noBid:.50,
  yesPrice:.50,noPrice:.50,status:'open',result:null,fetchedAt:new Date(producerNow)});
 const feeds:ForwardTestFeeds={btc:async()=>({price,providerAt:new Date(producerNow),receivedAt:new Date(producerNow)}),
  market:async()=>market(),book:async()=>({ticker,source:'KALSHI_PUBLIC_REST',timestampAuthority:'LOCAL_RECEIPT_ONLY',
   requestStartedAtMs:producerNow,receivedAtMs:producerNow,bodyCompletedAtMs:producerNow,
   yesBids:[{priceTicks:4900,contractsHundredths:100000}],noBids:[{priceTicks:5000,contractsHundredths:100000}]})};
 const cycle=()=>runForwardTestCycle({owner,epoch:lease.leaseEpoch,engineId:engine,feeds,clock:()=>producerNow});
 const warm=await cycle();assert.equal(warm.error,null);assert.equal(warm.signal,'PASS');
 producerNow=sourceAt;price=100010;
 const counters={snapshots:0,books:0,submits:0,cancels:0};
 const events:StageTiming[]=[],reports:unknown[]=[],boundaryIntents:string[]=[];
 const exchange:Exchange={mode:'SIMULATION',snapshot:async():Promise<Snapshot>=>{
  counters.snapshots++;return {identity:{subaccount:1,exchangeIndex:2,keyFingerprint:'b'.repeat(64)},
   observedAtMs:consumerNow,authenticated:true,complete:true,historyFromMs:0,cashMicros:'100000000',cashExact:true,
   orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
 },market:async():Promise<MarketEvidence>=>{
  counters.books++;if(scenario==='late_book')consumerNow=sourceAt+5001;
  return {observedAtMs:consumerNow,bestAskDollars:'0.5000',asks:[{priceDollars:'0.5000',availableContracts:'10'}],
   bestBidDollars:'0.4900',bids:[{priceDollars:'0.4900',availableContracts:'10'}],
   fee:{policyVersion:'test-fees',sourceUrl:'https://invalid.test/fees',formulaVersion:'test-v1',
    fingerprint:'offline-test-fingerprint-0001',verifiedAtMs:consumerNow,contracts:10,limitPrice:.5,
    reservedEntryFeeCents:2,reservedExitFeeCents:3}};
 },submit:async()=>{counters.submits++;throw Error('producer_commit_wake_submit_forbidden');},
 cancel:async()=>{counters.cancels++;throw Error('producer_commit_wake_cancel_forbidden');}};
 const ledger=new ProductionLedger(pool,account),executor=new ProductionExecutor(ledger,exchange,()=>consumerNow);
 executor.accountOwnerUserId=owner;executor.timingObserver=event=>{events.push(event);};
 const worker=new ProductionWorker(executor,60000,error=>reports.push(error));
 // Scope ends after the real reservation COMMIT. Do not claim transport coverage.
 executor.dispatch=async intent=>{boundaryIntents.push(intent);worker.stop();};
 let blocker:PoolClient|undefined,observer:PoolClient|undefined,locked=false;
 let running:Promise<{result:CycleResult}|{error:unknown}>|undefined;
 const hints:(CommittedForwardSourceHint|undefined)[]=[],visibility:Promise<{rows:Record<string,unknown>[]} | null>[]=[];
 const wakeErrors:unknown[]=[],failures:unknown[]=[];let off=()=>{};
 try{
  blocker=await pool.connect();observer=await pool.connect();
  const observerPid=(await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  assert.notEqual(observerPid,blockerPid);
  off=onCommittedForwardSignal(hint=>{
   hints.push(hint);
   visibility.push(observer!.query('SELECT id,evaluated_at,entry_quote_evidence FROM forward_test_evaluations WHERE id=$1',
    [hint?.evaluationId]).then(result=>result,error=>{wakeErrors.push(error);return null;}));
  });
  await worker.start();
  await until(()=>events.some(e=>e.stage==='signal_discovery'&&e.outcome==='completed'),'initial-discovery');
  await delay(0);
  const discoveriesBefore=events.filter(e=>e.stage==='signal_discovery').length;
  await blocker.query('SELECT pg_advisory_lock(166331,1)');locked=true;
  running=cycle().then(result=>({result}),error=>({error}));
  await until(async()=>Number((await observer!.query(`SELECT count(*)::int AS n FROM pg_locks
   WHERE locktype='advisory' AND classid=166331 AND objid=1 AND NOT granted`)).rows[0].n)===1,'deferred-commit-lock');
  const waiting=(await observer.query(`SELECT a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
   WHERE l.locktype='advisory' AND l.classid=166331 AND l.objid=1 AND NOT l.granted`)).rows;
  assert.equal(waiting.length,1);assert.equal(waiting[0].query.trim().toLowerCase(),'commit');
  assert.equal((await observer.query('SELECT fail_commit FROM producer_commit_wake_probe')).rows[0].fail_commit,scenario==='rollback');
  // A deferred constraint trigger is blocked inside real COMMIT, not a mock.
  assert.equal(hints.length,0);assert.equal(boundaryIntents.length,0);
  assert.equal((await observer.query('SELECT count(*)::int AS n FROM forward_test_evaluations WHERE market_ticker=$1 AND qualifying_trigger',[ticker])).rows[0].n,0);
  assert.equal((await observer.query('SELECT count(*)::int AS n FROM v13_production_intent')).rows[0].n,0);
  if(scenario==='stop_before_commit')worker.stop();
  assert.equal((await blocker.query('SELECT pg_advisory_unlock(166331,1) AS unlocked')).rows[0].unlocked,true);locked=false;
  const settled=await running;if('error' in settled)throw settled.error;
  const result=settled.result;
  if(scenario==='rollback'){
   // Drizzle exposes the COMMIT wrapper here; the underlying RAISE message is
   // in its cause, which runForwardTestCycle intentionally does not return.
   // The native COMMIT waiter + fail_commit row above identify our injection.
   assert.match(result.error??'',/Failed query:\s*commit\b/i);assert.equal(result.evaluationId,null);
   assert.equal(hints.length,0);assert.equal(boundaryIntents.length,0);
   assert.equal((await observer.query('SELECT count(*)::int AS n FROM forward_test_evaluations WHERE market_ticker=$1 AND qualifying_trigger',[ticker])).rows[0].n,0);
   assert.equal(events.filter(e=>e.stage==='signal_discovery').length,discoveriesBefore);
  }else{
   assert.equal(result.error,null);assert.equal(result.signal,'SCOUT');assert.ok(result.evaluationId);
   assert.equal(hints.length,1);assert.equal(hints[0]?.evaluationId,result.evaluationId);
   assert.equal(hints[0]?.evaluatedAtMs,sourceAt);
   const visible=await visibility[0]!;assert.deepEqual(wakeErrors,[]);assert.equal(visible?.rows.length,1);
   assert.equal((visible!.rows[0]!.evaluated_at as Date).getTime(),sourceAt);
   const source=(await observer.query('SELECT * FROM forward_test_evaluations WHERE id=$1',[result.evaluationId])).rows[0];
   assertCanonicalEntryQuoteEvidence(source,sourceAt);
   if(scenario==='committed'){
    await until(()=>boundaryIntents.length===1,'worker-reservation');
    const intent=(await observer.query('SELECT * FROM v13_production_intent WHERE id=$1',[boundaryIntents[0]])).rows[0];
    assert.equal(intent.evaluation_id,result.evaluationId);assert.equal(intent.state,'PREPARED');
    assert.equal(new Date(intent.decision.source.evaluated_at).getTime(),sourceAt);
    assert.deepEqual(intent.decision.source.entry_quote_evidence,source.entry_quote_evidence);
    const held=(await observer.query('SELECT reserved_micros FROM v13_production_account WHERE id=$1',[account])).rows[0];
    assert.equal(held.reserved_micros,intent.reserved_micros);
    assert.equal((await observer.query('SELECT count(*)::int AS n FROM v13_production_intent WHERE account_id=$1',[account])).rows[0].n,1);
    const positions=(await observer.query('SELECT id,quantity_hundredths FROM v13_production_position WHERE account_id=$1',[account])).rows;
    assert.deepEqual(positions,[{id:intent.id,quantity_hundredths:'0'}]);
    assert.ok(BigInt(intent.reserved_micros)>0n);assert.equal(counters.books,1);
    assert.ok(events.some(e=>e.stage==='evaluation_age_admission'&&e.outcome==='eligible'&&e.sourceAgeMs===0));
    assert.deepEqual(reports,[]);
   }else if(scenario==='late_book'){
    await until(()=>reports.length>0,'late-book-rejection');worker.stop();
    assert.ok(events.some(e=>e.stage==='evaluation_age_admission'&&e.outcome==='rejected'&&e.sourceAgeMs===5001));
    assert.ok(events.some(e=>e.stage==='prepare_entry'&&e.reason==='production_evaluation_stale'));
    assert.equal(boundaryIntents.length,0);assert.equal(counters.books,1);
   }else{
    await delay(30);assert.equal(worker.isScheduled(),false);
    assert.equal(boundaryIntents.length,0);assert.equal(counters.books,0);
    assert.equal(events.filter(e=>e.stage==='signal_discovery').length,discoveriesBefore);
   }
   const retained=(await observer.query('SELECT evaluated_at,entry_quote_evidence FROM forward_test_evaluations WHERE id=$1',[result.evaluationId])).rows[0];
   assert.equal(retained.evaluated_at.getTime(),sourceAt);
   assert.deepEqual(retained.entry_quote_evidence,source.entry_quote_evidence);
  }
  if(scenario!=='committed'){
   assert.equal((await observer.query('SELECT count(*)::int AS n FROM v13_production_intent')).rows[0].n,0);
   assert.equal((await observer.query('SELECT reserved_micros FROM v13_production_account WHERE id=$1',[account])).rows[0].reserved_micros,'0');
  }
  assert.equal(counters.submits,0);assert.equal(counters.cancels,0);
 }catch(error){failures.push(error);}finally{
  worker.stop();off();
  const clean=async(work:()=>unknown)=>{try{await work();}catch(error){failures.push(error);}};
  if(locked&&blocker)await clean(()=>blocker!.query('SELECT pg_advisory_unlock(166331,1)'));
  if(running)await clean(()=>running);
  await clean(()=>until(()=>!(worker as unknown as {running:boolean}).running,'worker-drain'));
  await clean(()=>Promise.all(visibility));
  await clean(()=>observer?.release());await clean(()=>blocker?.release());
 }
 if(failures.length)throw new AggregateError(failures,'producer_commit_wake_scenario_failed:'+scenario);
}

test('native producer COMMIT publishes a wake into real worker admission, never an order',{timeout:120000},async t=>{
 await assertTarget();
 const previousFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('producer_commit_wake_fetch_forbidden');};
 try{
  await pool.query('CREATE TABLE producer_commit_wake_probe(fail_commit boolean NOT NULL)');
  await pool.query('INSERT INTO producer_commit_wake_probe VALUES(false)');
  await pool.query(`CREATE FUNCTION producer_commit_wake_gate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    PERFORM pg_advisory_xact_lock(166331,1);
    IF (SELECT fail_commit FROM producer_commit_wake_probe) THEN
     RAISE EXCEPTION 'producer_commit_wake_forced_rollback';
    END IF;
    RETURN NEW;
   END $$`);
  await pool.query(`CREATE CONSTRAINT TRIGGER producer_commit_wake_gate AFTER INSERT ON forward_test_evaluations
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.qualifying_trigger)
   EXECUTE FUNCTION producer_commit_wake_gate()`);
  for(const scenario of ['committed','rollback','late_book','stop_before_commit'] as const){
   await t.test(scenario,()=>runScenario(scenario));
  }
 }finally{
  // Only this test's fresh canonical disposable database ever contains these objects.
  try{
   await pool.query('DROP TRIGGER IF EXISTS producer_commit_wake_gate ON forward_test_evaluations');
   await pool.query('DROP FUNCTION IF EXISTS producer_commit_wake_gate()');
   await pool.query('DROP TABLE IF EXISTS producer_commit_wake_probe');
  }finally{globalThis.fetch=previousFetch;}
 }
});
