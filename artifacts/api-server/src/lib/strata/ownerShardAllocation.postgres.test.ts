import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

test("owner shard allocation ledger fences one intent and rejects cross-account FK, wrong amount and replay",async(t)=>{
  let PGlite: new()=>{exec(sql:string):Promise<unknown>;query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;close():Promise<void>};
  try{
    PGlite=(createRequire(process.cwd()+"/package.json")("@electric-sql/pglite") as {PGlite:typeof PGlite}).PGlite;
  }catch{t.skip("pglite missing");return;}
  const db=new PGlite();
  const owner="11111111-1111-4111-8111-111111111111";
  const foreign="22222222-2222-4222-8222-222222222222";
  const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const account="33333333-3333-4333-8333-333333333333";
  const connection="44444444-4444-4444-8444-444444444444";
  const key="55555555-5555-4555-8555-555555555555";
  try{
    await db.exec(`
      CREATE SCHEMA auth;CREATE SCHEMA private;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE public.financial_accounts (id uuid PRIMARY KEY,user_id uuid NOT NULL, UNIQUE(id,user_id));
      CREATE TABLE private.provider_connections (id uuid PRIMARY KEY, financial_account_id uuid NOT NULL, UNIQUE(id,financial_account_id));
      CREATE TABLE private.kalshi_connection_credentials (id uuid PRIMARY KEY, owner_user_id uuid, provider_connection_id uuid, UNIQUE(id,owner_user_id,provider_connection_id));
      CREATE TABLE public.v13_production_account (id text PRIMARY KEY);
    `);
    await db.exec(readFileSync("../../lib/db/drizzle/0018_kalshi_owner_shard_allocations.sql","utf8"));
    await db.query("INSERT INTO auth.users(id) VALUES($1),($2)",[owner,foreign]);
    await db.query("INSERT INTO public.financial_accounts(id,user_id) VALUES($1,$2)",[account,owner]);
    await db.query("INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)",[connection,account]);
    await db.query("INSERT INTO private.kalshi_connection_credentials(id,owner_user_id,provider_connection_id) VALUES($1,$2,$3)",[key,owner,connection]);
    await db.query("INSERT INTO public.v13_production_account(id) VALUES('owned-a'),('owned-b')");
    const insert=`INSERT INTO private.kalshi_owner_shard_allocations
      (id,owner_user_id,execution_account_id,financial_account_id,provider_connection_id,authority_credential_id,authority_fingerprint,
       source_before_cents,destination_before_cents,bot_before_cents)
      VALUES($1,$2,$3,$4,$5,$6,$7,3450,0,0)`;
    await db.query(insert,[id,owner,"owned-a",account,connection,key,"a".repeat(64)]);
    await assert.rejects(()=>db.query(insert,[other,owner,"owned-a",account,connection,key,"a".repeat(64)]));
    await assert.rejects(()=>db.query(insert,[other,foreign,"owned-b",account,connection,key,"a".repeat(64)]));
    await assert.rejects(()=>db.query(`UPDATE private.kalshi_owner_shard_allocations SET amount_cents=3000 WHERE id=$1`,[id]));
    await assert.rejects(()=>db.query(`UPDATE private.kalshi_owner_shard_allocations SET destination_exchange_index=0 WHERE id=$1`,[id]));
    const claim=await db.query(`UPDATE private.kalshi_owner_shard_allocations SET state='attempted',attempted_at=now()
      WHERE id=$1 AND state='prepared' RETURNING id`,[id]);
    assert.equal(claim.rows.length,1);
    const replay=await db.query(`UPDATE private.kalshi_owner_shard_allocations SET state='attempted',attempted_at=now()
      WHERE id=$1 AND state='prepared' RETURNING id`,[id]);
    assert.equal(replay.rows.length,0);
  }finally{await db.close();}
});
