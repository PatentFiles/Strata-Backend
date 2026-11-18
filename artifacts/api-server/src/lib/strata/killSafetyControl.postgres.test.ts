import {tradingSession,USER,ACCOUNT} from './personalExecution.integration.test';
import {createDatabaseUserScopePort} from './userScopeDatabase';
import {createUserExecutionRouter} from '../../routes/userExecutionRouter';
import {pool} from '@workspace/db';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const FIN='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',CON='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',SECRET='cccccccc-cccc-4ccc-8ccc-cccccccccccc',OTHER='22222222-2222-4222-8222-222222222222';
async function setup(migrated=true){
 const s=await tradingSession(500,[]);
 await pool.query(`CREATE SCHEMA IF NOT EXISTS private;DROP TABLE IF EXISTS private.kalshi_account_worker_lease CASCADE;
 CREATE TABLE IF NOT EXISTS public.financial_accounts(id uuid,user_id uuid,UNIQUE(id,user_id));
 CREATE TABLE IF NOT EXISTS private.provider_connections(id uuid,financial_account_id uuid);
 ALTER TABLE public.financial_accounts ADD COLUMN IF NOT EXISTS provider text DEFAULT 'kalshi';
 DROP TABLE IF EXISTS private.kalshi_connection_credentials CASCADE;
 CREATE TABLE private.kalshi_connection_credentials(role text,provider_connection_id uuid,vault_secret_id uuid,key_fingerprint text,financial_account_id uuid,owner_user_id uuid,revoked_at timestamptz);
 TRUNCATE private.kalshi_connection_credentials;
 INSERT INTO public.financial_accounts(id,user_id) VALUES('${FIN}','${USER}') ON CONFLICT DO NOTHING;
 INSERT INTO private.provider_connections SELECT '${CON}','${FIN}' WHERE NOT EXISTS(SELECT 1 FROM private.provider_connections WHERE id='${CON}');
 CREATE TABLE IF NOT EXISTS private.strata_emergency_exit_reservations(execution_account_id text,state text);TRUNCATE private.strata_emergency_exit_reservations;`);
 await pool.query('UPDATE v13_production_account SET kalshi_connection_id=$1 WHERE id=$2',[FIN,ACCOUNT]);
 if(migrated){await pool.query(readFileSync('../../lib/db/drizzle/0013_kalshi_account_worker_lease.sql','utf8'));
 await pool.query(`INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,financial_account_id,provider_connection_id,holder_id,fencing_token,state,heartbeat_at,arm_requested,credential_fingerprint,vault_secret_id) VALUES($1,$2,$3,$4,'worker',3,'owned',now(),true,$5,$6)`,[ACCOUNT,USER,FIN,CON,s.evidence.identity.keyFingerprint,SECRET]);}
 return s;
}
async function state(){return(await pool.query('SELECT kill_switch,execution_enabled FROM v13_production_account WHERE id=$1',[ACCOUNT])).rows[0];}
async function route(action:string,owner=USER,db:any=pool){
 const port=createDatabaseUserScopePort(db,{kalshiGet:async()=>{throw Error('provider forbidden');}});
 const router:any=createUserExecutionRouter((_q,_s,next)=>next(),port);
 const handler=router.stack.find((layer:any)=>layer.route?.path==='/control'&&layer.route.methods.post).route.stack[0].handle;
 let status=0,body:any;const res={locals:{strata:{subject:owner}},status(n:number){status=n;return this;},json(value:any){body=value;return this;}};
 await handler({body:{action,userId:OTHER,owner_user_id:OTHER}},res);return {status,body};
}
for(const migrated of [true,false])test(`KILL actual routed safety path atomically disables owned account, migrated=${migrated}`,async()=>{
 await setup(migrated);const policyBefore=(await pool.query('SELECT * FROM v13_live_money_policy ORDER BY id')).rows;
 const queries:string[]=[];const db={query:async(sql:string,args?:any[])=>{queries.push(sql);return pool.query(sql,args);},connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql:string,args?:any[])=>{queries.push(sql);return c.query(sql,args);}};}};
 const foreign=await route('KILL',OTHER,db);assert.equal(foreign.status,200);assert.deepEqual(await state(),{kill_switch:false,execution_enabled:true});
 const result=await route('KILL',USER,db);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.reason,'account_killed');
 assert.deepEqual(await state(),{kill_switch:true,execution_enabled:false});
 const updates=queries.filter(sql=>/^\s*UPDATE\b/i.test(sql));assert.ok(updates.some(sql=>/SET kill_switch = true, execution_enabled = false/.test(sql)));
 assert.ok(updates.every(sql=>/UPDATE (?:private\.kalshi_account_worker_lease|v13_production_account)/.test(sql)),updates.join('\n'));
 assert.deepEqual((await pool.query('SELECT * FROM v13_live_money_policy ORDER BY id')).rows,policyBefore);
 if(migrated){const l=(await pool.query('SELECT state,arm_requested,account_kill FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[ACCOUNT])).rows[0];assert.deepEqual(l,{state:'killed',arm_requested:false,account_kill:true});const owned=queries.findIndex(sql=>sql.includes('ORDER BY id FOR UPDATE'));const lease=queries.findIndex(sql=>sql.includes('account-worker:lock-owner'));assert.ok(owned>=0&&lease>owned);}
});
test('KILL routed account write and lease write rollback together on failure',async()=>{
 await setup();const before=(await pool.query('SELECT * FROM private.kalshi_account_worker_lease')).rows;
 const db={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql:string,args?:any[])=>{const result=await c.query(sql,args);if(sql.includes('SET kill_switch = true, execution_enabled = false'))throw Error('injected after account write');return result;}};}};
 const result=await route('KILL',USER,db);assert.equal(result.status,409);assert.deepEqual(await state(),{kill_switch:false,execution_enabled:true});assert.deepEqual((await pool.query('SELECT * FROM private.kalshi_account_worker_lease')).rows,before);
});
test('KILL serializes behind earlier account writer and STOP never reenables killed account',async()=>{
 await setup();const c=await pool.connect();let killed:ReturnType<typeof route>|undefined;
 try{await c.query('BEGIN');await c.query('SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE',[ACCOUNT]);
 killed=route('KILL');let waiting=false;const deadline=Date.now()+500;while(Date.now()<deadline){const waiters=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ORDER BY id FOR UPDATE%' AND cardinality(pg_blocking_pids(pid))>0");if(waiters.rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}assert.equal(waiting,true,'KILL must actually wait on the earlier owned account lock');
 await c.query('UPDATE v13_production_account SET execution_enabled=true WHERE id=$1',[ACCOUNT]);await c.query('COMMIT');
 assert.equal((await killed).status,200);assert.deepEqual(await state(),{kill_switch:true,execution_enabled:false});
 assert.equal((await route('STOP')).status,200);assert.deepEqual(await state(),{kill_switch:true,execution_enabled:false});
 }finally{await c.query('ROLLBACK');c.release();if(killed)await killed;}
});
test('STOP and DISARM retain execution flag and do not revoke authority',async()=>{
 for(const action of ['STOP','DISARM']){await setup();assert.equal((await route(action)).status,200);assert.deepEqual(await state(),{kill_switch:false,execution_enabled:true});}
});
