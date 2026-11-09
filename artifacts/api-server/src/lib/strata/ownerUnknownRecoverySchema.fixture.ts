import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';

// This is a source-qualified application migration chain, not evidence of
// production migration history. No strings in these SQL files are rewritten.
export const schemaRoot=existsSync(resolve('lib/db/drizzle'))?resolve('.'):resolve('../..');
const fixture=resolve(schemaRoot,'artifacts/api-server/src/lib/strata/fixtures');
export const migrationManifest=JSON.parse(readFileSync(resolve(fixture,'ownerUnknownRecoveryMigrationManifest.json'),'utf8')) as string[];
export const backendRole='unknown_recovery_backend';
export const activityTables=[
 'kalshi_owner_pilot_transfers','kalshi_owner_shard_allocations','kalshi_owner_topups',
 'strata_auto_withdrawal_maintenance','strata_emergency_exit_reservations','strata_manual_profit_withdrawals',
] as const;
export const recoveryTables=[
 'public.v13_production_account','public.v13_live_money_policy','public.v13_production_intent',
 'public.v13_production_position','public.v13_production_event','public.v13_production_observation',
 'public.financial_accounts','private.provider_connections','private.kalshi_connection_credentials',
 'private.kalshi_account_worker_lease',...activityTables.map(t=>`private.${t}`),
 'private.strata_v13_execution_trace','private.strata_v13_signal_trace_scope',
];
export function sourceManifest(){
 assert.equal(new Set(migrationManifest).size,migrationManifest.length,'duplicate migration path');
 for(const directory of ['lib/db/drizzle','sql']){
  const disk=readdirSync(resolve(schemaRoot,directory)).filter(n=>n.endsWith('.sql')).map(n=>`${directory}/${n}`).sort();
  assert.deepEqual(migrationManifest.filter(n=>n.startsWith(`${directory}/`)).sort(),disk,
   `manifest must explicitly cover every ${directory} SQL source`);
 }
 return migrationManifest.map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(schemaRoot,path))).digest('hex')}));
}
type Query={query(sql:string,args?:unknown[]):Promise<any>};
export async function installFullRecoverySchema(db:Query){
 sourceManifest();
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
  'only the canonical disposable target may install this test schema');
 const parsed=new URL(url);
 // Prove the connection itself BEFORE any DDL, in addition to the caller's
 // canonical-runner environment check. No connected-database fallback.
 const actual=(await db.query(`SELECT current_database() AS name,session_user AS user,
  host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0];
 assert.deepEqual(actual,{name:parsed.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(parsed.port)});
 // Discard drizzle push output so it cannot hide a missing SQL migration.
 await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  CREATE ROLE ${backendRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  GRANT USAGE ON SCHEMA extensions TO ${backendRole};
  ALTER SCHEMA public OWNER TO ${backendRole};`);
 const name=actual.name as string;
 await db.query(`GRANT CREATE ON DATABASE "${name}" TO ${backendRole}`);
 await db.query(`SET ROLE ${backendRole}`);
 try{
  await db.query(readFileSync(resolve(fixture,'ownerUnknownRecoveryPlatform.sql'),'utf8'));
  for(const path of migrationManifest){
   try{await db.query(readFileSync(resolve(schemaRoot,path),'utf8'));}
   catch(error){throw new Error(`full_schema_migration_failed: ${path}`,{cause:error});}
  }
 }finally{await db.query('ROLLBACK');await db.query('RESET ROLE');}
 return sourceManifest();
}
