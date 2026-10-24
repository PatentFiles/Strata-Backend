import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pool} from "@workspace/db";

/**
 * REAL disposable PostgreSQL execution of the EXACT migrations 0036 + 0037.
 * Uses isolated shadow schemas with only FAKE accounts/auth users. Never
 * accepts a remote DATABASE_URL and never mutates Strata production.
 */
test("V3 evidence->authority composite FK, private RLS and one-shot revocation",async()=>{
 const raw=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(raw,"disposable PostgreSQL runner required");
 const url=new URL(raw);
 assert.equal(["localhost","127.0.0.1"].includes(url.hostname),true);
 const p="strata_v3_test_private",u="strata_v3_test_public",a="strata_v3_test_auth";
 const owner="11111111-1111-4111-8111-111111111111",
  stranger="22222222-2222-4222-8222-222222222222",
  attestation="33333333-3333-4333-8333-333333333333",
  authority="44444444-4444-4444-8444-444444444444";
 const sha="a".repeat(40),hash="b".repeat(64);
 const subst=(text:string)=>text
   .replace(/\bprivate\./g,p+".")
   .replace(/\bpublic\./g,u+".")
   .replace(/\bauth\./g,a+".");
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${p}; CREATE SCHEMA ${u}; CREATE SCHEMA ${a}`);
  await client.query(`CREATE TABLE ${a}.users (id uuid primary key)`);
  await client.query(`CREATE TABLE ${u}.v13_production_account (id text primary key)`);
  await client.query(`INSERT INTO ${a}.users (id) VALUES ($1),($2)`,[owner,stranger]);
  await client.query(`INSERT INTO ${u}.v13_production_account(id) VALUES('strata-account-test')`);
  for(const role of ["anon","authenticated","service_role"])
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}')
      THEN CREATE ROLE ${role}; END IF; END $$`);
  const e=readFileSync("../../lib/db/drizzle/0036_owner_fee_v3_evidence.sql","utf8")
    .replace("BEGIN;","").replace("COMMIT;","");
  const g=readFileSync("../../lib/db/drizzle/0037_owner_v3_fee_authority.sql","utf8")
    .replace("BEGIN;","").replace("COMMIT;","");
  await client.query(subst(e));
  await client.query(subst(g));
  const consent=async()=>{
   await client.query(`INSERT INTO ${p}.strata_owner_fee_evidence_v3
   (attestation_id,owner_user_id,execution_account_id,release_commit_sha,
    source_digest,market_ticker,verification_stage,source_kind,
    owner_confirmation,expires_at)
   VALUES ($1,$2,'strata-account-test',$3,$4,'KXBTC15M-TEST','STEP_9',
    'official_kalshi_server_verified_v3',
    'I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3',now()+interval '2 hours')`,
    [attestation,owner,sha,hash]);
  };
  await consent();
  const sql=`INSERT INTO ${p}.strata_owner_fee_authority_v3
   (authority_id,attestation_id,owner_user_id,execution_account_id,
    release_commit_sha,official_source_digest,official_source_url,
    policy_version,formula_version,scope,authorized_stages,confirmation,expires_at)
   VALUES ($1,$2,$3,'strata-account-test',$4,$5,
    'https://kalshi.com/docs/kalshi-fee-schedule.pdf',
    'strata_owner_official_monetary_fee_v3','standard-quadratic-0.07-v1',
    'KXBTC15M:INDEX2:SUBACCOUNT1',
    ARRAY['STEP_9','STEP_11','ORDER_ENTRY']::text[],
    'I_APPROVE_MY_OWN_VERIFIED_MONETARY_FEE_GRANT_V3',now()+interval '15 minutes')`;
  const reject=async(args:unknown[])=>{
    await client.query("SAVEPOINT invalid_case");
    await assert.rejects(client.query(sql,args));
    await client.query("ROLLBACK TO SAVEPOINT invalid_case");
  };
  await reject([authority,attestation,stranger,sha,hash]);
  await reject([authority,attestation,owner,"c".repeat(40),hash]);
  await reject([authority,attestation,owner,sha,"f".repeat(64)]);
  await client.query(sql,[authority,attestation,owner,sha,hash]);
  const rights=await client.query(`SELECT
   has_table_privilege('authenticated','${p}.strata_owner_fee_authority_v3','SELECT') AS read_ok,
   has_table_privilege('service_role','${p}.strata_owner_fee_authority_v3','INSERT') AS service_write_ok,
   (SELECT relrowsecurity FROM pg_class WHERE oid='${p}.strata_owner_fee_authority_v3'::regclass) AS rls`);
  assert.equal(rights.rows[0]?.read_ok,false);
  assert.equal(rights.rows[0]?.service_write_ok,false);
  assert.equal(rights.rows[0]?.rls,true);
  await client.query(`UPDATE ${p}.strata_owner_fee_authority_v3
    SET revoked_at=now(),revocation_reason='owner_requested_v3_fee_revocation'
    WHERE authority_id=$1`,[authority]);
  await client.query("SAVEPOINT immutable_update");
  await assert.rejects(client.query(`UPDATE ${p}.strata_owner_fee_authority_v3
    SET revoked_at=NULL WHERE authority_id=$1`,[authority]),/immutable_v3_fee_authority/);
  await client.query("ROLLBACK TO SAVEPOINT immutable_update");
  await client.query("SAVEPOINT immutable_delete");
  await assert.rejects(client.query(`DELETE FROM ${p}.strata_owner_fee_authority_v3
     WHERE authority_id=$1`,[authority]),/immutable_v3_fee_authority/);
  await client.query("ROLLBACK TO SAVEPOINT immutable_delete");
 }finally{
  try{await client.query("ROLLBACK");}finally{client.release();}
 }
});
