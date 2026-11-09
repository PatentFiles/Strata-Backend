import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {readFileSync} from 'node:fs';
import {holdUnknownEntryRecovery} from './unknownEntryRecoveryHold';
const url=process.env.ANALYTICS_DISPOSABLE_URL!;
const root=process.env.ANALYTICS_DISPOSABLE_ROOT!;
assert.ok(root?.startsWith('/tmp/strata-analytics-pg-'));
const manifest=JSON.parse(readFileSync(root+'/owned-cluster.json','utf8'));
assert.equal(manifest.nonce,process.env.ANALYTICS_DISPOSABLE_NONCE);
assert.equal(new URL(url).searchParams.get('host'),root+'/socket');
assert.equal(new URL(url).pathname,'/analytics_drain');
const scope={ownerId:'11111111-1111-1111-1111-111111111111',accountId:'a',intentId:'i',holderId:'h',fencingToken:'4',keyFingerprint:'a'.repeat(64),policyHash:'b'.repeat(64),financialAccountId:'11111111-1111-1111-1111-111111111112',providerConnectionId:'11111111-1111-1111-1111-111111111113',vaultSecretId:'11111111-1111-1111-1111-111111111114'};
test('native hold transaction and concurrency',{timeout:30000},async t=>{
 assert.equal(process.env.DATABASE_URL,url);
 try{
  await pool.query(`CREATE SCHEMA private;
   CREATE TABLE financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
   CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid REFERENCES financial_accounts);
   CREATE TABLE v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,policy_hash text,state text);
   CREATE TABLE v13_production_account(id text PRIMARY KEY,owner_user_id uuid,kill_switch boolean,execution_enabled boolean,commissioned boolean,subaccount int,exchange_index int,key_fingerprint text,policy_id text REFERENCES v13_live_money_policy,kalshi_connection_id uuid REFERENCES financial_accounts);
   CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid REFERENCES financial_accounts,provider_connection_id uuid REFERENCES private.provider_connections,key_fingerprint text,vault_secret_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text);
   CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY REFERENCES v13_production_account,owner_user_id uuid,holder_id text,fencing_token bigint,state text,account_kill boolean,heartbeat_at timestamptz,credential_fingerprint text,financial_account_id uuid,provider_connection_id uuid,vault_secret_id uuid,arm_requested boolean);
   CREATE TABLE v13_production_observation(account_id text,kind text,payload jsonb);
   CREATE TABLE v13_production_intent(id text PRIMARY KEY,account_id text REFERENCES v13_production_account,kind text,state text,terminal boolean,dispatch_at timestamptz,request jsonb);
  `);
  await pool.query('INSERT INTO financial_accounts VALUES($1,$2,\'kalshi\')',[scope.financialAccountId,scope.ownerId]);
  await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[scope.providerConnectionId,scope.financialAccountId]);
  await pool.query("INSERT INTO v13_live_money_policy VALUES('p','a',$1,'APPROVED')",[scope.policyHash]);
  await pool.query("INSERT INTO v13_production_account VALUES('a',$1,false,true,true,1,2,$2,'p',$3)",[scope.ownerId,scope.keyFingerprint,scope.financialAccountId]);
  await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,$5,'restricted_execution',NULL,clock_timestamp(),'credential_verified')",[scope.ownerId,scope.financialAccountId,scope.providerConnectionId,scope.keyFingerprint,scope.vaultSecretId]);
  await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES('a',$1,'h',4,'owned',false,clock_timestamp(),$2,$3,$4,$5,true)",[scope.ownerId,scope.keyFingerprint,scope.financialAccountId,scope.providerConnectionId,scope.vaultSecretId]);
  await pool.query(`INSERT INTO v13_production_intent VALUES('i','a','ENTRY','UNKNOWN',false,clock_timestamp(),' {"action":"BUY","reduceOnly":false,"timeInForce":"IOC"}')`);
  await pool.query(`INSERT INTO v13_production_observation VALUES('a','POST_ATTEMPT','{"id":"i","outcome":"GET_RECONCILIATION_REQUIRED"}')`);
  const reset=async()=>pool.query("UPDATE private.kalshi_account_worker_lease SET arm_requested=true,heartbeat_at=clock_timestamp(),fencing_token=4");
  const armed=async()=>(await pool.query('SELECT arm_requested FROM private.kalshi_account_worker_lease')).rows[0].arm_requested;
  await t.test('native committed hold only disarms entries',async()=>{
   const result=await holdUnknownEntryRecovery(pool,scope);assert.equal(result.held,true);assert.equal(await armed(),false);
   const state=(await pool.query('SELECT state,terminal FROM v13_production_intent')).rows[0];assert.equal(state.state,'UNKNOWN');assert.equal(state.terminal,false);
  });
  await t.test('wrong token rolls back without disarming',async()=>{
   await reset();const result=await holdUnknownEntryRecovery(pool,{...scope,fencingToken:'3'});
   assert.equal(result.held,false);assert.equal(await armed(),true);
  });
  await t.test('revoked credential rolls back without disarming',async()=>{
   await reset();await pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp()');
   assert.equal((await holdUnknownEntryRecovery(pool,scope)).held,false);assert.equal(await armed(),true);
   await pool.query('UPDATE private.kalshi_connection_credentials SET revoked_at=NULL');
  });
  for(const [name,sql] of [
   ['owner KILL','UPDATE v13_production_account SET kill_switch=true'],
   ['lease token','UPDATE private.kalshi_account_worker_lease SET fencing_token=5'],
   ['policy','UPDATE v13_live_money_policy SET state=\'REVOKED\''],
   ['credential','UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp()'],
   ['provider','UPDATE private.provider_connections SET financial_account_id=financial_account_id'],
  ]) await t.test(`${name} writer blocked while held transaction owns scope`,async()=>{
   await reset();let unlock!:()=>void;const blocker=new Promise<void>(r=>{unlock=r;});let locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;});
   const db={connect:async()=>{const c=await pool.connect();return {query:async(q:string,p?:unknown[])=>{
    const result=await c.query(q,p);if(q.includes('FOR SHARE OF p,c,fa,pc')){locked();await blocker;}return result;
   },release:(error?:Error)=>c.release(error)};}};
   const pending=holdUnknownEntryRecovery(db,scope);await Promise.race([ready,pending.then(r=>{throw Error('hold_finished_before_lock:'+r.reason);})]);
   const writer=await pool.connect();try{await writer.query("SET lock_timeout='100ms'");await assert.rejects(writer.query(sql),/lock timeout/);}finally{writer.release();unlock();}
   assert.equal((await pending).held,true);
  });
  await t.test('actual committed but lost acknowledgment stays uncertain',async()=>{
   await reset();const db={connect:async()=>{const c=await pool.connect();return {query:async(q:string,p?:unknown[])=>{const r=await c.query(q,p);if(q==='COMMIT')throw Error('simulated transport acknowledgment loss');return r;},release:(error?:Error)=>c.release(error)};}};
   const r=await holdUnknownEntryRecovery(db,scope);assert.equal(r.uncertain,true);assert.equal(r.held,false);assert.equal(await armed(),false);
  });
 }finally{await pool.end();}
});
