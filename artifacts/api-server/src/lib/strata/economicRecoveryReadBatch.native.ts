import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {canonical,digest} from '../v13-production/types';
import {readEconomicHistoryBatch,readEconomicPendingMoneyBatch} from './economicRecoveryReadBatch';
assert.equal(process.env.STRATA_ISOLATED_ECONOMIC_TEST,'1');
assert.ok(process.env.STRATA_ECONOMIC_SOCKET?.startsWith('/tmp/strata-economic-'));
const account='batch-owner',foreign='foreign-owner';
const history=[
 ['public.v13_production_event','account_id','event_id'],
 ['public.v13_production_position','account_id','id'],
 ['private.strata_emergency_exit_reservations','execution_account_id','reservation_id'],
 ['private.strata_protective_exit_reconciliations','execution_account_id','reservation_id'],
] as const;
const pending=['private.kalshi_owner_topups','private.kalshi_owner_shard_allocations','private.kalshi_owner_pilot_transfers','private.strata_manual_profit_withdrawals','private.strata_auto_withdrawal_maintenance'];
const sorted=(rows:Record<string,unknown>[])=>rows.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
test('native lossless recovery batching preserves scope, financial hashes, bounds and row locks',async t=>{
 try{
  await pool.query(`CREATE SCHEMA private;
   CREATE TABLE public.v13_production_event(account_id text,event_id text,intent_id text,kind text,digest text,payload jsonb,cash_delta_micros bigint,pnl_micros bigint,occurred_at timestamptz);
   CREATE TABLE public.v13_production_position(id text,account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
   CREATE TABLE private.strata_emergency_exit_reservations(reservation_id uuid,execution_account_id text,owner_user_id uuid,state text,trading_authorized boolean,quantity_hundredths bigint,order_request_json text,created_at timestamptz);
   CREATE TABLE private.strata_protective_exit_reconciliations(reservation_id uuid,execution_account_id text,filled_hundredths bigint,remaining_hundredths bigint,reconciled_at timestamptz);
   INSERT INTO public.v13_production_event VALUES('batch-owner','b','intent','SETTLEMENT','digest','{"amount":"9007199254740993","nested":[true,null]}',9007199254740993,-9007199254740993,'2026-11-26T00:00:00.123456Z'),('batch-owner','a',NULL,'FILL','digest','{}',0,0,'2026-11-25T00:00:00Z'),('foreign-owner','foreign','intent','FILL','digest','{}',12,12,now());
   INSERT INTO public.v13_production_position VALUES('position','batch-owner','KXBTC15M-SYNTHETIC','NO',0,0,9007199254740993);
   INSERT INTO private.strata_emergency_exit_reservations VALUES('11111111-1111-4111-8111-111111111111','batch-owner','22222222-2222-4222-8222-222222222222','UNKNOWN',false,300,'{"quoted":"value"}','2026-11-26T01:02:03.987654Z');
   INSERT INTO private.strata_protective_exit_reconciliations VALUES('33333333-3333-4333-8333-333333333333','batch-owner',9007199254740993,0,'2026-11-26T01:02:03.987654Z');`);
  for(const table of pending){
   // Minimal disposable shape deliberately covers every native scalar type
   // carried by the real full-schema acceptance (which runs separately).
   await pool.query(`CREATE TABLE ${table}(execution_account_id text,state text,amount_cents bigint,source_exchange_index smallint,attempts integer,owner_user_id uuid,completed_at timestamptz,was_armed boolean,note text,exact_numeric numeric,payload jsonb);
    INSERT INTO ${table} VALUES('batch-owner','completed',9007199254740993,2,3,'22222222-2222-4222-8222-222222222222','2026-11-26T01:02:03.987654Z',false,NULL,123.450000,'{"amount":"9007199254740993"}'),('foreign-owner','uncertain',-1,1,0,NULL,NULL,true,'foreign',0,'{}');`);
  }
  await t.test('same native row values and canonical financial digest, including int8 beyond 2^53',async()=>{
   const actual=Object.values(await readEconomicHistoryBatch(pool,account,false));
   for(const [index,[table,scope,key]] of history.entries()){
    const expected=(await pool.query(`SELECT t.*,t.xmin::text AS row_revision FROM ${table} t WHERE ${scope}=$1 ORDER BY ${key}`,[account])).rows;
    assert.deepEqual(actual[index],expected);assert.equal(digest(actual[index]),digest(expected));
   }
   const money=await readEconomicPendingMoneyBatch(pool,account,false);
   for(const [index,table] of pending.entries()){
    const expected=(await pool.query(`SELECT t.*,t.xmin::text AS row_revision FROM ${table} t WHERE execution_account_id=$1`,[account])).rows;
    assert.deepEqual(sorted(money[index]!),sorted(expected));assert.equal(digest(money[index]),digest(expected));
   }
  });
  await t.test('foreign and SQL-looking account values cannot borrow another account history',async()=>{
   const empty=await readEconomicHistoryBatch(pool,"batch-owner' OR true --",false);
   assert.ok(Object.values(empty).every(rows=>rows.length===0));
   assert.equal((await readEconomicHistoryBatch(pool,foreign,false)).events.length,1);
   assert.ok((await readEconomicPendingMoneyBatch(pool,foreign,false)).every(rows=>rows.length===1&&rows[0]!.state==='uncertain'));
  });
  await t.test('every original row lock is held until transaction completion',async()=>{
   const a=await pool.connect(),b=await pool.connect();
   try{
    await a.query('BEGIN');await readEconomicHistoryBatch(a,account,true);await readEconomicPendingMoneyBatch(a,account,true);
    for(const [table,scope] of [...history.map(([table,scope])=>[table,scope]),...pending.map(table=>[table,'execution_account_id'])]){
     await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='60ms'");
     await assert.rejects(b.query(`UPDATE ${table} SET ${scope}=${scope} WHERE ${scope}=$1`,[account]),{code:'55P03'});
     await b.query('ROLLBACK');
    }
   }finally{await a.query('ROLLBACK');a.release();b.release();}
  });
  await t.test('row limit retains the extra sentinel instead of silently treating truncated history as complete',async()=>{
   await pool.query("INSERT INTO public.v13_production_position SELECT 'many-'||n,'bounded','KXBTC15M-SYNTHETIC','YES',0,0,0 FROM generate_series(1,1002) n");
   assert.equal((await readEconomicHistoryBatch(pool,'bounded',false)).positions.length,1001);
  });
  await t.test('SQL permissions remain effective; batching grants no new capability',async()=>{
   const c=await pool.connect();try{
    await c.query('CREATE ROLE economic_batch_denied NOLOGIN');await c.query('BEGIN');await c.query('SET LOCAL ROLE economic_batch_denied');
    await assert.rejects(readEconomicHistoryBatch(c,account,false),{code:'42501'});
   }finally{await c.query('ROLLBACK');c.release();}
  });
 }finally{await pool.end();}
});
