import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const fixture=read('../src/lib/strata/restrictedStandingRenewal.fixture.ts');
const native=read('../src/lib/strata/restrictedStandingRenewal.postgres.test.ts');
// Dependency-free checks supplement native PG. They do NOT establish ACL/RLS,
// SQL semantics, concurrency, bundling, full typechecking or runtime success.
test('standing renewal fixture and native tests parse as TypeScript',()=>{
 for(const source of [fixture,native])assert.ok(stripTypeScriptTypes(source));
});
test('Auth seed parameters stay UUID-typed before reuse as email text',()=>{
 const seed=fixture.split('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES')[1].split('`')[0];
 for(const parameter of [1,2,3]){
  assert.ok(seed.includes(`($${parameter}::uuid,($${parameter}::uuid)::text||'@example.invalid',now())`));
 }
 assert.doesNotMatch(seed,/\$\d+::text/);
});
test('new role DDL is behind unchanged full-chain and actual-session fences',()=>{
 assert.ok(fixture.indexOf('await installFullRecoverySchema(bootstrap)')<fixture.indexOf('CREATE ROLE'));
 assert.ok(fixture.indexOf('assert.deepEqual(actual')<fixture.indexOf('CREATE ROLE'));
 assert.match(fixture,/LOGIN NOINHERIT NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
 assert.match(fixture,/url.username=standingRuntimeRole/);
 assert.ok(fixture.indexOf('await pool.end()')<fixture.indexOf('url.username=standingRuntimeRole'));
 assert.doesNotMatch(fixture,/from ['"]pg['"]|GRANT .*ALL (?:TABLES|SEQUENCES|FUNCTIONS)|ALTER DEFAULT PRIVILEGES|DISABLE (?:TRIGGER|ROW LEVEL SECURITY)/);
 assert.doesNotMatch(fixture,/process\.env\.(?:SUPABASE|KALSHI|STRATA_PRODUCTION)/);
 const runner=read('./run-v13-disposable-postgres.mjs');
 assert.match(runner,/no connected-database fallback exists/);
 assert.match(runner,/offline_external_socket_denied/);
 assert.doesNotMatch(runner,/\.\.\.process\.env/);
});
test('canonical target guard rejects remote, altered, mismatched and missing targets',()=>{
 const body=fixture.split('export function canonicalStandingUrl(){')[1].split('\nexport async function openRestrictedStandingRenewal')[0];
 const guard=new Function('assert','process','URL','return function(){'+body) (assert,{env:{}},URL);
 // Recompile with each isolated environment; do not mutate process.env.
 const check=env=>new Function('assert','process','URL','return function(){'+body)(assert,{env},URL)();
 assert.throws(guard);
 const valid='postgresql://v13_test@127.0.0.1:54321/v13_disposable_123';
 assert.equal(check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid}).href,valid);
 for(const invalid of [valid.replace('127.0.0.1','example.invalid'),valid.replace('v13_test','postgres'),
  valid.replace('v13_disposable_123','v13_ci'),valid+'?options=x',valid.replace('v13_test@','v13_test:password@')]){
  assert.throws(()=>check({DATABASE_URL:invalid,V13_DISPOSABLE_DATABASE_URL:invalid}));
 }
 assert.throws(()=>check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid+'4'}));
});
test('synthetic platform change and human/technical permission separation remain explicit',()=>{
 assert.match(fixture,/EXPLICIT SYNTHETIC PLATFORM ADDITION/);
 assert.match(fixture,/ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY/);
 assert.match(fixture,/profiles is absent from this source-qualified platform fixture/);
 assert.match(fixture,/GRANT UPDATE\(lease_expires_at\) ON \$\{feeDelegation\}/);
 assert.match(fixture,/AS RESTRICTIVE FOR UPDATE TO \$\{standingRuntimeRole\} USING\(true\) WITH CHECK\(false\)/);
 assert.match(fixture,/AS RESTRICTIVE FOR INSERT TO \$\{standingRuntimeRole\}/);
 assert.match(fixture,/WITH CHECK\(kind='LEASE_RENEWED' AND reason='signed_owned_reconciliation'\)/);
 assert.doesNotMatch(fixture,/CREATE TABLE|CREATE (?:OR REPLACE )?FUNCTION/);
});
test('native cases exercise real functions, denied writes, locks, revocation and late rollback',()=>{
 for(const token of ['renewContinuousTechnicalLease','renewStandingFeeObservationLease','checkContinuousEligibility',
  'standingHumanSnapshot','standingTechnicalSnapshot','technical_upsert_completed',"code:'55P03'",'generation,2',
  "'GRANT_AUTHORIZED','GRANT_REVOKED'",'revocation_reason','fencing_token=8','SELECT nextval','ROLLBACK']){
  assert.ok((native+fixture).includes(token),token);
 }
 assert.match(native,/for\(const existing of \[false,true\]\)/);
 assert.match(native,/for\(const column of technicalAuditInsertColumns\)/);
 assert.match(native,/SELECT ACL alone gives no rows under RLS/);
 assert.match(native,/human approval bytes and expiries unchanged/);
 assert.match(native,/actual renewal locks fence concurrent revocation/);
});
