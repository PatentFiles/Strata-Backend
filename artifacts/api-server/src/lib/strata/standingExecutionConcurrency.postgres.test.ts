import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pool} from '@workspace/db';
import {recordStandingExecutionReview,STANDING_REVIEW_CONFIRM,checkStandingExitReview,standingExecutionStatus} from './standingExecutionReview';
import {enrollContinuousGrant,CONTINUOUS_OWNER_CONFIRM,renewContinuousTechnicalLease,checkContinuousEligibility} from './continuousExecutionAuthorization';
import {auditUnseenExpiredSignals} from '../v13-production/signalDecisionTrace';
const url=new URL(process.env.DATABASE_URL!);
if(process.env.STRATA_ISOLATED_STANDING_TEST!=='true'||url.hostname!=='127.0.0.1'||url.pathname!=='/standing_ci')
 throw new Error('isolated_standing_database_required');
const owner='11111111-1111-4111-8111-111111111111',reviewer='22222222-2222-4222-8222-222222222222';
const qid='33333333-3333-4333-8333-333333333333',sha='a'.repeat(40),policy='b'.repeat(64);
process.env.RAILWAY_GIT_COMMIT_SHA=sha;
const proof=()=>({ownerId:owner,accountId:'acct',releaseSha:sha,policyHash:policy,observedAtMs:Date.now()-10,
 cashMicros:'25000000',fencingToken:'7',authenticated:true,complete:true,unexplainedCashActivity:false,providerEvidence:{test:true}});
async function waitForLock(pid:number){
 const end=Date.now()+3000;
 while(Date.now()<end){
  const r=await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid]);
  if(r.rows[0]?.wait_event_type==='Lock')return;
  await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('expected_concurrent_lock_not_observed');
}
test('standing authorization, transactional crash traces and concurrent revocation on real PostgreSQL',async t=>{
 try{
 await pool.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA auth; CREATE SCHEMA private;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE profiles(id uuid PRIMARY KEY,role text);
 CREATE TABLE v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text,
  subaccount int,exchange_index int,commissioned boolean,execution_enabled boolean,kill_switch boolean,blocked_reason text,cash_micros bigint);
 CREATE TABLE v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text,max_quote_age_ms int);
 CREATE TABLE private.strata_owner_sha_approvals(approval_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text,revoked_at timestamptz);
 CREATE TABLE private.strata_protective_release_qualification(qualification_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,release_commit_sha text,evidence_digest text,observed_at timestamptz,expires_at timestamptz);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean,account_kill boolean,fencing_token bigint,heartbeat_at timestamptz);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE forward_test_evaluations(id text PRIMARY KEY,evaluated_at timestamptz,evaluation_source text,qualifying_trigger boolean,fresh_cross boolean,signal text);
 CREATE TABLE v13_production_intent(id text PRIMARY KEY,account_id text,evaluation_id text,parent_id text,client_order_id text,kind text,state text,exchange_order_id text,filled_hundredths bigint,terminal boolean,cancel_attempted boolean,policy_hash text,dispatch_at timestamptz);
 CREATE TABLE v13_production_observation(id text,account_id text,kind text,payload jsonb,digest text);
 CREATE TABLE v13_production_event(account_id text,event_id text PRIMARY KEY,intent_id text,kind text,digest text,cash_delta_micros bigint,pnl_micros bigint,occurred_at timestamptz);
 CREATE FUNCTION private.strata_protective_approval_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$;
 INSERT INTO auth.users VALUES('${owner}'),('${reviewer}');
 INSERT INTO profiles VALUES('${reviewer}','ADMIN');
 INSERT INTO v13_production_account VALUES('acct','${owner}','p',1,2,true,true,false,NULL,25000000);
 INSERT INTO v13_live_money_policy VALUES('p','acct','${policy}','APPROVED',5000);
 INSERT INTO private.strata_owner_sha_approvals VALUES('${qid}','${owner}','acct','${sha}',NULL);
 INSERT INTO private.strata_protective_release_qualification VALUES('${qid}','${owner}','acct','${sha}','${policy}',now(),now()+interval '1 hour');
 INSERT INTO private.kalshi_account_worker_lease VALUES('acct','${owner}','owned',true,false,7,now());`);
 for(const file of ['0043_strata_continuous_execution_grants.sql','0044_v13_signal_decision_trace.sql'])
  await pool.query(readFileSync(resolve('../../lib/db/drizzle',file),'utf8'));
 const body={ownerUserId:owner,qualificationId:qid,accountId:'acct',policyHash:policy,expectedSha:sha,
  confirmation:STANDING_REVIEW_CONFIRM,reviewUrl:'https://github.com/PatentFiles/Strata-Backend/pull/246',note:'Independently reviewed exact release, owner scope, reduction-only exits, revocation and recovery evidence. '.repeat(3)};
 await t.test('explicit independent review and owner scope cannot be substituted',async()=>{
  assert.equal((await recordStandingExecutionReview(owner,'ADMIN',body,{db:pool,sha:()=>sha})).ok,false);
  assert.equal((await recordStandingExecutionReview(reviewer,'USER',body,{db:pool,sha:()=>sha})).ok,false);
  assert.equal((await recordStandingExecutionReview(reviewer,'ADMIN',{...body,expectedSha:'c'.repeat(40)},{db:pool,sha:()=>sha})).ok,false);
  assert.equal((await recordStandingExecutionReview(reviewer,'ADMIN',body,{db:pool,sha:()=>sha})).ok,true);
  const consent={expectedSha:sha,accountId:'acct',policyHash:policy,confirmation:CONTINUOUS_OWNER_CONFIRM};
  assert.equal((await enrollContinuousGrant(owner,{...consent,policyHash:'c'.repeat(64)},{db:pool,sha:()=>sha})).ok,false);
  assert.equal((await enrollContinuousGrant(owner,consent,{db:pool,sha:()=>sha})).ok,true);
  assert.equal(await checkContinuousEligibility(pool,owner,sha),false);
  assert.equal((await renewContinuousTechnicalLease(proof(),{db:pool})).ok,true);
  assert.equal(await checkContinuousEligibility(pool,owner,sha),true);
  const status=await standingExecutionStatus(owner,{db:pool,sha:()=>sha});
  assert.equal(status.ok,true);assert.ok('grantActive' in status&&status.grantActive);
 });
 await t.test('local authorization latency budget is measured without widening the 5s signal gate',async()=>{
  const samples:number[]=[];
  for(let i=0;i<40;i++){const start=performance.now();assert.equal(await checkContinuousEligibility(pool,owner,sha),true);samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);const p95=samples[Math.ceil(samples.length*.95)-1]!;
  t.diagnostic(JSON.stringify({kind:'local_postgres_authorization_latency',samples:samples.length,p95Ms:p95,maxMs:samples.at(-1),budgetMs:250,productionLatencyQualified:false}));
  assert.ok(p95<250,'local authorization p95 must leave headroom within the existing 5s gate');
 });
 await t.test('revocation serializes against an admitted final transaction and blocks subsequent entries',async()=>{
  const reader=await pool.connect(),revoker=await pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await reader.query('BEGIN');assert.equal(await checkContinuousEligibility(reader,owner,sha),true);
   const pid=(await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=revoker.query("UPDATE private.strata_continuous_execution_grants SET revoked_at=now(),revocation_reason='owner_revoked'");
   await waitForLock(pid);
   await reader.query('COMMIT');await pending;
   assert.equal(await checkContinuousEligibility(pool,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db:pool})).ok,false);
   assert.equal(await checkStandingExitReview(pool,owner,'acct',sha),true,'entry revocation retains separately reviewed reduce-only protection');
  }finally{await reader.query('ROLLBACK');await pending;reader.release();revoker.release();}
 });
 await t.test('technical review revocation serializes against protective authorization',async()=>{
  const reader=await pool.connect(),revoker=await pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await reader.query('BEGIN');assert.equal(await checkStandingExitReview(reader,owner,'acct',sha),true);
   const pid=(await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=revoker.query("UPDATE private.strata_standing_execution_reviews SET revoked_at=now(),revocation_reason='reviewer_revoked'");
   await waitForLock(pid);await reader.query('COMMIT');await pending;
   assert.equal(await checkStandingExitReview(pool,owner,'acct',sha),false);
   const status=await standingExecutionStatus(owner,{db:pool,sha:()=>sha});
   assert.ok('grantActive' in status&&!status.grantActive);
  }finally{await reader.query('ROLLBACK');await pending;reader.release();revoker.release();}
 });
 await t.test('intent and fill traces are atomic, durable across connections and immutable',async()=>{
  const c=await pool.connect();
  const insert=`INSERT INTO v13_production_intent VALUES('intent','acct','signal',NULL,'client','ENTRY','PREPARED',NULL,0,false,false,'${policy}',NULL)`;
  try{await c.query('BEGIN');await c.query(insert);await c.query('ROLLBACK');}
  finally{c.release();}
  assert.equal((await pool.query('SELECT * FROM private.strata_v13_execution_trace')).rows.length,0);
  await pool.query(insert);
  await pool.query("UPDATE v13_production_intent SET state='DISPATCHED',dispatch_at=now() WHERE id='intent'");
  await pool.query("UPDATE v13_production_intent SET state='UNKNOWN' WHERE id='intent'");
  await pool.query(`INSERT INTO v13_production_event VALUES('acct','event','intent','FILL','${policy}',-10000,0,now())`);
  await pool.query("UPDATE v13_production_intent SET state='TERMINAL',exchange_order_id='exchange',filled_hundredths=100,terminal=true WHERE id='intent'");
  const trace=(await pool.query('SELECT * FROM private.strata_v13_execution_trace ORDER BY trace_id')).rows;
  assert.equal(trace.length,5);assert.ok(trace.every(r=>r.evaluation_id==='signal'&&r.client_order_id==='client'));
  assert.equal(trace[3].kind,'EXCHANGE_EVENT');assert.equal(trace[4].details.filledHundredths,'100');
  await pool.query(`INSERT INTO v13_production_observation VALUES('obs','acct','POST_UNCERTAIN','{"id":"intent"}','${policy}')`);
  assert.equal((await pool.query("SELECT evaluation_id FROM private.strata_v13_execution_trace WHERE kind='TRANSPORT_OBSERVATION'")).rows[0].evaluation_id,'signal');
  await pool.query("ALTER TABLE private.strata_v13_execution_trace ADD CONSTRAINT test_trace_failure CHECK(intent_id<>'blocked') NOT VALID");
  await assert.rejects(pool.query(insert.replace("'intent'","'blocked'")));
  assert.equal((await pool.query("SELECT id FROM v13_production_intent WHERE id='blocked'")).rows.length,0);
  await pool.query('ALTER TABLE private.strata_v13_execution_trace DROP CONSTRAINT test_trace_failure');
  await assert.rejects(pool.query('DELETE FROM private.strata_v13_execution_trace'));
  const restricted=await pool.connect();
  try{
   await restricted.query('SET ROLE authenticated');
   await assert.rejects(restricted.query('SELECT * FROM private.strata_v13_execution_trace'));
  }finally{await restricted.query('RESET ROLE');restricted.release();}
 });
 await t.test('unseen audit catches downtime longer than fifteen minutes in bounded idempotent batches',async()=>{
  await pool.query(`INSERT INTO v13_production_account SELECT 'catchup',owner_user_id,'p2',1,2,true,true,false,NULL,cash_micros FROM v13_production_account LIMIT 1;
   INSERT INTO v13_live_money_policy VALUES('p2','catchup','${policy}','APPROVED',5000);
   -- Isolated fixture clock: represent an account that existed before downtime.
   ALTER TABLE private.strata_v13_signal_trace_scope DISABLE TRIGGER strata_v13_trace_scope_immutable;
   UPDATE private.strata_v13_signal_trace_scope SET started_at=now()-interval '1 day' WHERE execution_account_id='catchup';
   ALTER TABLE private.strata_v13_signal_trace_scope ENABLE TRIGGER strata_v13_trace_scope_immutable;
   INSERT INTO forward_test_evaluations SELECT md5(n::text),now()-interval '20 minutes','paper',true,true,'SCOUT' FROM generate_series(1,125)n;`);
  assert.equal(await auditUnseenExpiredSignals('catchup',pool),100);
  assert.equal(await auditUnseenExpiredSignals('catchup',pool),25);
  assert.equal(await auditUnseenExpiredSignals('catchup',pool),0);
 });
 }finally{await pool.end();}
});
