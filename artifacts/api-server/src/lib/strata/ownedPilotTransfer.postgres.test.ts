import assert from "node:assert/strict";
import { createIsolatedLedgerTestDatabase, isolatedLedgerTestUrl } from "./isolatedLedgerTestDatabase";
import { readFileSync } from "node:fs";
import test from "node:test";

test("private pilot transfer ledger isolates owners and rejects duplicate or modified transfer identity",async()=>{
  const db=await createIsolatedLedgerTestDatabase();
  const owner="11111111-1111-4111-8111-111111111111";
  const foreign="22222222-2222-4222-8222-222222222222";
  const a="33333333-3333-4333-8333-333333333333";
  const conn="44444444-4444-4444-8444-444444444444";
  const cred="55555555-5555-4555-8555-555555555555";
  const x="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",y="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  try{
    await db.exec(`
      CREATE SCHEMA auth;CREATE SCHEMA private;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE public.financial_accounts (id uuid PRIMARY KEY,user_id uuid NOT NULL,provider text,
        UNIQUE(id,user_id));
      CREATE TABLE private.provider_connections (id uuid PRIMARY KEY,financial_account_id uuid NOT NULL,
        UNIQUE(id,financial_account_id));
      CREATE TABLE private.kalshi_connection_credentials (id uuid PRIMARY KEY,owner_user_id uuid,
        provider_connection_id uuid,UNIQUE(id,owner_user_id,provider_connection_id));
      CREATE TABLE public.v13_production_account (id text PRIMARY KEY);
    `);
    await db.exec(readFileSync("../../lib/db/drizzle/0017_kalshi_owner_pilot_transfers.sql","utf8"));
    await db.query("INSERT INTO auth.users(id) VALUES($1),($2)",[owner,foreign]);
    await db.query("INSERT INTO public.financial_accounts(id,user_id,provider) VALUES($1,$2,'kalshi')",[a,owner]);
    await db.query("INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)",[conn,a]);
    await db.query("INSERT INTO private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id) VALUES($1,$2,$3)",[cred,owner,conn]);
    await db.query("INSERT INTO public.v13_production_account(id) VALUES('bot-a'),('bot-b')");
    const insert=`INSERT INTO private.kalshi_owner_pilot_transfers
      (id,owner_user_id,execution_account_id,financial_account_id,provider_connection_id,
       authority_credential_id,authority_fingerprint,primary_before_cents,bot_before_cents)
      VALUES($1,$2,$3,$4,$5,$6,$7,3450,0)`;
    await db.query(insert,[x,owner,"bot-a",a,conn,cred,"a".repeat(64)]);
    await assert.rejects(()=>db.query(insert,[y,owner,"bot-a",a,conn,cred,"a".repeat(64)]));
    await assert.rejects(()=>db.query(insert,[y,foreign,"bot-b",a,conn,cred,"a".repeat(64)]));
    await assert.rejects(()=>db.query(insert,[y,owner,"bot-b",a,conn,cred,"a".repeat(64).replace("a","g")]));
    await assert.rejects(()=>db.query(`UPDATE private.kalshi_owner_pilot_transfers SET amount_cents=2600 WHERE id=$1`,[x]));
    await assert.rejects(()=>db.query(`UPDATE private.kalshi_owner_pilot_transfers SET exchange_index=0 WHERE id=$1`,[x]));
    const claims=await db.query(`UPDATE private.kalshi_owner_pilot_transfers
      SET state='attempted',attempted_at=now() WHERE id=$1 AND state='prepared' RETURNING id`,[x]);
    assert.equal(claims.rows.length,1);
    const retry=await db.query(`UPDATE private.kalshi_owner_pilot_transfers
      SET state='attempted',attempted_at=now() WHERE id=$1 AND state='prepared' RETURNING id`,[x]);
    assert.equal(retry.rows.length,0);
  }finally{await db.close();}
});


test("isolated ledger database fence rejects ambient/non-test destinations before connecting",()=>{
  const ci={NODE_ENV:"test",CI:"true",GITHUB_ACTIONS:"true",DATABASE_URL:"postgresql://postgres:test@127.0.0.1:5432/v13_ci"};
  assert.equal(isolatedLedgerTestUrl(ci).pathname,"/v13_ci");
  assert.equal(isolatedLedgerTestUrl({NODE_ENV:"test",V13_DISPOSABLE_DATABASE_URL:"postgresql://v13_test@127.0.0.1:5555/v13_disposable_123"}).pathname,"/v13_disposable_123");
  for(const change of [
    {NODE_ENV:"production"},{CI:"false"},{GITHUB_ACTIONS:"false"},
    {DATABASE_URL:"postgresql://postgres@test.example:5432/v13_ci"},
    {DATABASE_URL:"postgresql://postgres@127.0.0.1:5433/v13_ci"},
    {DATABASE_URL:"postgresql://postgres@127.0.0.1:5432/production"},
    {DATABASE_URL:"postgresql://other@127.0.0.1:5432/v13_ci"},
    {DATABASE_URL:"postgresql://postgres@127.0.0.1:5432/v13_ci?host=remote"},
    {V13_DISPOSABLE_DATABASE_URL:"postgresql://v13_test@remote:5555/v13_disposable_123"},
  ]) assert.throws(()=>isolatedLedgerTestUrl({...ci,...change}));
  assert.throws(()=>isolatedLedgerTestUrl({DATABASE_URL:ci.DATABASE_URL}));
});
