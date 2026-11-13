import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const fixture=read('../src/lib/strata/restrictedPlatformAuth.fixture.ts');
const native=read('../src/lib/strata/restrictedPlatformAuth.postgres.test.ts');
const verifier=read('../src/lib/strata/reviewedProtectiveExitFee.ts');
// Source/syntax contracts ONLY. They cannot establish SQL, ACL/RLS, row locks,
// native execution, full typechecking, JWT authentication or platform parity.
test('platform fixture and native suite parse as TypeScript',()=>{
 for(const source of [fixture,native])assert.ok(stripTypeScriptTypes(source));
});
test('role DDL and grants retain the original full-schema and actual-session fence',()=>{
 assert.ok(fixture.indexOf('await installFullRecoverySchema(bootstrap)')<fixture.indexOf('CREATE ROLE'));
 assert.ok(fixture.indexOf('await assertBootstrapTarget(setup)')<fixture.indexOf('CREATE ROLE'));
 assert.match(fixture,/assert\.deepEqual\(actual,\{name:url\.pathname\.slice\(1\),user:'v13_test',host:'127\.0\.0\.1',port:Number\(url\.port\)\}\)/);
 assert.match(fixture,/export async function installPlatformCapabilities\(setup:Pool\)\{\s+await assertBootstrapTarget\(setup\)/);
 assert.ok(fixture.indexOf('await pool.end()')<fixture.indexOf('url.username=platformRuntimeRole'));
 assert.match(fixture,/LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
 assert.match(native,/SET SESSION AUTHORIZATION v13_test/);
 assert.match(native,/RESET ROLE/);
 assert.doesNotMatch(fixture,/from ['"]pg['"]|GRANT .*ALL (?:TABLES|SEQUENCES|FUNCTIONS)|ALTER DEFAULT PRIVILEGES|DISABLE (?:TRIGGER|ROW LEVEL SECURITY)|\bBYPASSRLS;/);
 const runner=read('./run-v13-disposable-postgres.mjs');
 assert.match(runner,/no connected-database fallback exists/);assert.match(runner,/offline_external_socket_denied/);
 assert.doesNotMatch(runner,/\.\.\.process\.env/);
});
test('canonical guard executes and rejects alternate targets without a database',()=>{
 const body=fixture.split('export function canonicalPlatformUrl(){')[1].split('\nasync function assertBootstrapTarget')[0];
 const check=env=>new Function('assert','process','URL','return function(){'+body)(assert,{env},URL)();
 const valid='postgresql://v13_test@127.0.0.1:54321/v13_disposable_123';
 assert.equal(check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid}).href,valid);
 assert.throws(()=>check({}));
 for(const invalid of [valid.replace('127.0.0.1','example.invalid'),valid.replace('v13_test','postgres'),
  valid.replace('v13_disposable_123','v13_ci'),valid+'?options=x',valid.replace('v13_test@','v13_test:password@')]){
  assert.throws(()=>check({DATABASE_URL:invalid,V13_DISPOSABLE_DATABASE_URL:invalid}));
 }
 assert.throws(()=>check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid+'4'}));
});
test('Auth owner and browser policies are catalog-shaped while helper bodies and MFA dependencies are explicitly synthetic',()=>{
 assert.match(fixture,/ALTER TABLE auth\.users OWNER TO \$\{platformManagedOwner\}/);
 assert.match(fixture,/ALTER TABLE auth\.users ENABLE ROW LEVEL SECURITY/);
 assert.match(fixture,/CREATE FUNCTION auth\.jwt\(\) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER/);
 assert.match(fixture,/GRANT SELECT ON public\.profiles TO authenticated/);
 assert.doesNotMatch(fixture,/GRANT UPDATE.*TO authenticated|GRANT authenticated TO/);
 for(const token of ['profiles_select_own_login_mfa','profiles_update_own_aal2','required_for_all=false','required_for_sign_in=false',"auth.jwt()->>'aal'"]){
  assert.ok(fixture.includes(token),token);
 }
 assert.match(native,/caller-controlled scaffolding, not cryptographic JWT authentication/);
 assert.match(native,/owner:platformManagedOwner,rls:true,force:false,policies:0/);
 assert.match(native,/SELECT-only ACL/);
 assert.match(native,/an unforced table owner bypasses RLS/);
});
test('lock inventory matches the real verifier relation-lock union and grants no technical writes',()=>{
 const object=fixture.split('export const platformLockColumns:Record<string,string>={')[1].split('\n};')[0];
 const map=new Function('return ({'+object+'})')();
 assert.deepEqual(Object.keys(map).sort(),[
  'public.v13_production_account','public.v13_live_money_policy','private.strata_api_fee_source_grants',
  'private.strata_api_fee_rate_reviews','private.strata_api_fee_owner_consents','private.strata_api_fee_standing_delegations',
  'private.strata_api_fee_standing_models','private.strata_standing_execution_reviews','auth.users','private.role_assignments','public.profiles',
 ].sort());
 assert.match(verifier,/LIMIT 2 FOR SHARE OF a,p,d,m,e,u,role,g,issuer,issuer_role/);
 // Independent execution reviewers are now conditionally locked inside EXISTS;
 // owner-self has no unrelated profile row. Monetary reviewers remain outer-locked.
 assert.match(verifier,/EXISTS\(SELECT 1 FROM public\.profiles reviewer WHERE reviewer\.id=e\.independent_reviewer_id AND reviewer\.role IN \('ADMIN','DEVELOPER'\) FOR SHARE\)/);
 assert.match(verifier,/m\.reviewer_admin_id<>a\.owner_user_id/);
 assert.match(fixture,/GRANT UPDATE\(\$\{column\}\) ON \$\{table\}/);
 assert.match(fixture,/AS RESTRICTIVE FOR UPDATE TO \$\{platformRuntimeRole\} USING\(true\) WITH CHECK\(false\)/);
 assert.doesNotMatch(fixture,/GRANT INSERT|GRANT DELETE|GRANT UPDATE\(lease_expires_at\)/);
 assert.match(native,/restrictive mutation guard survives an extra permissive policy/);
 assert.match(native,/assert\.equal\(\(await client\.query\(`UPDATE \$\{table\} SET \$\{column\}=\$\{column\}/);
});
test('native successor path preserves real SQL, fresh per-scope SHA, bounded model time and denial checks',()=>{
 assert.match(fixture,/sha:randomBytes\(20\)\.toString\('hex'\)/);
 assert.match(fixture,/now\(\)\+interval '23 hours',now\(\)-interval '1 second'/);
 for(const token of ['verifyReviewedProtectiveExitFeeAuthority','verifyReviewedProtectiveExitFee','inspectRuntimeDbSession',
  'statements.includes(REVIEW_SQL)','statements.includes(SUCCESSOR_SQL)',"['42501']","{code:'55P03'}",
  'committed change blocks next observation','human authority rows unchanged','protective_fee_standing_successor_missing',
  'protective_fee_independent_owner_review_missing','UPDATE public.profiles SET id=$1','competing same-SHA model fails closed']){
  assert.ok(native.includes(token),token);
 }
 assert.doesNotMatch(fixture+native,/process\.env\.(?:SUPABASE|KALSHI|STRATA_PRODUCTION)|fetch\(|https?:\/\/[^'"\s]*supabase/);
});
