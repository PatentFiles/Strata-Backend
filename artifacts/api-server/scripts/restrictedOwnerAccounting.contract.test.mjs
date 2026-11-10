import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const source=read('../src/lib/strata/restrictedOwnerAccounting.postgres.test.ts');
const helper=read('../src/lib/strata/restrictedProtectiveRuntime.fixture.ts');
const manifest=JSON.parse(read('../package.json'));
// These executable/parser/source contracts do not establish native PG success.
test('owner accounting test parses and rejects any noncanonical database target',()=>{
 assert.ok(stripTypeScriptTypes(source));
 const guard=source.slice(source.indexOf('const url='),source.indexOf('const NativePool'));
 const check=env=>new Function('assert','process',guard+';return url;')(assert,{env});
 const valid='postgresql://v13_test@127.0.0.1:54321/v13_disposable_123';
 assert.equal(check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid}),valid);
 for(const invalid of [undefined,valid.replace('127.0.0.1','remote.invalid'),valid.replace('v13_test','postgres'),valid+'?options=x',valid.replace('v13_disposable_123','v13_ci')]){
  assert.throws(()=>check({DATABASE_URL:invalid,V13_DISPOSABLE_DATABASE_URL:invalid}));
 }
 assert.throws(()=>check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid+'4'}));
});
test('restricted accounting role cannot use owner impersonation or ambient transport',()=>{
 assert.match(source,/LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
 assert.ok(source.indexOf('assert.deepEqual((await setup.query')<source.indexOf('CREATE ROLE'));
 assert.match(source,/parsed.username=role/);
 assert.match(source,/await pool.end\(\);pool.query=runtime.query.bind\(runtime\)/);
 assert.match(source,/pool.connect=runtime.connect.bind\(runtime\)/);
 assert.match(source,/restricted_accounting_external_io_forbidden/);
 assert.doesNotMatch(source,/from ['"]pg['"]|process\.env\.(?:SUPABASE|KALSHI|STRATA_PRODUCTION)/);
 assert.doesNotMatch(source,/GRANT .*ALL (?:TABLES|SEQUENCES|FUNCTIONS)|ALTER DEFAULT PRIVILEGES|DISABLE TRIGGER/);
});
test('accounting permits killing and bookkeeping without reenable, rearm or order issuance',()=>{
 assert.match(source,/WITH CHECK\(kill_switch=true AND execution_enabled=false\)/);
 assert.match(source,/WITH CHECK\(state='killed' AND account_kill=true AND arm_requested=false\)/);
 assert.match(source,/for\(const table of \['public.v13_production_event','public.v13_production_observation'\]\)/);
 assert.match(source,/real LOGIN cannot regain bootstrap or issue policy, intent, lease or reservation rows/);
 assert.match(source,/fenceOwnerUnknownForAccounting/);
 assert.match(source,/createHeldUnknownAccountingRecovery/);
 assert.match(source,/risk|blocked_reason/);
});
test('native assertions cover rollback, actual lock waits and uncertain COMMIT',()=>{
 for(const token of ['positively observed in-transaction trace','pg_stat_activity','wait_event_type',
  "row?.wait_event_type==='Lock'",'seedRestrictedInactiveActivity',"'42501'",'synthetic_receipt_failure',
  'synthetic_commit_ack_lost','recovery_accounting_commit_outcome_unverified','recovery_kill_receipt_binding_changed'])assert.ok(source.includes(token),token);
 assert.match(source,/for\(const sql of reactivations\)/);
 assert.match(source,/new reservation INSERT waits on the parent account FK/);
 assert.match(helper,/export async function seedRestrictedInactiveActivity/);
 assert.match(helper,/await seedRestrictedInactiveActivity\(setup,accountId,ownerId\)/);
});
test('both new gap suites run through the unchanged offline native runner',()=>{
 assert.ok(manifest.scripts['test:restricted-recovery-gaps'].includes('restrictedOwnerAccounting.postgres.test.ts'));
 assert.ok(manifest.scripts['test:restricted-recovery-gaps'].includes('restrictedStandingRenewal.postgres.test.ts'));
 assert.ok(manifest.scripts['test:v13-safety-all'].includes('pnpm run test:restricted-recovery-gaps'));
 const runner=read('./run-v13-disposable-postgres.mjs');
 assert.match(runner,/no connected-database fallback exists/);
 assert.match(runner,/offline_external_socket_denied/);
 assert.doesNotMatch(runner,/\.\.\.process\.env/);
});
