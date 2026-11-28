import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {pool} from '@workspace/db';
import {telemetryWriterPoolConfig,dedicatedTelemetryPool,closeTelemetryPool} from './telemetryWriterPool';
import {normalizeLiveDecision,confirmedBatch} from './liveDecisionAnalytics';

const URL=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL,URL);
assert.equal(process.env.NODE_ENV,'test');
const OWNER='10000000-0000-4000-8000-000000000001';
let writer:pg.Pool;
before(async()=>{
 await pool.query("CREATE SCHEMA IF NOT EXISTS private");
 await pool.query("CREATE TABLE public.v13_production_account(id text PRIMARY KEY, owner_user_id uuid NOT NULL, subaccount integer NOT NULL,exchange_index integer NOT NULL)");
 await pool.query("INSERT INTO public.v13_production_account VALUES ('synthetic-a',$1,1,2)",[OWNER]);
 await pool.query(readFileSync('../../lib/db/drizzle/0050_strata_live_decision_history.sql','utf8'));
 writer=new pg.Pool(telemetryWriterPoolConfig(URL!,process.env));
});
after(async()=>{await closeTelemetryPool();await writer?.end();await pool.end();});
test('advisory telemetry is restricted to a single separately timed connection',()=>{
 const conf=telemetryWriterPoolConfig(URL!,process.env);
 assert.equal(conf.max,1);
 assert.equal(conf.application_name,'strata_live_telemetry_writer');
 assert.equal(conf.connectionTimeoutMillis,1500);
 assert.equal(conf.idleTimeoutMillis,10_000);
});
test('lazy writer initializes one real isolated session only when requested',async()=>{
 const [first,second]=await Promise.all([dedicatedTelemetryPool(),dedicatedTelemetryPool()]);
 assert.equal(first,second);
 assert.equal(first.options.max,1);
 const answer=await first.query('SELECT 1::int AS result');
 assert.equal(answer.rows[0]?.result,1);
});
test('real account FK lock timeout does not monopolize financial query pool; identical UUID recovers',async()=>{
 const e=normalizeLiveDecision({ownerId:OWNER,accountId:'synthetic-a',releaseSha:'a'.repeat(40),
  observedAtMs:Date.now()-5000,stage:'OBSERVATION',outcome:'PASS',reasonCode:'no_fresh_cross',
  facts:{btcPrice:60000}})!;
 assert.ok(e);
 const financial=await pool.connect();
 let locked=true;
 try{
  await financial.query('BEGIN');
  await financial.query("SELECT id FROM public.v13_production_account WHERE id='synthetic-a' FOR UPDATE");
  const delivery=writer.connect().then(async client=>{
   try{
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='3000ms';SET LOCAL lock_timeout='750ms'");
    return await confirmedBatch(client,[e]);
   }catch(error){
    await client.query('ROLLBACK');
    throw error;
   }finally{client.release();}
  });
  // This independent financial/account read must not wait for an analytics
  // client checkout even while a blocked telemetry INSERT holds its own pool.
  const started=performance.now();
  const healthy=await pool.query("SELECT count(*)::int AS n FROM public.v13_production_account");
  assert.equal(healthy.rows[0].n,1);
  assert.ok(performance.now()-started<700);
  await assert.rejects(delivery,(err:unknown)=>{
   const e=err as {code?:string};return e.code==='55P03';
  });
  await financial.query('ROLLBACK');locked=false;
  const client=await writer.connect();
  try{
   await client.query('BEGIN');
   await client.query("SET LOCAL statement_timeout='3000ms';SET LOCAL lock_timeout='750ms'");
   assert.equal(await confirmedBatch(client,[e]),1);
   await client.query('COMMIT');
  }finally{client.release();}
  // Ambiguous transaction acknowledgment can safely replay the same event ID.
  const c2=await writer.connect();
  try{
   await c2.query('BEGIN');
   assert.equal(await confirmedBatch(c2,[e]),1);
   await c2.query('COMMIT');
  }finally{c2.release();}
  const saved=await pool.query("SELECT count(*)::int AS n FROM private.strata_live_decision_log_v1 WHERE id=$1",[e.id]);
  assert.equal(saved.rows[0].n,1);
 }finally{
  if(locked)await financial.query('ROLLBACK');
  financial.release();
 }
});
