import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {activityTables,migrationManifest,schemaRoot,sourceManifest} from './ownerUnknownRecoverySchema.fixture';

test('full-schema manifest covers every checked-in migration and sidecar, including both 0043s',()=>{
 const manifest=sourceManifest();assert.equal(manifest.length,62);
 assert.equal(manifest.filter(m=>m.path.includes('/0043_')).length,2);
 assert.ok(manifest.every(m=>/^[a-f0-9]{64}$/.test(m.sha256)));
});
test('dependency ordering preserves fee, protective and trace function prerequisites',()=>{
 const order=(a:string,b:string)=>assert.ok(migrationManifest.findIndex(n=>n.endsWith(a))<migrationManifest.findIndex(n=>n.endsWith(b)),`${a} before ${b}`);
 order('strata_fee_source_policy_independent_reviews.sql','0035_fee_trigger_search_path_hardening.sql');
 order('strata_in_app_protective_release_approval.sql','0044_v13_signal_decision_trace.sql');
 order('strata_protective_exit_local_no_send.sql','strata_protective_exit_fractional_quantity.sql');
 order('0043_strata_continuous_execution_grants.sql','maintenance-hardening-20261028.sql');
});
test('all independent activity tables have checked-in nondeferred account FKs',()=>{
 const sql=migrationManifest.map(p=>readFileSync(resolve(schemaRoot,p),'utf8')).join('\n');
 for(const table of activityTables){
  const ddl=sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS private\\.${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
  assert.ok(ddl,table);assert.match(ddl,/execution_account_id text (?:PRIMARY KEY |NOT NULL |UNIQUE )*REFERENCES public\.v13_production_account\(id\)/,table);
 }
});
test('platform prerequisites cannot substitute synthetic trading tables or grant browser authority',()=>{
 const sql=readFileSync(resolve(schemaRoot,'artifacts/api-server/src/lib/strata/fixtures/ownerUnknownRecoveryPlatform.sql'),'utf8');
 assert.equal((sql.match(/CREATE TABLE/g)||[]).length,5);
 assert.doesNotMatch(sql,/CREATE TABLE\s+(?:public\.|private\.)?(?:v13_|strata_|kalshi_)/i);
 assert.doesNotMatch(sql,/GRANT\s+.*\s+TO\s+(?:anon|authenticated|service_role)/i);
});
