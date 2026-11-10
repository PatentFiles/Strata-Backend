import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const fixture=read('../src/lib/strata/restrictedPlatformVault.fixture.ts');
const native=read('../src/lib/strata/restrictedPlatformVault.postgres.test.ts');

// Source/syntax contracts supplement native PG; they do not prove SQL, ACLs,
// RLS, encryption, dependency types, bundling or real managed-platform parity.
test('Vault fixture and native tests parse as TypeScript',()=>{
 for(const source of [fixture,native])assert.ok(stripTypeScriptTypes(source));
});
test('DDL remains behind full-schema and actual-session fences',()=>{
 assert.ok(fixture.indexOf('await installFullRecoverySchema(bootstrap)')<fixture.indexOf('CREATE ROLE'));
 assert.ok(fixture.indexOf('assert.deepEqual(actual')<fixture.indexOf('CREATE ROLE'));
 assert.match(fixture,/LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
 assert.ok(fixture.indexOf('await pool.end()')<fixture.indexOf('url.username=vaultRuntime'));
 assert.doesNotMatch(fixture,/from ['"]pg['"]|GRANT .*ALL (?:TABLES|SEQUENCES|FUNCTIONS)|ALTER DEFAULT PRIVILEGES|DISABLE (?:TRIGGER|ROW LEVEL SECURITY)/);
 assert.doesNotMatch(fixture+native,/process\.env\.(?:SUPABASE|KALSHI|STRATA_PRODUCTION)|generateKeyPair|createPrivateKey/);
});
test('canonical target guard rejects remote, altered and ambient targets',()=>{
 const body=fixture.split('export function canonicalVaultUrl(){')[1].split('\nexport async function assertVaultIdentity')[0];
 const check=env=>new Function('assert','process','URL','return function(){'+body)(assert,{env},URL)();
 const valid='postgresql://v13_test@127.0.0.1:54321/v13_disposable_123';
 assert.equal(check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid}).href,valid);
 for(const invalid of [undefined,valid.replace('127.0.0.1','example.invalid'),valid.replace('v13_test','postgres'),
  valid.replace('v13_disposable_123','v13_ci'),valid+'?options=x',valid.replace('v13_test@','v13_test:password@')]){
  assert.throws(()=>check({DATABASE_URL:invalid,V13_DISPOSABLE_DATABASE_URL:invalid}));
 }
 assert.throws(()=>check({DATABASE_URL:valid,V13_DISPOSABLE_DATABASE_URL:valid+'4'}));
});
test('owner-style view, non-inlined invoker helper and exact projection grants stay explicit',()=>{
 assert.match(fixture,/RETURNS bytea LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER/);
 assert.match(fixture,/CREATE VIEW vault.decrypted_secrets AS SELECT id/);
 assert.match(fixture,/ALTER VIEW vault.decrypted_secrets OWNER TO \$\{vaultOwner\}/);
 assert.match(fixture,/ALTER TABLE vault.secrets OWNER TO \$\{vaultOwner\}/);
 assert.match(fixture,/REVOKE ALL ON FUNCTION \$\{vaultHelper\} FROM PUBLIC/);
 assert.match(fixture,/GRANT SELECT\(id,decrypted_secret\) ON vault.decrypted_secrets/);
 assert.doesNotMatch(fixture,/GRANT SELECT.*ON vault.secrets|_crypto_aead_det_decrypt|CREATE EXTENSION/);
 assert.match(fixture,/createProductionPersonalSession\(\{query:async/);
 assert.match(fixture,/return result/);assert.match(fixture,/throw error/);
});
test('native tests keep denial and service-scope caveats alongside positive native reads',()=>{
 for(const token of ['SET ROLE','RESET ROLE','SELECT secret FROM vault.secrets','vaultUnrelated',
  'REVOKE EXECUTE','REVOKE ${permission}',"errors:['42501']",'decrypted_secret,s.dummy',
  'service-wide view access does not authenticate caller or isolate owners',
  "set_config('request.jwt.claim.sub'",'SELECT id FROM vault.decrypted_secrets WHERE id=$1',
  'owner_user_id=$2','providerCalls,0','personal_signer_unavailable'])assert.ok((fixture+native).includes(token),token);
});
test('platform suites are wired only through the unchanged offline runner',()=>{
 const manifest=JSON.parse(read('../package.json'));
 for(const file of ['restrictedPlatformVault','restrictedPlatformAuth']){
  assert.ok(manifest.scripts['test:restricted-platform-boundaries'].includes(`node scripts/run-v13-disposable-postgres.mjs src/lib/strata/${file}.postgres.test.ts`));
  assert.ok(manifest.scripts['test:restricted-platform-boundaries'].includes(`${file}.contract.test.mjs`));
 }
 assert.ok(manifest.scripts['test:v13-safety-all'].includes('pnpm run test:restricted-platform-boundaries'));
 const runner=read('./run-v13-disposable-postgres.mjs');
 assert.match(runner,/no connected-database fallback exists/);assert.match(runner,/offline_external_socket_denied/);
 assert.doesNotMatch(runner,/\.\.\.process\.env/);
});
