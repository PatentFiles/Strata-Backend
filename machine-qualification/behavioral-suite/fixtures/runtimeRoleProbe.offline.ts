import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool as db} from '@workspace/db';
if(process.env.DATABASE_URL!=='postgresql://agent@127.0.0.1:55458/compatible_disposable')throw Error('disposable_only');
const sql=readFileSync('__STRATA_PROTECTED_FIXTURES__/recovery-runtime-permissions-readonly.sql','utf8');
(async()=>{try{
const probe=async(role='offline_runtime')=>(await db.query(sql,[role])).rows as {kind:string,object:string}[];
await db.query('CREATE ROLE offline_runtime NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;CREATE ROLE offline_privileged NOLOGIN BYPASSRLS;CREATE SCHEMA private;CREATE SCHEMA vault');
let r=await probe();assert.equal(r.filter(x=>x.kind==='required_object_missing').length,12);console.log('PASS role probe refuses missing required schema objects rather than claiming healthy');
for(const [schema,names] of [['public',['v13_production_account','v13_production_intent','v13_production_position','v13_live_money_policy','live_execution_config','financial_accounts']],['private',['provider_connections','kalshi_connection_credentials','kalshi_account_worker_lease','strata_emergency_exit_reservations','owner_recovery_barrier_scope']],['vault',['secrets']]] as const)for(const name of names)await db.query('CREATE TABLE '+schema+'.'+name+'(id text)');
await db.query('GRANT USAGE ON SCHEMA public,private,vault TO offline_runtime;GRANT SELECT ON ALL TABLES IN SCHEMA public,private,vault TO offline_runtime');
assert.deepEqual(await probe(),[]);console.log('PASS synthetic read-only runtime role has no modeled privilege hazards; not production qualification');
assert((await probe('nonexistent_role')).some(x=>x.kind==='role_missing'));console.log('PASS role probe explicitly reports nonexistent runtime role');
await db.query('GRANT TRUNCATE ON public.v13_production_account TO offline_runtime;GRANT CREATE ON SCHEMA private TO offline_runtime;GRANT DELETE ON private.owner_recovery_barrier_scope TO offline_runtime');
r=await probe();for(const kind of ['truncate_privilege','schema_create','scope_mutation_privilege'])assert(r.some(x=>x.kind===kind),kind);console.log('PASS role probe identifies truncate schema-create and enrollment-mutation grants');
await db.query('GRANT offline_privileged TO offline_runtime');assert((await probe()).some(x=>x.kind==='reachable_privileged_role'&&x.object==='offline_privileged'));console.log('PASS role probe identifies inherited BYPASSRLS privilege');
await db.query('ALTER TABLE public.v13_production_position OWNER TO offline_runtime');assert((await probe()).some(x=>x.kind==='reachable_table_owner'&&x.object==='public.v13_production_position'));console.log('PASS role probe identifies runtime-owned protected table');
await db.query('GRANT SET ON PARAMETER session_replication_role TO offline_runtime');assert((await probe()).some(x=>x.kind==='replication_role_set'));console.log('PASS role probe identifies trigger-bypass parameter privilege');
}finally{await db.end()}})().catch(e=>{console.error(e);process.exitCode=1});
