import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {loadHeldReadDiagnosticScope} from './heldReadDiagnosticScope';
import {createHeldReadDiagnostic} from './heldReadDiagnostic';
import {dedicatedSignerFingerprint} from './commissioning';
const url=process.env.ANALYTICS_DISPOSABLE_URL!,root=process.env.ANALYTICS_DISPOSABLE_ROOT!;
assert.ok(root?.startsWith('/tmp/strata-analytics-pg-'));
const manifest=JSON.parse(readFileSync(root+'/owned-cluster.json','utf8'));
assert.equal(manifest.nonce,process.env.ANALYTICS_DISPOSABLE_NONCE);
assert.equal(new URL(url).searchParams.get('host'),root+'/socket');assert.equal(new URL(url).pathname,'/analytics_drain');assert.equal(process.env.DATABASE_URL,url);
const owner='11111111-1111-4111-8111-111111111111',financial='22222222-2222-4222-8222-222222222222',provider='33333333-3333-4333-8333-333333333333',vault='44444444-4444-4444-8444-444444444444';
const material={keyId:'synthetic-native',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const fp=dedicatedSignerFingerprint(material.keyId,material.privateKey)!;
test('native diagnostic scope mechanics, fresh Unix-only disposable',{timeout:60000},async t=>{
 try{
 await pool.query(`CREATE SCHEMA private;CREATE SCHEMA vault;
 CREATE ROLE diagnostic_backend NOLOGIN NOSUPERUSER;
 CREATE TABLE financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid REFERENCES financial_accounts);
 CREATE TABLE v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,policy_hash text,state text);
 CREATE TABLE v13_production_account(id text PRIMARY KEY,owner_user_id uuid,kill_switch boolean,execution_enabled boolean,commissioned boolean,subaccount int,exchange_index int,key_fingerprint text,policy_id text REFERENCES v13_live_money_policy,kalshi_connection_id uuid REFERENCES financial_accounts,reserved_micros bigint);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid REFERENCES financial_accounts,provider_connection_id uuid REFERENCES private.provider_connections,key_fingerprint text,vault_secret_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY REFERENCES v13_production_account,owner_user_id uuid,fencing_token bigint,state text,account_kill boolean,credential_fingerprint text,financial_account_id uuid,provider_connection_id uuid,vault_secret_id uuid,arm_requested boolean);
 CREATE TABLE v13_production_intent(account_id text REFERENCES v13_production_account,terminal boolean);
 CREATE TABLE v13_production_position(account_id text REFERENCES v13_production_account,quantity_hundredths bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text REFERENCES v13_production_account,state text);
 CREATE TABLE private.strata_kalshi_balance_read_slots(budget_key text PRIMARY KEY,next_slot_at timestamptz NOT NULL);
 CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY,decrypted_secret text);
 GRANT USAGE ON SCHEMA public,private,vault TO diagnostic_backend;
 GRANT SELECT ON ALL TABLES IN SCHEMA public,private,vault TO diagnostic_backend;`);
 await pool.query("INSERT INTO financial_accounts VALUES($1,$2,'kalshi')",[financial,owner]);
 await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[provider,financial]);
 await pool.query("INSERT INTO v13_live_money_policy VALUES('p','a','policy','APPROVED')");
 await pool.query("INSERT INTO v13_production_account VALUES('a',$1,true,false,true,1,2,$2,'p',$3,0)",[owner,fp,financial]);
 await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,$5,'restricted_execution',NULL,now(),'credential_verified')",[owner,financial,provider,fp,vault]);
 await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES('a',$1,42,'killed',true,$2,$3,$4,$5,false)",[owner,fp,financial,provider,vault]);
 await pool.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[vault,JSON.stringify({api_key_id:material.keyId,private_key:material.privateKey})]);
 const db={connect:async()=>{const c=await pool.connect();await c.query('SET ROLE diagnostic_backend');await c.query("SET default_transaction_isolation='repeatable read'");return c;}};
 await t.test('non-superuser role, explicit isolation and concurrent revocation visibility',async()=>{
  const scope=await loadHeldReadDiagnosticScope(db,owner,new AbortController().signal);
  try{assert.equal(scope.databaseRole,'diagnostic_backend');await scope.authorize();
   await pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=now()');
   await assert.rejects(scope.authorize(),/scope_refused/);
  }finally{await scope.close();await pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=NULL');}
 });
 await t.test('transaction lock excludes distinct connection, rollback releases it',async()=>{
  const first=await loadHeldReadDiagnosticScope(db,owner,new AbortController().signal);
  try{await assert.rejects(loadHeldReadDiagnosticScope(db,owner,new AbortController().signal),/diagnostic_busy/);}finally{await first.close();}
  const next=await loadHeldReadDiagnosticScope(db,owner,new AbortController().signal);await next.close();
 });
 for(const [name,change,restore] of [
  ['fence',"UPDATE private.kalshi_account_worker_lease SET fencing_token=43","UPDATE private.kalshi_account_worker_lease SET fencing_token=42"],
  ['ARM',"UPDATE private.kalshi_account_worker_lease SET arm_requested=true","UPDATE private.kalshi_account_worker_lease SET arm_requested=false"],
  ['execution',"UPDATE v13_production_account SET execution_enabled=true","UPDATE v13_production_account SET execution_enabled=false"],
  ['policy',"UPDATE v13_live_money_policy SET state='REVOKED'","UPDATE v13_live_money_policy SET state='APPROVED'"],
 ])await t.test('scope catches concurrent '+name,async()=>{const scope=await loadHeldReadDiagnosticScope(db,owner,new AbortController().signal);try{await pool.query(change);await assert.rejects(scope.authorize());}finally{await scope.close();await pool.query(restore);}});
 await t.test('missing role permission refuses without fallback',async()=>{
  await pool.query('REVOKE SELECT ON vault.decrypted_secrets FROM diagnostic_backend');
  try{await assert.rejects(loadHeldReadDiagnosticScope(db,owner,new AbortController().signal),/permission denied/);}finally{await pool.query('GRANT SELECT ON vault.decrypted_secrets TO diagnostic_backend');}
 });
 await t.test('actual durable quota admission with original synthetic transport',async()=>{
  const previousEnv=process.env.NODE_ENV,previousFetch=globalThis.fetch;let sends=0;
  process.env.NODE_ENV='production';globalThis.fetch=async input=>{sends++;return new Response(JSON.stringify(String(input).includes('/balance')?{balance_dollars:'25.0000',subaccount:1,exchange_index:2}:{orders:[],fills:[],market_positions:[],settlements:[],cursor:''}));};
  try{
   const result=await createHeldReadDiagnostic({db})(owner);assert.equal(result.status,'read_complete');assert.equal(sends,7);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM private.strata_kalshi_balance_read_slots')).rows[0].n,1);
   await pool.query("UPDATE private.strata_kalshi_balance_read_slots SET next_slot_at=clock_timestamp()+interval '60 seconds'");
   const before=(await pool.query('SELECT next_slot_at::text AS at FROM private.strata_kalshi_balance_read_slots')).rows[0].at;
   const blocked=await createHeldReadDiagnostic({db})(owner);assert.equal(blocked.status,'read_refused');assert.equal(sends,7);
   assert.equal((await pool.query('SELECT next_slot_at::text AS at FROM private.strata_kalshi_balance_read_slots')).rows[0].at,before);
  }finally{globalThis.fetch=previousFetch;process.env.NODE_ENV=previousEnv;}
 });
 await t.test('connection loss notifies and invalidates scope',async()=>{
  let pid=0,loss!:()=>void;const observed=new Promise<void>(resolve=>{loss=resolve;});
  const tracked={connect:async()=>{const c=await db.connect();pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return c;}};
  const scope=await loadHeldReadDiagnosticScope(tracked,owner,new AbortController().signal,loss);
  try{await pool.query('SELECT pg_terminate_backend($1)',[pid]);await Promise.race([observed,new Promise((_,reject)=>setTimeout(()=>reject(Error('missing loss notification')),1000))]);await assert.rejects(scope.authorize(),/lock_lost/);}finally{await scope.close();}
 });
 }finally{await pool.end();}
});
