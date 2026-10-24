import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pool} from "@workspace/db";

/** Execute exact Wallets 0038 migration on isolated disposable PostgreSQL only. */
test("Wallets V4 immutable owner AAL2 fee authority has scoped FK, TTL and private RLS",async()=>{
 const raw=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(raw,"disposable postgres required");
 const parsed=new URL(raw);
 assert.ok(["localhost","127.0.0.1"].includes(parsed.hostname));
 const client=await pool.connect();
 const p="wallet_v4_test_private",pub="wallet_v4_test_public",auth="wallet_v4_test_auth";
 const owner="11111111-1111-4111-8111-111111111111";
 const stranger="22222222-2222-4222-8222-222222222222";
 const evidence="33333333-3333-4333-8333-333333333333";
 const authority="44444444-4444-4444-8444-444444444444";
 try{
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${p}; CREATE SCHEMA ${pub}; CREATE SCHEMA ${auth}`);
  await client.query(`CREATE TABLE ${auth}.users (id uuid primary key)`);
  await client.query(`CREATE TABLE ${pub}.v13_production_account (id text primary key)`);
  await client.query(`INSERT INTO ${auth}.users(id) VALUES($1),($2)`,[owner,stranger]);
  await client.query(`INSERT INTO ${pub}.v13_production_account(id) VALUES('wallet-test-account')`);
  for(const role of ["anon","authenticated","service_role"])
   await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}')
     THEN CREATE ROLE ${role}; END IF; END $$`);
  const migration=readFileSync("../../lib/db/drizzle/0038_wallet_v4_dynamic_fee_authority.sql","utf8")
    .replace("BEGIN;","").replace("COMMIT;","")
    .replace(/\\bprivate\\./g,p+".")
    .replace(/\\bpublic\\./g,pub+".")
    .replace(/\\bauth\\./g,auth+".");
  await client.query(migration);
  const names=await client.query(`SELECT relname,relrowsecurity FROM pg_class
     WHERE relname IN ('strata_wallet_v4_fee_evidence','strata_wallet_v4_fee_authority')`);
  assert.equal(names.rows.length,2);
  assert.ok(names.rows.every(r=>r.relrowsecurity===true));
  const args=[evidence,owner,"wallet-test-account","a".repeat(40),"KXBTC15M-TEST",
    "b".repeat(64),"c".repeat(64),"d".repeat(64)];
  const insertEvidence=`INSERT INTO ${p}.strata_wallet_v4_fee_evidence
    (evidence_id,owner_user_id,execution_account_id,deployed_sha,market_ticker,
      model_digest,official_source_digest,market_metadata_digest,effective_at,
      fee_type,taker_coefficient_ppm,expires_at)
    VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,now()-interval '1 day',
      'quadratic',70000,now()+interval '10 minutes')`;
  await client.query(insertEvidence,args);
  const authSql=`INSERT INTO ${p}.strata_wallet_v4_fee_authority
    (authority_id,evidence_id,owner_user_id,execution_account_id,
    deployed_sha,model_digest,policy_hash,policy_version,confirmation,
    aal2_verified_at,authorized_stages,expires_at)
    VALUES ($1,$2,$3::uuid,'wallet-test-account',$4,$5,$6,
     'strata_owner_provider_dynamic_fee_v4',
     'I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4',now()-interval '1 minute',
     ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],now()+interval '10 minutes')`;
  const authParams=[authority,evidence,owner,"a".repeat(40),"b".repeat(64),"e".repeat(64)];
  await client.query("SAVEPOINT badowner");
  await assert.rejects(client.query(authSql,[...authParams.slice(0,2),stranger,...authParams.slice(3)]));
  await client.query("ROLLBACK TO SAVEPOINT badowner");
  await client.query(authSql,authParams);
  await client.query("SAVEPOINT edit");
  await assert.rejects(client.query(`UPDATE ${p}.strata_wallet_v4_fee_authority
    SET model_digest=$1 WHERE authority_id=$2`,["f".repeat(64),authority]));
  await client.query("ROLLBACK TO SAVEPOINT edit");
  await client.query(`UPDATE ${p}.strata_wallet_v4_fee_authority SET
    revoked_at=now(),revocation_reason='test owner revoked' WHERE authority_id=$1`,[authority]);
  await client.query("SAVEPOINT rerevoke");
  await assert.rejects(client.query(`UPDATE ${p}.strata_wallet_v4_fee_authority
    SET revocation_reason='again' WHERE authority_id=$1`,[authority]));
  await client.query("ROLLBACK TO SAVEPOINT rerevoke");
 }finally{
  await client.query("ROLLBACK");client.release();
 }
});
