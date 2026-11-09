import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {assertDirectSessionDatabase} from '../src/lib/strata/instanceLock.ts';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(api, 'src/lib/strata/runtimeRoleMatrix.postgres.test.ts'), 'utf8');
const fixture = readFileSync(resolve(api, 'src/lib/strata/ownerUnknownRecoverySchema.fixture.ts'), 'utf8');
const runner = readFileSync(resolve(api, 'scripts/run-v13-disposable-postgres.mjs'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(api, 'package.json'), 'utf8'));

// Source-contract checks supplement native PostgreSQL tests. Passing these does
// NOT establish PostgreSQL execution, effective production grants or safe RLS.
test('role matrix requires canonical disposable URL and verified full-schema installation', () => {
  assert.match(source, /url === process\.env\.DATABASE_URL/);
  assert.ok(source.includes('v13_test@127\\.0\\.0\\.1:\\d+\\/v13_disposable_\\d+$'));
  assert.ok(source.indexOf('await installFullRecoverySchema(bootstrap)') < source.indexOf('await bootstrap.query(`CREATE ROLE'));
  assert.match(fixture, /assert\.deepEqual\(actual,\{name:parsed\.pathname\.slice\(1\),user:'v13_test',host:'127\.0\.0\.1',port:Number\(parsed\.port\)\}\)/);
  assert.ok(fixture.indexOf('assert.deepEqual(actual') < fixture.indexOf('DROP SCHEMA public'));
  assert.match(source, /import \{SESSION_RELATIONS\} from '\.\/apiFeeRuntimeDbSession'/);
});

test('qualification uses the existing credential-stripped, loopback-fenced runner', () => {
  assert.equal(manifest.scripts['test:runtime-role-matrix'],
    'node --test scripts/runtime-role-matrix.test.mjs && node scripts/run-v13-disposable-postgres.mjs src/lib/strata/runtimeRoleMatrix.postgres.test.ts');
  assert.ok(manifest.scripts['test:v13-safety-all'].includes('pnpm run test:runtime-role-matrix'));
  assert.match(runner, /PostgreSQL binaries required; no connected-database fallback exists/);
  assert.match(runner, /DATABASE_URL: url, V13_DISPOSABLE_DATABASE_URL: url/);
  assert.match(runner, /offline_external_socket_denied/);
  assert.match(runner, /offline_external_fetch_denied/);
  assert.doesNotMatch(runner, /\.\.\.process\.env/);
});

test('runtime probes use real restricted logins and explicitly disclose the writable-context limitation', () => {
  assert.match(source, /CREATE ROLE \$\{role\} LOGIN NOINHERIT NOSUPERUSER\s+NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(source, /target\.username = role/);
  assert.match(source, /custom context is NOT authentication/);
  assert.match(source, /real definer-trigger row both roll back/);
  assert.match(source, /COMMIT, ROLLBACK and aborted pooled transactions/);
  assert.match(source, /simultaneous checked-out transactions/);
  assert.doesNotMatch(source, /process\.env\.(?:SUPABASE|KALSHI|STRATA_PRODUCTION|RAILWAY)/);
});

test('existing legacy session guard rejects known transaction-pool hints but does not prove endpoint topology', () => {
  // Synthetic URLs only. This pure parser makes no database/network calls.
  for (const url of ['postgresql://fixture@127.0.0.1:6543/disposable',
    'postgresql://fixture@127.0.0.1:5432/disposable?pgbouncer=true']) {
    assert.throws(() => assertDirectSessionDatabase(url), /production_database_pooler_refused/);
  }
  assert.doesNotThrow(() => assertDirectSessionDatabase('postgresql://fixture@unverified.example.invalid:5432/disposable'));
  assert.doesNotThrow(() => assertDirectSessionDatabase('postgresql://fixture@unverified.example.invalid:6432/disposable'));
  assert.throws(() => assertDirectSessionDatabase('https://example.invalid'), /production_database_url_invalid/);
  const poolSource = readFileSync(resolve(api, '../../lib/db/src/index.ts'), 'utf8');
  assert.match(poolSource, /max: 10/);
  assert.match(poolSource, /new Pool\(poolConfig\(process\.env\.DATABASE_URL\)\)/);
  const personal = readFileSync(resolve(api, 'src/lib/strata/personalExecutionSupervisor.ts'), 'utf8');
  assert.doesNotMatch(personal, /assertDirectSessionDatabase/);
});

test('follow-up probes distinguish clean local restoration, dirty baseline persistence and definer ACL review', () => {
  assert.match(source, /source SECURITY DEFINER functions retain fixture ownership/);
  assert.match(source, /public\.strata_claim_official_fee_capture\(\)/);
  assert.match(source, /public\.strata_record_official_fee_provider_result\(integer,timestamptz\)/);
  assert.match(source, /new definers require an explicit review entry/);
  assert.match(source, /transaction-local operational settings restore the pooled session baseline/);
  assert.match(source, /Pool\.release does not RESET session settings/);
  assert.match(source, /SET LOCAL restores the prior session value, not an empty value/);
  assert.match(source, /reused\.release\(true\)/);
});
