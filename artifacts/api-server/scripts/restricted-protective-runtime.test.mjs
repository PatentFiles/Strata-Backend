import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const api=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(resolve(api,p),'utf8');
const source=read('src/lib/strata/restrictedProtectiveRuntime.fixture.ts');
const held=read('src/lib/strata/heldSupervisorDispatch.postgres.fixture.ts');
const scripts=JSON.parse(read('package.json')).scripts;
// Static contracts supplement, never replace, the three native PG scenarios.
test('restricted held qualification is pinned before any disposable role DDL',()=>{
 assert.match(source,/url===process\.env\.DATABASE_URL/);
 assert.ok(source.includes('v13_test@127\\.0\\.0\\.1:\\d+\\/v13_disposable_\\d+$'));
 assert.ok(source.indexOf('assert.deepEqual(actual')<source.indexOf('CREATE ROLE'));
 assert.ok(held.indexOf('await installFullRecoverySchema(admin)')<held.indexOf('await installRestrictedProtectiveRuntime(setup)'));
 assert.doesNotMatch(source,/process\.env\.(?:SUPABASE|KALSHI|STRATA_PRODUCTION)/);
 assert.doesNotMatch(source,/GRANT .*ALL (?:TABLES|SEQUENCES|FUNCTIONS)|ALTER DEFAULT PRIVILEGES|DISABLE (?:TRIGGER|ROW LEVEL SECURITY)/);
});
test('singleton defaults route to a real login after all bootstrap clients close',()=>{
 assert.match(source,/LOGIN NOINHERIT NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
 assert.match(source,/url\.username=runtimeRole/);
 assert.ok(source.indexOf('await pool.end()')<source.indexOf('pool.query=runtime.query.bind(runtime)'));
 assert.match(source,/pool.connect=runtime.connect.bind\(runtime\)/);
 assert.match(held,/await acknowledgedEntry\(setup\)/);
 assert.match(held,/sourceTimer=setInterval\(\(\)=>\{void setup.query/);
 assert.match(source,/session:runtimeRole/);
});
test('lock-only authority experiment tests actual denial and policy composition',()=>{
 assert.match(source,/AS RESTRICTIVE FOR UPDATE TO \$\{runtimeRole\} USING\(true\) WITH CHECK\(false\)/);
 assert.match(source,/held_accidental_widening/);
 assert.match(source,/SELECT approval_id FROM \$\{table\} FOR SHARE/);
 assert.match(source,/SET approval_id=approval_id/);
 assert.match(source,/row-level security policy/);
 assert.match(source,/code:'22P02'/);
 assert.match(source,/code:'55P03'/);
 assert.match(source,/authority bytes unchanged/);
 assert.doesNotMatch(source,/ALTER TABLE .*ENABLE ROW LEVEL SECURITY/);
});
test('real scenario suite remains wired through unchanged canonical runner',()=>{
 assert.ok(scripts['test:v13-safety-all'].includes('pnpm run test:restricted-protective-runtime'));
 for(const name of ['restrictedProtectiveDispatch','restrictedProtectiveNoSend','restrictedProtectiveAmbiguous']){
  assert.ok(scripts['test:restricted-protective-runtime'].includes(`node scripts/run-v13-disposable-postgres.mjs src/lib/strata/${name}.postgres.test.ts`));
  assert.match(read(`src/lib/strata/${name}.postgres.test.ts`),/runHeldSupervisorDispatchScenario\('[a-z_]+',true\)/);
 }
 const runner=read('scripts/run-v13-disposable-postgres.mjs');
 assert.match(runner,/no connected-database fallback exists/);
 assert.match(runner,/offline_external_socket_denied/);
 assert.doesNotMatch(runner,/\.\.\.process\.env/);
});
test('native outcomes include explicit optional audit and real definer rollback',()=>{
 assert.match(source,/await auditUnseenExpiredSignals\(accountId\)/);
 assert.match(source,/await recordLiveSignalDecision/);
 assert.match(source,/SELECT nextval\(\$1::regclass\)/);
 assert.match(source,/SELECT setval\(\$1::regclass,1\)/);
 assert.match(source,/fixture-rollback-only/);
 assert.match(held,/await assertRestrictedOutcome\(setup,account\)/);
 assert.match(held,/production-mode validation settings until process exit/);
});

test('fixture drivers and types come from the existing workspace dependency',()=>{
 for(const text of [source,held]){
  assert.doesNotMatch(text,/from ['"]pg['"]/);
  assert.match(text,/type Pool/);
  assert.match(text,/const NativePool=pool.constructor as new/);
  assert.match(text,/new NativePool\(/);
 }
 assert.match(source,/type PoolClient/);
 assert.match(source,/runtime.on\('error',\(error:Error\)/);
 assert.match(held,/catch\(\(e:unknown\)=>\{sourceFailure=e;/);
});
