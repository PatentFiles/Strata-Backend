import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

/**
 * Disposable CI PostgreSQL ONLY. Never run from Railway or Supabase production.
 * The test exercises the real migration rather than only matching source text.
 */
if (process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.DATABASE_URL?.includes("/v13_ci"))
  throw new Error("institutional_schema_test_requires_disposable_ci_database");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(`
 DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 END $$;
 CREATE SCHEMA IF NOT EXISTS auth;
 CREATE SCHEMA IF NOT EXISTS private;
 CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS public.v13_production_account(id text PRIMARY KEY);
 `);
  const base = await readFile("../../sql/strata_in_app_protective_release_approval.sql","utf8");
  const institutional = await readFile("../../sql/strata_institutional_code_approval_v1.sql","utf8");
  await client.query(base);
  await client.query(institutional);
  const { rows: table } = await client.query(`
 SELECT c.relrowsecurity AS rls
 FROM pg_class c
 WHERE c.oid='private.strata_durable_code_approvals'::regclass`);
  assert.equal(table.length,1);
  assert.equal(table[0].rls,true,"RLS must be enabled");
  const {rows: rights}=await client.query(`
 SELECT has_table_privilege('authenticated','private.strata_durable_code_approvals','INSERT') AS auth_insert,
        has_table_privilege('anon','private.strata_durable_code_approvals','SELECT') AS anon_read`);
  assert.equal(rights[0].auth_insert,false);
  assert.equal(rights[0].anon_read,false);
  const {rows: scope}=await client.query(`
 SELECT column_default,is_nullable FROM information_schema.columns
 WHERE table_schema='private' AND table_name='strata_protective_release_reviews'
 AND column_name='review_scope'`);
  assert.equal(scope.length,1);
  assert.equal(scope[0].is_nullable,"NO");
  const {rows: guard}=await client.query(`
 SELECT tgname FROM pg_trigger
 WHERE tgrelid='private.strata_durable_code_approvals'::regclass
 AND NOT tgisinternal AND tgname='strata_durable_code_approval_guard'`);
  assert.equal(guard.length,1,"immutable-revocation trigger must exist");
  const {rows: index}=await client.query(`
 SELECT indexname,indexdef FROM pg_indexes
 WHERE schemaname='private' AND tablename='strata_durable_code_approvals'
 AND indexname='strata_durable_code_active_per_owner_sha'`);
  assert.equal(index.length,1);
  assert.match(index[0].indexdef,/UNIQUE INDEX/);
  assert.match(index[0].indexdef,/revoked_at IS NULL/i);
  // Repeat migrations to prove idempotent schema effects.
  await client.query(base);
  await client.query(institutional);
  console.log("Disposable institutional code-approval migration and private role guards: PASS");
} finally {
  await client.end();
}
