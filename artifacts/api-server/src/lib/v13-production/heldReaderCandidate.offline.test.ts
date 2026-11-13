import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ProductionLedger,identity,RECONCILE_ACCOUNT_HISTORY_SQL,type Account,HeldReconciliationCommitUncertain} from './ledger';
import {ProductionExecutor} from './executor';
import {ProductionWorker} from './worker';
import {type Exchange,type Snapshot} from './types';
import {TechnicalReleaseEntryGate} from '../strata/technicalReleaseEntryGate';
import {reconcileOwnedProtectiveExitOutcome} from '../strata/ownedProtectiveExitOutcome';

// Scheduler/executor/outcome integration, NOT native DB or dispatch qualification.
// A closed-world SQL fixture supplies an already held, flat account. Financial
// reconciliation, liveness, COMMIT classification, gate validation, consumer,
// real timers and outcome handling are production implementations, not stubs.
// No synthetic authority row here qualifies a protective POST or live release.
const owner='11111111-1111-4111-8111-111111111111',accountId='held-scheduler',hash='a'.repeat(64);
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(check:()=>boolean){
 const end=Date.now()+3000;
 while(!check()){if(Date.now()>end)throw Error('scheduler_condition_timeout');await delay(5);}
}
function fixture(){
 const a={id:accountId,owner_user_id:owner,policy_id:'p',subaccount:'1',exchange_index:'2',key_fingerprint:hash,
  commissioning_digest:hash,kill_switch:false,execution_enabled:true,commissioned:true,minimum_exit_micros:10000,
  fee_artifact_digest:hash,cash_precision_verified:true,cash_micros:'25000000',reserved_micros:'0',initial_cash_micros:'25000000',
  blocked_reason:'personal_exchange_history_unreconciled',reconciled_at:new Date(),revision:'1'} as Account;
 const calls:string[]=[],state={entriesAuthorized:false,accountKill:false};
 const gate=new TechnicalReleaseEntryGate();gate.beginReconciliation();
 let revisionReadback:string|null|undefined;
 let commitFailure=false,commits=0,renewals=0,snapshots=0,freezes=0,guardLocks=0,guardFinals=0,entryQueries=0;
 let staged:Account|null=null;
 const query=async(sql:string,args:unknown[]=[])=>{
  calls.push(sql);
  if(sql==='BEGIN'){staged=structuredClone(a);return {rows:[]};}
  if(sql===`BEGIN; SELECT * FROM v13_production_account WHERE id='${accountId}' FOR UPDATE`){
   staged=structuredClone(a);return [{command:'BEGIN',rows:[]},{command:'SELECT',rows:[structuredClone(a)]}];
  }
  if(sql==='COMMIT'){
   if(commitFailure)throw Error('injected_commit_ack_loss');
   if(staged)Object.assign(a,staged);staged=null;commits++;return {rows:[]};
  }
  if(sql==='ROLLBACK'){staged=null;return {rows:[]};}
  if(sql===RECONCILE_ACCOUNT_HISTORY_SQL)return {rows:[{...structuredClone(a),reconciliation_history_floor:null}]};
  if(sql==='SELECT * FROM v13_production_account WHERE id=$1'||sql==='SELECT * FROM v13_production_account WHERE id=$1 FOR UPDATE')return {rows:[structuredClone(a)]};
  if(sql.startsWith("SELECT set_config('lock_timeout'"))return {rows:[]};
  if(sql.startsWith('SELECT 1 FROM v13_production_'))return {rows:[]};
  if(sql.startsWith('SELECT id,account_id,evaluation_id')||sql.startsWith('SELECT market,side,quantity_hundredths')||sql.startsWith('SELECT * FROM v13_production_position'))return {rows:[]};
  if(sql.startsWith('SELECT e.cash'))return {rows:[{cash:'0',pnl:'0',basis:'0',position_pnl:'0',amount:'0'}]};
  if(sql.startsWith('INSERT INTO v13_production_observation'))return {rows:[]};
  if(sql.startsWith('UPDATE v13_production_account SET cash_micros=')){
   assert(staged);staged.cash_micros=String(args[1]);staged.reserved_micros=String(args[2]);
   staged.blocked_reason=args[3] as string;staged.revision=String(BigInt(staged.revision)+1n);staged.reconciled_at=args[4] as Date;return {rows:sql.includes('RETURNING revision')?(revisionReadback===null?[]:[{revision:revisionReadback??staged.revision}]):[]};
  }
  if(sql.includes('WITH uncertain AS MATERIALIZED'))return {rows:[{has_uncertain_order:false,owner_user_id:owner}]};
  if(sql==='SELECT manual_kill_switch, live_execution_enabled FROM live_execution_config')return {rows:[{manual_kill_switch:false,live_execution_enabled:true}]};
  if(sql.startsWith('SELECT p.policy_hash'))return {rows:[{policy_hash:hash}]};
  if(sql.includes('FROM forward_test_evaluations')){entryQueries++;throw Error('unexpected_entry_discovery');}
  throw Error('unexpected_SQL:'+sql);
 };
 const client=Object.assign(new EventEmitter(),{query,_queryable:true,_ending:false,_ended:false,connection:{stream:{destroyed:false}},release(){}});
 const db={query,connect:async()=>client};
 class Ledger extends ProductionLedger {override async freeze(){freezes++;throw Error('unfenced_freeze_forbidden');}}
 const ledger=new Ledger(db as never,accountId);
 const exchange:Exchange={mode:'LIVE',snapshot:async()=>{
  snapshots++;gate.beginReconciliation();return {identity:identity(a),observedAtMs:Date.now(),historyFromMs:0,
   complete:true,authenticated:true,cashExact:true,cashMicros:'25000000',unexplainedCashActivity:false,
   orders:[],fills:[],positions:[],settlements:[]} satisfies Snapshot;
 },market:async()=>{throw Error('no_market_transport');},submit:async()=>{throw Error('no_order_transport');},cancel:async()=>{throw Error('no_order_transport');}};
 const executor=new ProductionExecutor(ledger,exchange);executor.accountOwnerUserId=owner;
 executor.afterReconcile=async()=>{renewals++;state.entriesAuthorized=true;gate.completeReconciliation(true);};
 executor.heldReconcile=(snapshot,revision)=>ledger.reconcileHeld(snapshot,revision,{
  now:Date.now,deadlineMs:Date.now()+15000,
  lock:async(tx)=>{assert.equal(tx,client);guardLocks++;},beforeCommit:async(tx)=>{assert.equal(tx,client);guardFinals++;},
 });
 const reports:unknown[]=[];
 let protectionPolls=0,recoveryRefusals=0;
 let poll=async()=>{};
 const worker=new ProductionWorker(executor,250,error=>reports.push(error),()=>gate.mayEnter(state.entriesAuthorized,state.accountKill),
  async()=>{protectionPolls++;await poll();},async()=>{throw Error('flat_fixture_must_never_dispatch');});
 worker.heldRecoveryActive=()=>true;
 worker.recoverUnreconciledEntry=async()=>{recoveryRefusals++;return false;};
 const outcome=(value:Parameters<typeof reconcileOwnedProtectiveExitOutcome>[0]['outcome'])=>reconcileOwnedProtectiveExitOutcome({
  outcome:value,ownerId:owner,accountId,reservationId:'22222222-2222-4222-8222-222222222222',
  technicalRelease:gate,state,reconcile:()=>executor.reconcile(),
 });
 return {worker,executor,ledger,reports,state,gate,a,calls,outcome,
  failRevision:(value:string|null)=>{revisionReadback=value;},failCommit:()=>{commitFailure=true;},setPoll:(fn:()=>Promise<void>)=>{poll=fn;},
  counts:()=>({commits,renewals,snapshots,freezes,guardLocks,guardFinals,entryQueries,protectionPolls,recoveryRefusals})};
}

test('real normal scheduler consumes held flat positions, suppresses renewal and never discovers entries',async()=>{
 const f=fixture();
 try{
  await f.worker.start();await until(()=>f.counts().snapshots>=3);
  assert.equal(f.worker.isScheduled(),true);assert.equal(f.counts().renewals,0);assert.equal(f.counts().entryQueries,0);
  assert.equal(f.state.entriesAuthorized,false);assert.equal(f.gate.mayEnter(f.state.entriesAuthorized,false),false);
  assert.equal(f.a.blocked_reason,'personal_exchange_history_unreconciled');
  assert(f.calls.some(sql=>sql.startsWith('SELECT * FROM v13_production_position')),'actual consumeOwnedPosition ran');
  assert.equal(f.counts().guardLocks,f.counts().guardFinals);
 }finally{f.worker.stop();}
});
for(const reason of ['protective_post_uncertain','exit_reconcile_commit_uncertain'])test(`actual outcome refusal ${reason} stops real held scheduler without replay`,async()=>{
 const f=fixture();
 f.setPoll(async()=>{if(f.counts().protectionPolls>1)await f.outcome({state:'UNKNOWN',reason,mayRetry:false,tradingAuthorized:false,postAttempted:true,
  reconciliationCommitState:'UNKNOWN',reconciliationFreshnessVerified:false});});
 try{
  await f.worker.start();await until(()=>!f.worker.isScheduled());
  const stopped=f.counts();assert.equal(stopped.recoveryRefusals,1);assert.equal(stopped.snapshots,1);
  assert.equal(stopped.renewals,0);assert.equal(stopped.freezes,0);assert.equal(f.state.entriesAuthorized,false);
  assert(f.reports.some(e=>e instanceof Error&&e.message===reason));
  await delay(300);assert.deepEqual(f.counts(),stopped,'no timer, GET, callback or retry after uncertainty');
 }finally{f.worker.stop();}
});
test('forged local no-send cannot bypass durable outcome proof or keep scheduler running',async()=>{
 const f=fixture();f.setPoll(async()=>{if(f.counts().protectionPolls>1)await f.outcome({state:'BLOCKED',reason:'protective_exit_local_no_send',
  mayRetry:false,tradingAuthorized:false,postAttempted:false});});
 try{
  await f.worker.start();await until(()=>!f.worker.isScheduled());
  assert.equal(f.counts().snapshots,1);assert.equal(f.counts().recoveryRefusals,1);assert.equal(f.counts().renewals,0);
  assert.equal(f.state.entriesAuthorized,false);
 }finally{f.worker.stop();}
});
test('acknowledged protective outcome uses real held ledger without reopening entry or renewal eligibility',async()=>{
 const f=fixture();
 await f.outcome({state:'RECONCILED',reason:'signed_exchange_history_reconciled',mayRetry:false,tradingAuthorized:false,postAttempted:true});
 assert.equal(f.counts().commits,1);assert.equal(f.counts().guardLocks,1);assert.equal(f.counts().guardFinals,1);
 assert.equal(f.counts().renewals,0);assert.equal(f.state.entriesAuthorized,false);assert.equal(f.gate.mayEnter(false,false),false);
 assert.equal(f.a.blocked_reason,'personal_exchange_history_unreconciled');
});
test('actual held ledger COMMIT ambiguity stops scheduler, suppresses receipt, renewal, freeze and further polls',async()=>{
 const f=fixture();f.setPoll(async()=>{if(f.counts().protectionPolls>1)f.failCommit();});
 try{
  await f.worker.start();await until(()=>!f.worker.isScheduled());
  assert(f.reports.some(e=>e instanceof HeldReconciliationCommitUncertain));
  const stopped=f.counts();assert.equal(stopped.snapshots,2);assert.equal(stopped.commits,2,'startup reconciliation and lifecycle gate only');
  assert.equal(stopped.renewals,0);assert.equal(stopped.freezes,0);assert.equal(stopped.recoveryRefusals,1);
  assert.equal(f.a.revision,'2');assert.equal(f.state.entriesAuthorized,false);
  await delay(300);assert.deepEqual(f.counts(),stopped);
 }finally{f.worker.stop();}
});

test('ordinary executor with no held callback retains normal reconciliation and renewal behavior',async()=>{
 const f=fixture();f.executor.heldReconcile=null;
 await f.executor.reconcile();
 assert.equal(f.counts().commits,1);assert.equal(f.counts().renewals,1);
 assert.equal(f.counts().guardLocks,0);assert.equal(f.counts().guardFinals,0);
 assert.equal(f.state.entriesAuthorized,true);
});

test('ordinary ledger rejection retains existing freeze path rather than held failure suppression',async()=>{
 const f=fixture();
 await assert.rejects(f.ledger.reconcile({authenticated:false} as Snapshot,'1',Date.now()),/unfenced_freeze_forbidden/);
 assert.equal(f.counts().freezes,1);assert.equal(f.counts().guardLocks,0);
});

test('unrelated ordinary worker error retains baseline polling instead of held-only stop',async()=>{
 const f=fixture();f.worker.heldRecoveryActive=()=>false;
 f.worker.recoverUnreconciledEntry=async()=>{throw Error('unrelated_error_must_not_invoke_recovery');};
 f.setPoll(async()=>{if(f.counts().protectionPolls>1)throw Error('ordinary_transient_error');});
 try{
  await f.worker.start();await until(()=>f.counts().protectionPolls>=3);
  assert.equal(f.worker.isScheduled(),true);
  assert(f.reports.some(e=>e instanceof Error&&e.message==='ordinary_transient_error'));
  assert(!f.reports.some(e=>e instanceof Error&&e.message==='unrelated_error_must_not_invoke_recovery'));
 }finally{f.worker.stop();}
});

// Candidate integration uses the actual complete ledger body with synthetic SQL
// fixtures. It is not production signed evidence or native-DB qualification.
for(const mode of ['success','stale','wrong_identity','incomplete','unknown_commit'])test('held reader actual ledger '+mode,async()=>{
 const f=fixture();let locked=false,read=false,checked=false;
 if(mode==='unknown_commit')f.failCommit();
 const operation=f.ledger.reconcileHeldReaderCandidate('1',{now:Date.now,deadlineMs:Date.now()+5000,
 lock:async(tx,a)=>{assert.equal(a.id,f.a.id);assert(f.ledger.currentTransaction()===tx);locked=true;},beforeCommit:async()=>{assert(read);checked=true;}},async(tx,a)=>{
 assert(locked);assert.equal(tx,f.ledger.currentTransaction());read=true;
 return {identity:{...identity(a),...(mode==='wrong_identity'?{keyFingerprint:'wrong'}:{})},observedAtMs:Date.now()-(mode==='stale'?6000:0),historyFromMs:0,
 complete:mode!=='incomplete',authenticated:true,cashExact:true,cashMicros:'25000000',unexplainedCashActivity:false,orders:[],fills:[],positions:[],settlements:[]};
 },true);
 if(mode==='success'){const receipt=await operation;assert(checked);assert.equal(receipt.accountId,f.a.id);assert.equal(f.a.revision,'2');assert.equal(f.a.blocked_reason,'personal_exchange_history_unreconciled');}
 else{await assert.rejects(operation);assert.equal(f.a.revision,'1');assert.equal(f.counts().freezes,0);}
 assert.equal(f.counts().renewals,0);
});
test('held reader disabled without touching source or locks',async()=>{const f=fixture();await assert.rejects(f.ledger.reconcileHeldReaderCandidate('1',{now:Date.now,deadlineMs:Date.now()+5000,lock:async()=>{throw Error('must not lock')},beforeCommit:async()=>{}},async()=>{throw Error('must not read')}),/candidate_disabled/);assert.equal(f.calls.length,0);});

for(const value of [null,'not-an-integer','1'])test('held persisted revision invalid '+String(value)+' rolls back before receipt',async()=>{const f=fixture();f.failRevision(value);await assert.rejects(f.executor.reconcile(),/production_held_persisted_revision_unverified/);assert.equal(f.a.revision,'1');assert.equal(f.counts().commits,0);assert.equal(f.counts().guardFinals,0);assert.equal(f.counts().freezes,0);});
