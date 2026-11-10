import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {pool, type PoolClient} from '@workspace/db';
import {ProductionWorker} from './worker';

// Actual worker discovery SQL against a fresh disposable PostgreSQL database.
// Temporary tables isolate query behavior. Reconciliation, preparation and
// dispatch are stubbed; this is NOT execution/financial-gate or race coverage.
// Those paths retain their separate real-executor/native qualification.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(url??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL,url);
after(()=>pool.end());
const NOW=Date.parse('2026-11-10T12:00:00.000Z');
async function fixture(run:(c:PoolClient,tick:()=>Promise<string[]>)=>Promise<void>){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query(`CREATE TEMP TABLE forward_test_evaluations (
   id text PRIMARY KEY,evaluated_at timestamptz NOT NULL,crossing_key text,
   evaluation_source text DEFAULT 'paper',qualifying_trigger boolean DEFAULT true,
   fresh_cross boolean DEFAULT true,signal text DEFAULT 'SCOUT');
   CREATE TEMP TABLE v13_production_account (id text PRIMARY KEY,policy_id text);
   CREATE TEMP TABLE v13_live_money_policy (
    id text PRIMARY KEY,execution_account_id text,state text,max_quote_age_ms int);
   CREATE TEMP TABLE v13_production_intent (
    id text PRIMARY KEY,account_id text,evaluation_id text,crossing_key text,kind text,state text);
   CREATE UNIQUE INDEX discovery_evaluation_unique ON v13_production_intent(account_id,evaluation_id);
   CREATE UNIQUE INDEX discovery_crossing_unique ON v13_production_intent(account_id,crossing_key) WHERE kind='ENTRY';
   CREATE TEMP TABLE v13_production_position (account_id text,quantity_hundredths bigint);
   INSERT INTO v13_production_account VALUES ('owned-account','policy');
   INSERT INTO v13_live_money_policy VALUES ('policy','owned-account','APPROVED',5000)`);
  const prepared:string[]=[];
  const executor={accountOwnerUserId:'synthetic-owner',now:()=>NOW,startTiming:()=>()=>{},
   ledger:{accountId:'owned-account',pool:{query:(sql:string,args:unknown[])=>c.query(sql,args)}},
   reconcile:async()=>{},prepareEntry:async(id:string)=>{prepared.push(id);return id;},dispatch:async()=>{}};
  const worker=new ProductionWorker(executor as never);
  try{await run(c,async()=>{prepared.length=0;await worker.tick();return [...prepared];});}
  finally{worker.stop();}
 }finally{await c.query('ROLLBACK');c.release();}
}
async function source(c:PoolClient,id:string,age=0,crossing=id){
 await c.query('INSERT INTO forward_test_evaluations(id,evaluated_at,crossing_key) VALUES($1,$2,$3)',
  [id,new Date(NOW-age),crossing]);
}
async function intent(c:PoolClient,id:string,evaluation:string,crossing:string,state:string,account='owned-account',kind='ENTRY'){
 await c.query('INSERT INTO v13_production_intent VALUES($1,$2,$3,$4,$5,$6)',
  [id,account,evaluation,crossing,kind,state]);
}

test('owned discovery omits attempted/terminal evaluations but preserves PREPARED and fresh sources',async()=>{
 await fixture(async(c,tick)=>{
  for(const state of ['BLOCKED','TERMINAL','DISPATCHED','UNKNOWN','PREPARED']){
   await source(c,state);await intent(c,'intent-'+state,state,state,state);
  }
  await source(c,'fresh');
  assert.deepEqual(await tick(),['fresh','PREPARED']);
 });
});
test('same evaluation with a different crossing exercises the independent evaluation exclusion',async()=>{
 await fixture(async(c,tick)=>{
  await source(c,'source',0,'current-crossing');
  await intent(c,'attempt','source','original-crossing','BLOCKED');
  assert.deepEqual(await tick(),[]);
 });
});
test('another evaluation for the same consumed crossing cannot cause redundant provider work',async()=>{
 await fixture(async(c,tick)=>{
  await source(c,'same-crossing',0,'cross');
  await intent(c,'attempt','prior-evaluation','cross','BLOCKED');
  assert.deepEqual(await tick(),[]);
 });
});
test('a PREPARED same-crossing intent remains included in discovery',async()=>{
 await fixture(async(c,tick)=>{
  await source(c,'same-crossing',0,'cross');
  await intent(c,'prepared','prior-evaluation','cross','PREPARED');
  assert.deepEqual(await tick(),['same-crossing']);
 });
});
test('other accounts and EXIT crossing keys cannot suppress this account\'s source',async()=>{
 await fixture(async(c,tick)=>{
  await source(c,'source',0,'cross');
  await intent(c,'other-owner','source','cross','BLOCKED','other-account');
  await intent(c,'exit','other-evaluation','cross','TERMINAL','owned-account','EXIT');
  assert.deepEqual(await tick(),['source']);
 });
});
test('attempted rows are removed before LIMIT 100 so they cannot crowd out an eligible source',async()=>{
 await fixture(async(c,tick)=>{
  for(let i=0;i<101;i++){
   const id='attempted-'+String(i).padStart(3,'0');
   await source(c,id,i);await intent(c,'intent-'+id,id,id,'BLOCKED');
  }
  await source(c,'fresh-older',1000);
  assert.deepEqual(await tick(),['fresh-older']);
 });
});
test('five-second policy age, future-time and approved-policy constraints remain exact',async()=>{
 await fixture(async(c,tick)=>{
  await source(c,'boundary',5000);await source(c,'expired',5001);await source(c,'future',-1);
  assert.deepEqual(await tick(),['boundary']);
  await c.query("UPDATE v13_live_money_policy SET state='REVOKED'");
  assert.deepEqual(await tick(),[]);
 });
});
test('a PREPARED-to-UNKNOWN transition removes the source on the next discovery',async()=>{
 await fixture(async(c,tick)=>{
  await source(c,'source');await intent(c,'intent','source','source','PREPARED');
  assert.deepEqual(await tick(),['source']);
  await c.query("UPDATE v13_production_intent SET state='UNKNOWN' WHERE id='intent'");
  assert.deepEqual(await tick(),[]);
 });
});
