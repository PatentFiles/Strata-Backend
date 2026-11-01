import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pool} from '@workspace/db';
import {auditUnseenExpiredSignals,recordLiveSignalDecision,AUDIT_FIRST_PAGE_SQL,AUDIT_NEXT_PAGE_SQL,AUDIT_INSERT_PAGE_SQL} from './signalDecisionTrace';
const u=new URL(process.env.DATABASE_URL!);
assert.equal(process.env.DATABASE_URL,process.env.V13_DISPOSABLE_DATABASE_URL);
assert.equal(u.hostname,'127.0.0.1');assert.match(u.pathname,/^\/v13_disposable_\d+$/);
process.env.RAILWAY_GIT_COMMIT_SHA='a'.repeat(40);
const state=async()=> (await pool.query("SELECT *,cursor_evaluated_at::text AS precise_cursor FROM private.strata_v13_signal_audit_progress WHERE execution_account_id='acct'")).rows[0];
async function reset(n=0){
 await pool.query(`TRUNCATE private.strata_v13_signal_audit_progress,private.strata_v13_signal_decisions,forward_test_evaluations;
 UPDATE v13_live_money_policy SET state='APPROVED';`);
 await pool.query(`INSERT INTO forward_test_evaluations SELECT lpad(n::text,6,'0'),'2020-01-01'::timestamptz+n*interval '1 microsecond','paper',true,true,'SCOUT' FROM generate_series(1,$1::int)n`,[n]);
}
const count=async()=>Number((await pool.query('SELECT count(*) FROM private.strata_v13_signal_decisions')).rows[0].count);
test('bounded durable trace sweep on isolated PostgreSQL',async t=>{
 try{
 await pool.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA private;
 CREATE TABLE v13_production_account(id text PRIMARY KEY,policy_id text);
 CREATE TABLE v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,state text,max_quote_age_ms int);
 CREATE TABLE forward_test_evaluations(id text PRIMARY KEY,evaluated_at timestamptz NOT NULL,evaluation_source text,qualifying_trigger boolean,fresh_cross boolean,signal text);
 CREATE INDEX forward_test_live_crosses ON forward_test_evaluations(evaluated_at,id) WHERE evaluation_source='paper' AND qualifying_trigger=true AND fresh_cross=true AND signal IN ('SCOUT','CONFIRM');
 CREATE TABLE private.strata_v13_signal_trace_scope(execution_account_id text PRIMARY KEY,started_at timestamptz);
 CREATE TABLE private.strata_v13_signal_decisions(decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,execution_account_id text,evaluation_id text REFERENCES forward_test_evaluations(id),phase text,source_age_ms int,reason text,release_commit_sha text,UNIQUE(execution_account_id,evaluation_id,phase));
 INSERT INTO v13_production_account VALUES('acct','p');
 INSERT INTO v13_live_money_policy VALUES('p','acct','APPROVED',5000);
 INSERT INTO private.strata_v13_signal_trace_scope VALUES('acct','2019-01-01');`);
 await pool.query(readFileSync(resolve('../../lib/db/drizzle/0045_v13_bounded_signal_audit.sql'),'utf8'));
 await t.test('125-row backlog advances over every source with exact microseconds and survives restart',async()=>{
  await reset(125);assert.equal(await auditUnseenExpiredSignals('acct',pool),100);
  assert.match((await state()).precise_cursor,/\.0001\+00$/);
  // Recreate the invocation from durable state, without an in-memory cursor.
  assert.equal(await auditUnseenExpiredSignals('acct',pool),25);assert.equal(await count(),125);
  assert.equal(await auditUnseenExpiredSignals('acct',pool),0);assert.equal(Number((await state()).completed_cycles),1);
  assert.equal(await auditUnseenExpiredSignals('acct',pool),0);assert.equal(Number((await state()).sources_examined),225);
 });
 await t.test('cursor and receipts roll back together after insertion failure; retry is complete',async()=>{
  await reset(5);
  const broken={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
   if(sql.startsWith('UPDATE private.strata_v13_signal_audit_progress'))throw Error('secret SQL payload');return c.query(sql,args);
  }};}};
  await assert.rejects(auditUnseenExpiredSignals('acct',broken),{message:'production_signal_trace_sweep_unavailable'});
  assert.equal(await count(),0);assert.equal(await state(),undefined);assert.equal(await auditUnseenExpiredSignals('acct',pool),5);
 });
 await t.test('concurrent audit callers serialize pages rather than skip locked history',async()=>{
  await reset(125);const results=await Promise.all([auditUnseenExpiredSignals('acct',pool),auditUnseenExpiredSignals('acct',pool)]);
  assert.deepEqual(results.sort((a,b)=>a-b),[25,100]);assert.equal(await count(),125);assert.equal(Number((await state()).sources_examined),125);
 });
 await t.test('out-of-order commit behind cursor is found on cyclic revisit',async()=>{
  await reset(100);const late=await pool.connect();
  try{await late.query('BEGIN');await late.query("INSERT INTO forward_test_evaluations VALUES('late','2019-12-31','paper',true,true,'SCOUT')");
   assert.equal(await auditUnseenExpiredSignals('acct',pool),100);await late.query('COMMIT');
   assert.equal(await auditUnseenExpiredSignals('acct',pool),0);assert.equal(await auditUnseenExpiredSignals('acct',pool),1);
   assert.equal(await count(),101);
  }finally{await late.query('ROLLBACK');late.release();}
 });
 await t.test('policy hold does not advance; existing non-catch-up decisions preserve semantics',async()=>{
  await reset(3);await pool.query("UPDATE v13_live_money_policy SET state='REVOKED'");
  assert.equal(await auditUnseenExpiredSignals('acct',pool),0);assert.equal(await state(),undefined);
  await pool.query("UPDATE v13_live_money_policy SET state='APPROVED'; INSERT INTO private.strata_v13_signal_decisions(execution_account_id,evaluation_id,phase) VALUES('acct','000001','QUALIFYING_SEEN')");
  assert.equal(await auditUnseenExpiredSignals('acct',pool),2);assert.equal(await count(),3);
 });
 await t.test('lock timeout is sanitized unavailable, does not corrupt progress and pool settings reset',async()=>{
  await reset(2);await auditUnseenExpiredSignals('acct',pool);const before=await state();const lock=await pool.connect();
  try{await lock.query('BEGIN');await lock.query("SELECT * FROM private.strata_v13_signal_audit_progress WHERE execution_account_id='acct' FOR UPDATE");
   await assert.rejects(auditUnseenExpiredSignals('acct',pool),{message:'production_signal_trace_sweep_unavailable'});
  }finally{await lock.query('ROLLBACK');lock.release();}
  assert.equal((await state()).precise_cursor,before.precise_cursor);assert.equal(await count(),2);
  assert.notEqual((await pool.query('SHOW lock_timeout')).rows[0].lock_timeout,'1s');
  assert.equal(await auditUnseenExpiredSignals('acct',pool),0);
 });
 await t.test('statement timeout rolls back progress and emits unavailable rather than empty success',async()=>{
  await reset(2);
  const slow={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
   if(sql===AUDIT_FIRST_PAGE_SQL)await c.query('SELECT pg_sleep(3)');return c.query(sql,args);
  }};}};
  await assert.rejects(auditUnseenExpiredSignals('acct',slow),{message:'production_signal_trace_sweep_unavailable'});
  assert.equal(await state(),undefined);assert.equal(await count(),0);
  assert.equal(await auditUnseenExpiredSignals('acct',pool),2);
 });
 await t.test('fixed cycle cutoff and scope exclude future/pre-scope rows without losing later eligibility',async()=>{
  await reset(1);await auditUnseenExpiredSignals('acct',pool);
  await pool.query("INSERT INTO forward_test_evaluations VALUES('fresh',clock_timestamp()-interval '1 second','paper',true,true,'SCOUT'),('prescope','2018-01-01','paper',true,true,'SCOUT')");
  assert.equal(await auditUnseenExpiredSignals('acct',pool),0);
  assert.equal(await count(),1);
  // Simulate passage of freshness cutoff via a source already-expired behind cursor.
  await pool.query("UPDATE forward_test_evaluations SET evaluated_at='2020-01-02' WHERE id='fresh'");
  assert.equal(await auditUnseenExpiredSignals('acct',pool),1);assert.equal(await count(),2);
 });
 await t.test('missing release identity fails explicitly instead of pretending empty history',async()=>{
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
  try{await assert.rejects(auditUnseenExpiredSignals('acct',pool),{message:'production_signal_trace_sweep_unavailable'});}
  finally{process.env.RAILWAY_GIT_COMMIT_SHA='a'.repeat(40);}
 });
 await t.test('missing immutable audit scope is unavailable, not an empty healthy page',async()=>{
  await pool.query("DELETE FROM private.strata_v13_signal_trace_scope WHERE execution_account_id='acct'");
  try{await assert.rejects(auditUnseenExpiredSignals('acct',pool),{message:'production_signal_trace_sweep_unavailable'});}
  finally{await pool.query("INSERT INTO private.strata_v13_signal_trace_scope VALUES('acct','2019-01-01')");}
 });
 await t.test('missing cursor migration fails observably without disabling durable signal decisions',async()=>{
  await reset();await pool.query('ALTER TABLE private.strata_v13_signal_audit_progress RENAME TO cursor_migration_absent');
  try{await assert.rejects(auditUnseenExpiredSignals('acct',pool),{message:'production_signal_trace_sweep_unavailable'});
   const id='11111111-1111-4111-8111-111111111111';
   await pool.query("INSERT INTO forward_test_evaluations VALUES($1,'2020-01-01','paper',true,true,'SCOUT')",[id]);
   assert.equal(await recordLiveSignalDecision({accountId:'acct',evaluationId:id,phase:'QUALIFYING_SEEN'},pool,'a'.repeat(40)),true);
  }finally{await pool.query('ALTER TABLE private.cursor_migration_absent RENAME TO strata_v13_signal_audit_progress');}
 });
 await t.test('RLS/revokes keep audit cursor inaccessible to authenticated application role',async()=>{
  const c=await pool.connect();try{await c.query('SET ROLE authenticated');await assert.rejects(c.query('SELECT * FROM private.strata_v13_signal_audit_progress'));}
  finally{await c.query('RESET ROLE');c.release();}
 });
 await t.test('real plans use bounded partial-index pages with all 10000 historical rows already traced',async()=>{
  await reset(10000);await pool.query("INSERT INTO private.strata_v13_signal_decisions(execution_account_id,evaluation_id,phase) SELECT 'acct',id,'QUALIFYING_SEEN' FROM forward_test_evaluations; ANALYZE forward_test_evaluations; ANALYZE private.strata_v13_signal_decisions");
  const plans=[];
  for(const [sql,args] of [[AUDIT_FIRST_PAGE_SQL,['2019-01-01','2021-01-01']],[AUDIT_NEXT_PAGE_SQL,['2019-01-01','2021-01-01','2020-01-01 00:00:00.005+00','005000']]] as const){
   const p=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,[...args])).rows[0]['QUERY PLAN'][0];plans.push(p);
   assert.equal(p.Plan['Node Type'],'Limit');assert.equal(p.Plan['Actual Rows'],100);
   assert.match(JSON.stringify(p),/forward_test_live_crosses/);assert.doesNotMatch(JSON.stringify(p),/"Node Type":"Sort"/);
  }
  const explainClient=await pool.connect();let decisionPlan;
  try{await explainClient.query('BEGIN');
   decisionPlan=(await explainClient.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+AUDIT_INSERT_PAGE_SQL,
    ['acct','a'.repeat(40),Array.from({length:100},(_,i)=>String(i+1).padStart(6,'0')),
     Array.from({length:100},()=> '2020-01-01')])).rows[0]['QUERY PLAN'][0];
  }finally{await explainClient.query('ROLLBACK');explainClient.release();}
  assert.match(JSON.stringify(decisionPlan),/Index Only Scan|Index Scan/);
  assert.doesNotMatch(JSON.stringify(decisionPlan),/"Node Type":"Seq Scan"/);
  plans.push(decisionPlan);
  writeFileSync(resolve('../../../cursor-audit-explain.json'),JSON.stringify(plans,null,2));
  assert.equal(await auditUnseenExpiredSignals('acct',pool),0);assert.equal(Number((await state()).sources_examined),100);
 });
 }finally{await pool.end();}
});
