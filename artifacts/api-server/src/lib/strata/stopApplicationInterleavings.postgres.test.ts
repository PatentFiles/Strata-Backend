import {tradingSession,protectiveFixture,source,requestOf,fill,policy,USER,ACCOUNT} from './personalExecution.integration.test';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {pool} from '@workspace/db';
import {operateAccountWorker,SAFETY_EXPOSURE_SQL,type AccountExecutionDeps} from './accountScopedExecution';
import {createOwnedTradingSupervisor,disarmWorkerLease} from './personalExecutionSupervisor';
const FIN='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',CON='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',SECRET='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function exactLease(fingerprint:string){
 await pool.query(`CREATE SCHEMA IF NOT EXISTS private;
 CREATE TABLE IF NOT EXISTS public.financial_accounts(id uuid,user_id uuid,UNIQUE(id,user_id));
 CREATE TABLE IF NOT EXISTS private.provider_connections(id uuid,financial_account_id uuid);
 INSERT INTO public.financial_accounts VALUES('${FIN}','${USER}') ON CONFLICT DO NOTHING;
 INSERT INTO private.provider_connections SELECT '${CON}','${FIN}' WHERE NOT EXISTS(SELECT 1 FROM private.provider_connections WHERE id='${CON}');
 DROP TABLE IF EXISTS private.kalshi_account_worker_lease CASCADE;`);
 await pool.query(readFileSync('../../lib/db/drizzle/0013_kalshi_account_worker_lease.sql','utf8'));
 await pool.query(`INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,financial_account_id,provider_connection_id,holder_id,fencing_token,state,heartbeat_at,arm_requested,credential_fingerprint,vault_secret_id) VALUES($1,$2,$3,$4,'worker',3,'owned',now(),true,$5,$6)`,[ACCOUNT,USER,FIN,CON,fingerprint,SECRET]);
 await pool.query('UPDATE v13_production_account SET kalshi_connection_id=$1 WHERE id=$2',[FIN,ACCOUNT]);
}
async function lease(){return(await pool.query('SELECT state,arm_requested,fencing_token::text AS token FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[ACCOUNT])).rows[0];}
function unboundDeps(beforeTransaction:()=>Promise<void>=async()=>{}):AccountExecutionDeps{return{
 commissioning:{listOwnedConnections:async()=>[],listCredentialRefs:async()=>[],readExecutionTarget:async()=>null,readSnapshot:async()=>{throw Error('not used');},openCredential:async()=>{throw Error('no credentials');}},
 activity:{readOwnedAccount:async()=>null},globalKill:async()=>false,now:()=>Date.now(),
 leases:{query:pool.query.bind(pool),transaction:async(fn)=>{await beforeTransaction();const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}},
 safety:{listAccounts:async()=>{const rows=(await pool.query(SAFETY_EXPOSURE_SQL,[USER])).rows;return rows.map(r=>({executionAccountId:r.execution_account_id,ownerUserId:USER,financialAccountId:FIN,providerConnectionId:CON,keyFingerprint:null,vaultSecretId:null,openPositionCount:Number(r.open_positions),unresolvedIntentCount:Number(r.unresolved_intents)}));},markKilled:async()=>{throw Error('KILL forbidden in test');}}
};}
function supervisorFor(s:Awaited<ReturnType<typeof tradingSession>>,db=pool){let scheduled=true;return createOwnedTradingSupervisor(async()=>({ok:true,worker:{async start(){scheduled=true;},async startRecovery(){scheduled=true;},stop(){scheduled=false;},isScheduled(){return scheduled;}},state:s.exchange.state,disarm:action=>disarmWorkerLease(db,USER,ACCOUNT,action,new Date(s.now).toISOString())}));}

test('owner-wide STOP refreshes exposure after real entry commits between sampled snapshot and lease transaction',async()=>{
 const s=await tradingSession(500,[]);await exactLease(s.evidence.identity.keyFingerprint);
 let completed=false;
 const deps=unboundDeps(async()=>{
  const id=await s.executor.prepareEntry(await source(s.now));await s.executor.dispatch(id);fill(s.evidence,await requestOf(id),'200');await s.executor.reconcile();completed=true;
 });
 const r=await operateAccountWorker(deps,{authenticatedUserId:USER,holderId:'non-owning-control-process',action:'STOP'});
 assert.equal(completed,true);assert.equal(s.posts.length,1);
 assert.equal((await pool.query('SELECT quantity_hundredths FROM v13_production_position WHERE account_id=$1',[ACCOUNT])).rows[0].quantity_hundredths,'200');
 assert.equal((await lease()).state,'owned','STOP must retain recovery for newly committed real exposure');
 assert.equal((await lease()).arm_requested,false);assert.equal(r.state,'owned');
});

test('supervisor STOP with already prepared EXIT retains worker and real reservation may safely prepare afterward',async()=>{
 const f=await protectiveFixture(false);await exactLease(f.evidence.identity.keyFingerprint);
 const supervisor=supervisorFor(f);await supervisor.start({userId:USER,accountId:ACCOUNT} as never);
 const stopped=await supervisor.stop({userId:USER,accountId:ACCOUNT,action:'STOP'});
 assert.equal(stopped.managingExposure,true);assert.equal(supervisor.isScheduled(USER,ACCOUNT),true);
 const reserved=await f.reserve();assert.equal(reserved.reservationPrepared,true,reserved.reason);
 assert.equal((await lease()).state,'owned');assert.equal((await lease()).arm_requested,false);
 assert.equal(f.posts.length,1,'only initial entry, no exit POST from reservation');
});

async function waitForAccountWaiter(){
 const end=Date.now()+1500;while(Date.now()<end){
  const r=await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'SELECT * FROM v13_production_account WHERE id=%' OR query LIKE 'BEGIN; SELECT * FROM v13_production_account WHERE id=%') AND cardinality(pg_blocking_pids(pid))>0 LIMIT 2");
  if(r.rows.length)return;await new Promise(resolve=>setTimeout(resolve,10));
 }throw Error('account_lock_wait_not_observed');
}
test('supervisor STOP serializes against late real preparation; late dispatch cannot POST',async()=>{
 const s=await tradingSession(500,[],60_000_000_000,undefined,true);await exactLease(s.evidence.identity.keyFingerprint);
 const evaluation=await source(s.now);let prepared:Promise<string>|undefined;let fired=false;
 const wrapped={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return{release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
  if(!fired&&sql.includes('AS positions')){fired=true;prepared=s.executor.prepareEntry(evaluation);await waitForAccountWaiter();}
  return c.query(sql,args);
 }};}};
 const supervisor=supervisorFor(s,wrapped as never);await supervisor.start({userId:USER,accountId:ACCOUNT} as never);
 try{
 const stopped=await supervisor.stop({userId:USER,accountId:ACCOUNT,action:'STOP'});
 assert.equal(stopped.workerStopped,true);assert.equal(stopped.managingExposure,false);assert.equal((await lease()).state,'released');
 assert.ok(prepared);const id=await prepared;await assert.rejects(s.executor.dispatch(id),/entries_stopped|production_entry_release_not_current|stale_worker_fence/);
 assert.equal(s.posts.length,0);assert.equal(s.exchange.state.entriesAuthorized,false);
 const intent=(await pool.query('SELECT state,terminal FROM v13_production_intent WHERE id=$1',[id])).rows[0];
 assert.equal(intent.state,'BLOCKED');assert.equal(intent.terminal,true);
 }finally{await prepared?.catch(()=>{});}
});

test('bound STOP refreshes account exposure rather than trusting pre-transaction activity snapshot',async()=>{
 const s=await tradingSession(500,[]);await exactLease(s.evidence.identity.keyFingerprint);
 const deps=unboundDeps(async()=>{const id=await s.executor.prepareEntry(await source(s.now));await s.executor.dispatch(id);fill(s.evidence,await requestOf(id),'200');await s.executor.reconcile();});
 deps.commissioning={
  listOwnedConnections:async()=>[{authenticatedUserId:USER,financialAccountId:FIN,providerConnectionId:CON}],
  listCredentialRefs:async()=>[{role:'restricted_execution',providerConnectionId:CON,vaultSecretId:SECRET,keyFingerprint:s.evidence.identity.keyFingerprint,source:'vault_connection'}],
  readExecutionTarget:async()=>({ownerUserId:USER,providerConnectionId:CON,executionAccountId:ACCOUNT,subaccount:1,exchangeIndex:2}),
  readSnapshot:async()=>{throw Error('unused');},openCredential:async()=>{throw Error('no secret reads');}
 };
 deps.activity={readOwnedAccount:async()=>({executionAccountId:ACCOUNT,ownerUserId:USER,financialAccountId:FIN,providerConnectionId:CON,subaccount:1,exchangeIndex:2,keyFingerprint:s.evidence.identity.keyFingerprint,commissioned:true,executionEnabled:true,killSwitch:false,configuredStakeCents:500,cashMicros:60_000_000_000n,policy:{...policy(),executionAccountId:ACCOUNT},positions:[],orders:[],fillIds:[],settlementIds:[],realizedPnlMicros:0n,realizedDailyLossCents:0,realizedTotalLossCents:0})};
 const r=await operateAccountWorker(deps,{authenticatedUserId:USER,holderId:'control',action:'STOP'});
 assert.equal(s.posts.length,1);assert.equal(r.state,'owned');assert.equal((await lease()).state,'owned');assert.equal((await lease()).arm_requested,false);
});

test('STOP refuses missing private uncertainty evidence without releasing lease or removing recovery worker',async()=>{
 const f=await protectiveFixture(true);await exactLease(f.evidence.identity.keyFingerprint);
 const supervisor=supervisorFor(f);await supervisor.start({userId:USER,accountId:ACCOUNT} as never);
 await pool.query('ALTER TABLE private.strata_emergency_exit_reservations RENAME TO unavailable_reservations');
 try{const stopped=await supervisor.stop({userId:USER,accountId:ACCOUNT,action:'STOP'});assert.equal(stopped.workerStopped,false);assert.equal(supervisor.isScheduled(USER,ACCOUNT),true);assert.equal((await lease()).state,'owned');assert.equal(f.exchange.state.entriesAuthorized,false);}finally{await pool.query('ALTER TABLE private.unavailable_reservations RENAME TO strata_emergency_exit_reservations');}
});

test('owner-wide STOP and KILL use account-before-lease order in both deterministic interleavings',async()=>{
 for(const first of ['STOP','KILL'] as const){
  const f=await protectiveFixture(false);await exactLease(f.evidence.identity.keyFingerprint);
  let unlock!:()=>void,locked!:()=>void;
  const gate=new Promise<void>(resolve=>unlock=resolve),seen=new Promise<void>(resolve=>locked=resolve);
  const winner=unboundDeps(),loser=unboundDeps();
  for(const deps of [winner,loser])deps.safety!.markKilled=async(owner,account,client)=>{assert.ok(client,'KILL account write uses same transaction');await client.query('UPDATE v13_production_account SET kill_switch=true WHERE id=$1 AND owner_user_id=$2::uuid',[account,owner]);};
  winner.leases.transaction=async(fn)=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn({query:async(sql,args)=>{const r=await c.query(sql,args);if(sql.includes('ORDER BY id FOR UPDATE')){locked();await gate;}return r;}});await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  const a=operateAccountWorker(winner,{authenticatedUserId:USER,holderId:'first',action:first});await seen;
  const b=operateAccountWorker(loser,{authenticatedUserId:USER,holderId:'second',action:first==='STOP'?'KILL':'STOP'});
  const deadline=Date.now()+500;let waiting=false;
  while(Date.now()<deadline){const r=await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM public.v13_production_account WHERE owner_user_id=%' LIMIT 1");if(r.rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}
  unlock();assert.equal(waiting,true,'second control waits for account, not inverse lease lock');await Promise.all([a,b]);
  assert.equal((await lease()).state,'killed');assert.equal((await lease()).arm_requested,false);
  assert.equal((await pool.query('SELECT kill_switch FROM v13_production_account WHERE id=$1',[ACCOUNT])).rows[0].kill_switch,true);
  assert.equal(f.posts.length,1);
 }
});

test('supervisor STOP discards connection when rollback fails',async()=>{
 let discarded:unknown;
 const bad={query:async()=>({rows:[]}),connect:async()=>({query:async()=>{throw Error('connection failed');},release:(error:unknown)=>{discarded=error;}})};
 assert.deepEqual(await disarmWorkerLease(bad as never,USER,ACCOUNT,'STOP',new Date().toISOString()),{entriesBlocked:false,managingExposure:false});
 assert.ok(discarded instanceof Error);
});

test('non-owning-process STOP winning first makes actual lease final fence reject a later entry',async()=>{
 const s=await tradingSession(500,[]);await exactLease(s.evidence.identity.keyFingerprint);
 const {heartbeatLease}=await import('./personalExecutionSupervisor');
 // Use the production transaction-scoped lease proof at the final-authority
 // seam; other grant/fee checks remain covered by their independent suites.
 s.executor.authorizeFinalEntry=async(tx)=>{const proof=await heartbeatLease(tx,{executionAccountId:ACCOUNT,ownerUserId:USER,holderId:'worker',fencingToken:3,fingerprint:s.evidence.identity.keyFingerprint,now:new Date(s.now).toISOString()});if(!proof.ok||!proof.armRequested)throw Error('stale_worker_fence');};
 const stopped=await operateAccountWorker(unboundDeps(),{authenticatedUserId:USER,holderId:'control',action:'STOP'});
 assert.equal(stopped.state,'released');assert.equal(s.exchange.state.entriesAuthorized,true,'non-owning process cannot mutate worker-local latch');
 const id=await s.executor.prepareEntry(await source(s.now));await assert.rejects(s.executor.dispatch(id),/stale_worker_fence/);
 assert.equal(s.posts.length,0);assert.equal((await pool.query('SELECT state FROM v13_production_intent WHERE id=$1',[id])).rows[0].state,'BLOCKED');
});

test('STOP retains lease while real protective UNKNOWN transition completes',async()=>{
 const f=await protectiveFixture(true);await exactLease(f.evidence.identity.keyFingerprint);
 const supervisor=supervisorFor(f);await supervisor.start({userId:USER,accountId:ACCOUNT} as never);
 const results=await Promise.all([f.mark(),supervisor.stop({userId:USER,accountId:ACCOUNT,action:'STOP'})]);
 assert.equal(results[0].unknownRecorded,true,results[0].reason);assert.equal(results[1].managingExposure,true);
 assert.equal((await lease()).state,'owned');assert.equal((await lease()).arm_requested,false);
 assert.equal((await pool.query('SELECT state FROM private.strata_emergency_exit_reservations WHERE reservation_id=$1',[f.reservationId])).rows[0].state,'UNKNOWN');
 assert.equal((await pool.query('SELECT state FROM v13_production_intent WHERE id=$1',[f.exit])).rows[0].state,'DISPATCHED');
 assert.equal(f.posts.length,1,'no extra entry or replay POST');
});


test('shared control transaction adapter discards failed rollback connection',async()=>{
 const {credentialDatabaseFromPool}=await import('./accountCredentialStore');let discarded:unknown;
 const db=credentialDatabaseFromPool({query:async()=>({rows:[]}),connect:async()=>({query:async(sql:string)=>{if(sql==='ROLLBACK')throw Error('rollback unavailable');return {rows:[]};},release:(error:unknown)=>{discarded=error;}})});
 await assert.rejects(db.transaction(async()=>{throw Error('original failure');}),/original failure/);assert.ok(discarded instanceof Error);
});

test('bounded account-lock timeout leaves STOP unverified and retains recovery ownership',async()=>{
 const f=await protectiveFixture(false);await exactLease(f.evidence.identity.keyFingerprint);
 const supervisor=supervisorFor(f);await supervisor.start({userId:USER,accountId:ACCOUNT} as never);
 const holder=await pool.connect();try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE',[ACCOUNT]);
  const stopped=await supervisor.stop({userId:USER,accountId:ACCOUNT,action:'STOP'});
  assert.equal(stopped.workerStopped,false);assert.equal(supervisor.isScheduled(USER,ACCOUNT),true);assert.equal((await lease()).state,'owned');assert.equal(f.exchange.state.entriesAuthorized,false);
 }finally{await holder.query('ROLLBACK');holder.release();}
});


test('failed startup cleanup cannot release a replacement worker after STOP and re-ARM',async()=>{
 const {releaseFailedStartLease}=await import('./failedStartLeaseCleanup');
 const s=await tradingSession(500,[]);await exactLease(s.evidence.identity.keyFingerprint);
 const original={executionAccountId:ACCOUNT,ownerUserId:USER,holderId:'worker',fencingToken:3,now:new Date(s.now).toISOString()};
 // Use the real lifecycle transitions, including released_at's non-null/null
 // invariants. The regression must not bypass the migration's constraints.
 const {RELEASE_LEASE_SQL,ARM_LEASE_SQL,ACQUIRE_LEASE_SQL}=await import('./accountScopedExecution');
 const released=await pool.query(RELEASE_LEASE_SQL,[ACCOUNT,USER,original.now]);
 assert.deepEqual(released.rows,[{fencing_token:'4'}]);
 const armed=await pool.query(ARM_LEASE_SQL,[ACCOUNT,USER,s.evidence.identity.keyFingerprint,SECRET,original.now,CON,FIN]);
 assert.deepEqual(armed.rows,[{fencing_token:'4'}]);
 const acquired=await pool.query(ACQUIRE_LEASE_SQL,[ACCOUNT,'replacement-worker',original.now,
  s.evidence.identity.keyFingerprint,SECRET,CON,FIN,USER,new Date(s.now-30_000).toISOString()]);
 assert.deepEqual(acquired.rows,[{fencing_token:'5'}]);
 assert.equal((await releaseFailedStartLease(pool,original)).rows.length,0);
 let current=(await pool.query('SELECT state,holder_id,arm_requested,fencing_token::text AS token FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[ACCOUNT])).rows[0];
 assert.deepEqual(current,{state:'owned',holder_id:'replacement-worker',arm_requested:true,token:'5'});
 // Reusing a holder name never makes the old token valid again.
 await pool.query("UPDATE private.kalshi_account_worker_lease SET holder_id='worker' WHERE execution_account_id=$1",[ACCOUNT]);
 assert.equal((await releaseFailedStartLease(pool,original)).rows.length,0);
 assert.equal((await lease()).token,'5');
 // The exact current acquisition is safely released once, with one new fence.
 assert.equal((await releaseFailedStartLease(pool,{...original,fencingToken:5})).rows.length,1);
 assert.deepEqual(await lease(),{state:'released',arm_requested:false,token:'6'});
 assert.equal((await releaseFailedStartLease(pool,{...original,fencingToken:5})).rows.length,0);
 assert.equal(s.posts.length,0);
});
