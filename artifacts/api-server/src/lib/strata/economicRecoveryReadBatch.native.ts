import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {canonical,digest} from '../v13-production/types';
import {readEconomicHistoryBatch,readEconomicPendingMoneyBatch,readLockedDischargeHistoryAndMoney,readLockedDischargeFullHistory,readLockedBlockedDischargeEvidence} from './economicRecoveryReadBatch';
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
  await t.test('combined discharge projection exactly matches both original reads',async()=>{
   const c=await pool.connect();try{
    await c.query('BEGIN');
    const {pendingMoney,...history}=await readLockedDischargeHistoryAndMoney(c,account);
    assert.deepEqual(history,await readEconomicHistoryBatch(c,account,true));
    const expected=await readEconomicPendingMoneyBatch(c,account,true);
    assert.deepEqual(pendingMoney.map(sorted),expected.map(sorted));
    const empty=await readLockedDischargeHistoryAndMoney(c,"batch-owner' OR true --");
    for(const rows of [...Object.values(empty).slice(0,4),...empty.pendingMoney])assert.equal(rows.length,0);
   }finally{await c.query('ROLLBACK');c.release();}
  });
  await t.test('full locked batch keeps exact rows and defers downstream locks for supplemental evidence',async()=>{
   await pool.query(`CREATE TABLE public.v13_production_intent(id text,account_id text,state text,kind text,created_at timestamptz,reserved_micros bigint);
    CREATE TABLE private.strata_economic_exit_discharge(request_id uuid,execution_account_id text,released_reserve_micros bigint);
    INSERT INTO public.v13_production_intent VALUES('entry','batch-owner','TERMINAL','ENTRY','2026-11-25T00:00:00Z',9007199254740993);
    INSERT INTO private.strata_economic_exit_discharge VALUES('33333333-3333-4333-8333-333333333333','batch-owner',9007199254740993)`);
   const a=await pool.connect(),b=await pool.connect();
   try{
    await a.query('BEGIN');
    const clean=await readLockedDischargeFullHistory(a,account);
    assert.equal(clean.intents[0]?.reserved_micros,'9007199254740993');
    assert.equal(clean.discharges[0]?.released_reserve_micros,'9007199254740993');
    assert.deepEqual(clean.downstream,await readLockedDischargeHistoryAndMoney(a,account));
    await a.query('ROLLBACK');
    await a.query("UPDATE public.v13_production_intent SET state='BLOCKED'");
    await a.query('BEGIN');
    const blocked=await readLockedDischargeFullHistory(a,account);
    assert.equal(blocked.downstream,null);
    await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='60ms'");
    await b.query('UPDATE public.v13_production_position SET basis_micros=basis_micros WHERE account_id=$1',[account]);
    await b.query('ROLLBACK');
    await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='60ms'");
    await assert.rejects(b.query('UPDATE public.v13_production_intent SET state=state WHERE account_id=$1',[account]),{code:'55P03'});
   }finally{await b.query('ROLLBACK');await a.query('ROLLBACK');a.release();b.release();}
  });
  await t.test('supplemental batch preserves native evidence and locks for blocked entry and dispatched exit',async()=>{
   await pool.query(`CREATE TABLE public.v13_production_observation(id text,account_id text,kind text,payload jsonb,digest text,observed_at timestamptz);
    ALTER TABLE private.strata_emergency_exit_reservations ADD COLUMN client_order_id text,ADD COLUMN market_ticker text,
     ADD COLUMN reducing_side text,ADD COLUMN order_digest text,ADD COLUMN worker_holder_id text,ADD COLUMN worker_fencing_token bigint;
    UPDATE private.strata_emergency_exit_reservations SET client_order_id='exit',worker_fencing_token=9007199254740993;
    CREATE TABLE private.strata_protective_exit_local_no_send(reservation_id uuid,client_order_id text,execution_account_id text,
     worker_fencing_token bigint,quantity_hundredths integer,limit_micros bigint,evidence jsonb);
    INSERT INTO public.v13_production_observation VALUES
     ('a','batch-owner','PROVEN_NOT_POSTED','{"id":"entry"}','digest','2026-11-26T00:00:00.123456Z'),
     ('b','batch-owner','CANCEL_ATTEMPT','{"id":"exit"}','digest',now()),
     ('c','foreign-owner','PROVEN_NOT_POSTED','{"id":"exit"}','digest',now()),
     ('d','batch-owner','UNRELATED','{"id":"exit"}','digest',now());
    INSERT INTO private.strata_protective_exit_local_no_send VALUES
     ('11111111-1111-4111-8111-111111111111','exit','batch-owner',9007199254740993,300,400000,'{"ok":true}');`);
   const a=await pool.connect(),b=await pool.connect();
   try{
    await a.query('BEGIN');
    const out=await readLockedBlockedDischargeEvidence(a,account,['entry','exit'],['exit'],['exit'],true);
    const expected=(await a.query(`SELECT id,account_id,kind,payload,digest,observed_at,xmin::text AS row_revision
      FROM public.v13_production_observation WHERE account_id=$1 AND id IN ('a','b') ORDER BY id`,[account])).rows;
    assert.deepEqual(out.observations,expected);
    assert.equal(out.events.length,0);
    const markers=(await a.query(`SELECT reservation_id,owner_user_id::text AS owner_user_id,execution_account_id,client_order_id,
     state,trading_authorized,market_ticker,reducing_side,quantity_hundredths,order_request_json,order_digest,worker_holder_id,
     worker_fencing_token::text AS worker_fencing_token,xmin::text AS row_revision FROM private.strata_emergency_exit_reservations`)).rows;
    const local=(await a.query(`SELECT n.*,worker_fencing_token::text,quantity_hundredths::text,limit_micros::text,
     n.xmin::text AS row_revision FROM private.strata_protective_exit_local_no_send n`)).rows;
    assert.deepEqual(out.markers,markers);assert.deepEqual(out.localNoSends,local);
    assert.deepEqual(out.downstream,await readLockedDischargeHistoryAndMoney(a,account));
    const conflict=await readLockedBlockedDischargeEvidence(a,account,['intent'],['exit'],['exit'],true);
    assert.equal(conflict.events.length,1);assert.equal(conflict.downstream,null);assert.equal(conflict.markers.length,0);assert.equal(conflict.localNoSends.length,0);
    for(const sql of ["UPDATE public.v13_production_observation SET digest=digest WHERE id='a'",
     "UPDATE public.v13_production_event SET digest=digest WHERE event_id='b'",
     "UPDATE private.strata_emergency_exit_reservations SET state=state WHERE client_order_id='exit'",
     "UPDATE private.strata_protective_exit_local_no_send SET quantity_hundredths=quantity_hundredths WHERE client_order_id='exit'"]){
     await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='60ms'");
     await assert.rejects(b.query(sql),{code:'55P03'});await b.query('ROLLBACK');
    }
   }finally{await b.query('ROLLBACK');await a.query('ROLLBACK');a.release();b.release();}
  });
  await t.test('every original row lock is held until transaction completion',async()=>{
   const a=await pool.connect(),b=await pool.connect();
   try{
    await a.query('BEGIN');await readLockedDischargeHistoryAndMoney(a,account);
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
