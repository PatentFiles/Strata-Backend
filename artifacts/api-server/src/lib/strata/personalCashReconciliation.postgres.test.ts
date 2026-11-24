import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool, PoolClient } from "@workspace/db";
import { ProductionLedger, type Account } from "../v13-production/ledger";
import { openCredentialFixture, type CredentialFixtureDb } from "./credentialFixtureDb.testHelper";
import { persistOwnedCashReconciliation, RECORD_OWNED_CASH_CONFIRMATION } from "./personalCashReconciliation";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "opening-basis-synthetic";
const NOW = Date.parse("2026-01-01T00:00:10Z");
const FUNDING = "2026-01-01T00:00:05Z";

async function fixture(t: TestContext): Promise<CredentialFixtureDb | null> {
  const db = await openCredentialFixture();
  if (!db) {
    assert.notEqual(process.env.STRATA_CREDENTIAL_NATIVE_TESTS, "1", "native test cannot skip");
    t.skip("optional local disposable PostgreSQL fixture unavailable");
    return null;
  }
  t.after(() => db.close());
  // Exact production column types relevant to this operation. Never run against
  // an existing account or production connection. Migration qualification is separate.
  await db.exec(`
    CREATE SCHEMA private;
    CREATE TABLE public.v13_production_account(
      id text PRIMARY KEY, owner_user_id uuid, kalshi_connection_id uuid,
      subaccount bigint NOT NULL, exchange_index bigint NOT NULL,
      cash_micros bigint NOT NULL, initial_cash_micros bigint NOT NULL,
      reserved_micros bigint NOT NULL DEFAULT 0, commissioned boolean NOT NULL DEFAULT false,
      cash_precision_verified boolean NOT NULL DEFAULT false,
      execution_enabled boolean NOT NULL DEFAULT false, kill_switch boolean NOT NULL DEFAULT true,
      key_fingerprint text DEFAULT 'fixture-fingerprint',reconciled_at timestamptz, blocked_reason text DEFAULT 'awaiting_account_commissioning'
    );
    CREATE TABLE public.v13_production_event(account_id text,cash_delta_micros bigint,pnl_micros bigint);
    CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
    CREATE TABLE public.v13_production_intent(account_id text,terminal boolean,state text,reserved_micros bigint);
    CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean,credential_fingerprint text,account_kill boolean);
    CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
    CREATE TABLE private.kalshi_owner_pilot_transfers(
      execution_account_id text,owner_user_id uuid,financial_account_id uuid,
      amount_cents integer,from_subaccount smallint,to_subaccount smallint,exchange_index smallint,
      state text,bot_before_cents bigint,bot_after_cents bigint,
      verified_exchange_transfer_id text,verified_at timestamptz,completed_at timestamptz
    );
    CREATE TABLE private.kalshi_owner_historical_funding(
      execution_account_id text,owner_user_id uuid,exchange_transfer_id text,
      transfer_created_at timestamptz,verified_at timestamptz,primary_after_cents bigint,bot_after_cents bigint
    );
    CREATE TABLE private.kalshi_owner_topups(execution_account_id text);
    CREATE TABLE private.strata_capital_credit_repair(execution_account_id text);
  `);
  await db.query(`INSERT INTO public.v13_production_account
    (id,owner_user_id,kalshi_connection_id,subaccount,exchange_index,cash_micros,initial_cash_micros)
    VALUES($1,$2,$3,1,2,0,0)`, [ACCOUNT,OWNER,CONNECTION]);
  await db.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,'released',false,'fixture-fingerprint',false)",[ACCOUNT,OWNER]);
  return db;
}
async function observe(db: CredentialFixtureDb, cents: number, time = NOW, owner = OWNER) {
  return persistOwnedCashReconciliation(db, {
    ownerUserId: owner, executionAccountId: ACCOUNT,
    confirmation: RECORD_OWNED_CASH_CONFIRMATION,
    subaccount: 1, exchangeIndex: 2, observedAtMs: time, nowMs: NOW, maxAgeMs: 15_000,
    subaccountBalance: { balance: cents }, primaryBalance: { balance: 0 },
  });
}
async function receipt(db: CredentialFixtureDb, owner = OWNER, cents = 2500) {
  await db.query(`INSERT INTO private.kalshi_owner_pilot_transfers VALUES
    ($1,$2,$3,$4::integer,0,1,2,'completed',0,$4::integer::bigint,'synthetic-receipt-1',$5,$5)`,
    [ACCOUNT,owner,CONNECTION,cents,FUNDING]);
}
async function account(db: CredentialFixtureDb): Promise<Record<string, unknown>> {
  const r = await db.query("SELECT * FROM public.v13_production_account WHERE id=$1",[ACCOUNT]);
  const a=r.rows[0]!;
  return {...a,cash_micros:String(a.cash_micros),initial_cash_micros:String(a.initial_cash_micros),reserved_micros:String(a.reserved_micros)};
}
async function conserve(db: CredentialFixtureDb) {
  const a = await account(db);
  const ledger = new ProductionLedger(db.nativePool as unknown as Pool, ACCOUNT);
  await ledger.assertConservation(db as unknown as PoolClient, a as unknown as Account);
  assert.equal(a.execution_enabled,false);
  assert.equal(a.kill_switch,true);
}
test("zero precision observation then registered funding establishes basis exactly once", async t => {
  const db = await fixture(t); if (!db) return;
  assert.equal((await observe(db,0,NOW-8000)).ok,true);
  assert.equal((await account(db)).cash_precision_verified,true);
  await receipt(db);
  assert.equal((await observe(db,2500)).ok,true);
  assert.equal((await account(db)).cash_micros,"25000000");
  assert.equal((await account(db)).initial_cash_micros,"25000000");
  await conserve(db);
  assert.equal((await observe(db,2500)).ok,true);
  await conserve(db);
  assert.equal((await observe(db,2600)).ok,false);
  assert.equal((await observe(db,0)).ok,false);
  assert.equal((await account(db)).cash_micros,"25000000");
  assert.equal((await account(db)).initial_cash_micros,"25000000");
  assert.equal(String((await db.query("SELECT count(*) AS n FROM private.kalshi_owner_pilot_transfers")).rows[0]!.n),"1");
});
test("funding before precision verification conserves the same opening basis", async t => {
  const db = await fixture(t); if (!db) return;
  await receipt(db);
  assert.equal((await observe(db,2500)).ok,true);
  await conserve(db);
});
test("positive balance alone, foreign receipt, wrong amount, stale evidence and duplicate receipts fail closed", async t => {
  const db = await fixture(t); if (!db) return;
  assert.equal((await observe(db,2500)).ok,false);
  await receipt(db,OTHER);
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("DELETE FROM private.kalshi_owner_pilot_transfers");
  await receipt(db,OWNER,2400);
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("DELETE FROM private.kalshi_owner_pilot_transfers");
  await receipt(db);
  assert.equal((await observe(db,2500,NOW-8000)).ok,false);
  assert.equal((await observe(db,2500,NOW,OTHER)).ok,false);
  await receipt(db);
  assert.equal((await observe(db,2500)).ok,false);
  await conserve(db);
});
test("historical funding receipt supports the same narrowly scoped transition", async t => {
  const db = await fixture(t); if (!db) return;
  assert.equal((await observe(db,0,NOW-8000)).ok,true);
  await db.query(`INSERT INTO private.kalshi_owner_historical_funding VALUES
    ($1,$2,'synthetic-historical',$3,$3,0,2500)`,[ACCOUNT,OWNER,FUNDING]);
  assert.equal((await observe(db,2500)).ok,true);
  await conserve(db);
});
test("initial basis is never overwritten for commissioned accounts", async t => {
  const db = await fixture(t); if (!db) return;
  await receipt(db);
  // Reproduce the already-commissioned legacy defect without running a
  // production recovery: the balance observer must not repair this account.
  await db.exec("UPDATE v13_production_account SET cash_micros=25000000,commissioned=true,cash_precision_verified=true,blocked_reason=NULL");
  assert.equal((await observe(db,2500)).ok,true);
  assert.equal((await account(db)).initial_cash_micros,"0");
  assert.equal((await observe(db,2600)).ok,false);
  assert.equal((await account(db)).cash_micros,"25000000");
  const a=await account(db);
  const ledger=new ProductionLedger(db.nativePool as unknown as Pool,ACCOUNT);
  await assert.rejects(()=>ledger.assertConservation(db as unknown as PoolClient,a as unknown as Account),/production_money_conservation_failed/);
});
test("trading activity, active execution and other capital movements prohibit opening-basis establishment", async t => {
  const db = await fixture(t); if (!db) return;
  await receipt(db);
  await db.exec("UPDATE v13_production_account SET execution_enabled=true,kill_switch=false");
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("UPDATE v13_production_account SET execution_enabled=false,kill_switch=true");
  await db.query("INSERT INTO private.kalshi_owner_topups VALUES($1)",[ACCOUNT]);
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("DELETE FROM private.kalshi_owner_topups");
  await db.query("INSERT INTO v13_production_intent VALUES($1,false,'UNKNOWN',0)",[ACCOUNT]);
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("DELETE FROM v13_production_intent");
  await db.query("INSERT INTO v13_production_event VALUES($1,0,0)",[ACCOUNT]);
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("DELETE FROM v13_production_event");
  await db.query("INSERT INTO v13_production_position VALUES($1,100,1000000,0)",[ACCOUNT]);
  assert.equal((await observe(db,2500)).ok,false);
  await db.exec("DELETE FROM v13_production_position");
  await conserve(db);
});

test("authorized stopped account renews equal cash without changing authority; active workers and holds refuse",async t=>{
 const db=await fixture(t);if(!db)return;
 await db.exec("UPDATE public.v13_production_account SET cash_micros=25000000,initial_cash_micros=25000000,commissioned=true,cash_precision_verified=true,blocked_reason=NULL,execution_enabled=true,kill_switch=false");
 assert.equal((await observe(db,2500)).ok,true);
 const before=await account(db);assert.equal(before.execution_enabled,true);assert.equal(before.kill_switch,false);
 for(const state of ['owned','claiming','killed']){
  await db.query('UPDATE private.kalshi_account_worker_lease SET state=$1',[state]);assert.equal((await observe(db,2500)).ok,false);
 }
 await db.exec("UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=true");assert.equal((await observe(db,2500)).ok,false);
 await db.exec("UPDATE private.kalshi_account_worker_lease SET arm_requested=false");
 assert.equal((await observe(db,2600)).ok,false);assert.equal((await observe(db,2500,NOW,OTHER)).ok,false);
 if(db.nativePool){
  const locker=await (db.nativePool as unknown as Pool).connect();let finished=false;
  try{await locker.query('BEGIN');await locker.query('SELECT * FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 FOR UPDATE',[ACCOUNT]);
   const renewal=observe(db,2500).then(r=>{finished=true;return r;});
   await new Promise(r=>setTimeout(r,80));assert.equal(finished,false);
   await locker.query('UPDATE private.kalshi_account_worker_lease SET arm_requested=true WHERE execution_account_id=$1',[ACCOUNT]);await locker.query('COMMIT');
   assert.equal((await renewal).ok,false,'concurrent ARM must defeat cash renewal');
  }finally{await locker.query('ROLLBACK');locker.release();}
  await db.exec('UPDATE private.kalshi_account_worker_lease SET arm_requested=false');
 }
 await db.exec("UPDATE public.v13_production_account SET blocked_reason='production_external_cash_mismatch'");assert.equal((await observe(db,2500)).ok,false);
 const after=await account(db);assert.equal(after.cash_micros,'25000000');assert.equal(after.initial_cash_micros,'25000000');assert.equal(after.execution_enabled,true);assert.equal(after.kill_switch,false);
});


test("killed commissioned account renews equal cash only with both account and worker gates closed",async t=>{
 const db=await fixture(t);if(!db)return;
 await db.exec("UPDATE public.v13_production_account SET cash_micros=25000000,initial_cash_micros=25000000,commissioned=true,cash_precision_verified=true,blocked_reason=NULL,execution_enabled=false,kill_switch=true");
 await db.exec("UPDATE private.kalshi_account_worker_lease SET state='killed',account_kill=true");
 assert.equal((await observe(db,2500)).ok,true);
 await db.exec("UPDATE private.kalshi_account_worker_lease SET account_kill=false");assert.equal((await observe(db,2500)).ok,false);
 await db.exec("UPDATE private.kalshi_account_worker_lease SET account_kill=true,arm_requested=true");assert.equal((await observe(db,2500)).ok,false);
 const a=await account(db);assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);assert.equal(a.cash_micros,'25000000');
});
