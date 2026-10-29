import test from 'node:test';
import assert from 'node:assert/strict';
import {pool as db} from '@workspace/db';
import {generateKeyPairSync} from 'node:crypto';
import {recoverOwnerTransientFreeze,OWNER_TRANSIENT_RECOVERY_CONFIRM,TRANSIENT_DATABASE_FREEZE} from './ownerTransientFreezeRecovery';
import {dedicatedSignerFingerprint} from './commissioning';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
const url=process.env.V13_RECOVERY_DISPOSABLE_URL;
if(!url||url!==process.env.DATABASE_URL)throw Error('explicit_disposable_recovery_database_required');
const parsed=new URL(url);
if(parsed.hostname!=='127.0.0.1'||!/^\/recovery_disposable_\d+$/.test(parsed.pathname))throw Error('disposable_recovery_destination_required');
const owner='11111111-1111-4111-8111-111111111111';
const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const fp=dedicatedSignerFingerprint('test',pem)!;
const policyHash=computeV13LiveMoneyPolicyHash({id:'p',state:'APPROVED',createdBy:owner} as never);
const reset=async()=>{
 await db.query(`TRUNCATE public.v13_production_observation;
 UPDATE public.v13_production_account SET blocked_reason='timeout exceeded when trying to connect',revision=1,execution_enabled=true,kill_switch=false;
 UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=false;
 UPDATE private.kalshi_connection_credentials SET revoked_at=NULL;`);
};
const read=async(_creds:unknown,observedAtMs:number)=>({ok:true as const,observedAtMs,historicalCoverageComplete:true,cashMicros:'25000000',orders:[],fills:[],positions:[],settlements:[]});
const recover=(readFn=read,options:Record<string,unknown>={})=>recoverOwnerTransientFreeze(owner,OWNER_TRANSIENT_RECOVERY_CONFIRM,{db,isScheduled:()=>false,read:readFn,...options});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('isolated real PostgreSQL recovery locks, replay and rollback',async t=>{
 try{
 await db.query(`CREATE SCHEMA private;CREATE SCHEMA vault;
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,
 policy_id text,kalshi_connection_id text,key_fingerprint text,blocked_reason text,commissioned boolean,cash_precision_verified boolean,
 reserved_micros bigint,cash_micros bigint,initial_cash_micros bigint,revision bigint,execution_enabled boolean,kill_switch boolean,
 reconciled_at timestamptz,evidence_digest text);
 CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,created_by text,state text,policy_hash text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean,
 credential_fingerprint text,fencing_token bigint);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id text,role text,revoked_at timestamptz,
 verified_at timestamptz,verification_reason text,key_fingerprint text,vault_secret_id text);
 CREATE TABLE vault.decrypted_secrets(id text,decrypted_secret text);
 CREATE TABLE public.v13_production_intent(id text,account_id text,created_at timestamptz,request jsonb,state text,terminal boolean,reserved_micros bigint);
 CREATE TABLE public.v13_production_position(account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE public.v13_production_event(account_id text,event_id text,digest text,cash_delta_micros bigint,pnl_micros bigint);
 CREATE TABLE public.v13_production_observation(id text,account_id text,kind text,payload jsonb,digest text);`);
 await db.query(`INSERT INTO public.v13_production_account VALUES('a',$1,1,2,'p','connection',$2,$3,true,true,0,25000000,25000000,1,true,false,NULL,NULL)`,[owner,fp,TRANSIENT_DATABASE_FREEZE]);
 await db.query(`INSERT INTO public.v13_live_money_policy VALUES('p','a',$1,'APPROVED',$2)`,[owner,policyHash]);
 await db.query(`INSERT INTO private.kalshi_account_worker_lease VALUES('a',$1,'released',false,$2,22)`,[owner,fp]);
 await db.query(`INSERT INTO private.kalshi_connection_credentials VALUES($1,'connection','restricted_execution',NULL,now(),'credential_verified',$2,'secret')`,[owner,fp]);
 await db.query(`INSERT INTO vault.decrypted_secrets VALUES('secret',$1)`,[JSON.stringify({api_key_id:'test',private_key:pem})]);
 await t.test('success records evidence and leaves trading off; replay refuses',async()=>{
  assert.equal((await recover()).ok,true);
  const a=(await db.query('SELECT * FROM public.v13_production_account')).rows[0];
  assert.equal(a.blocked_reason,null);assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);
  assert.equal((await db.query('SELECT * FROM public.v13_production_observation')).rows.length,1);
  assert.equal((await recover()).ok,false);
 });
 await t.test('concurrent START-style account lock waits then observes shut gates',async()=>{
  await reset();const entered=deferred(),resume=deferred();
  const operation=recover(async(c,at)=>{entered.resolve();await resume.promise;return read(c,at);});
  await entered.promise;let acquired=false;
  const concurrent=db.connect().then(async client=>{try{await client.query('BEGIN');
   const a=(await client.query("SELECT * FROM public.v13_production_account WHERE id='a' FOR UPDATE")).rows[0];acquired=true;
   assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);await client.query('ROLLBACK');
  }finally{client.release();}});
  await new Promise(r=>setTimeout(r,80));assert.equal(acquired,false);resume.resolve();
  assert.equal((await operation).ok,true);await concurrent;
 });
 await t.test('first account lock is bounded before signed reads',async()=>{
  await reset();const blocker=await db.connect();let signed=0;
  try{await blocker.query('BEGIN');await blocker.query("SELECT id FROM public.v13_production_account WHERE id='a' FOR UPDATE");
   const started=Date.now();const result=await recover(async(c,at)=>{signed++;return read(c,at);});
   assert.equal(result.ok,false);assert.equal(signed,0);assert.ok(Date.now()-started<4000);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
 });
 await t.test('lease change is serialized behind recovery fence',async()=>{
  await reset();const entered=deferred(),resume=deferred();
  const operation=recover(async(c,at)=>{entered.resolve();await resume.promise;return read(c,at);});
  await entered.promise;let locked=false;
  const competitor=db.connect().then(async client=>{try{await client.query('BEGIN');
   await client.query("SELECT * FROM private.kalshi_account_worker_lease WHERE execution_account_id='a' FOR UPDATE");
   locked=true;await client.query('ROLLBACK');
  }finally{client.release();}});
  await new Promise(r=>setTimeout(r,80));assert.equal(locked,false);resume.resolve();
  assert.equal((await operation).ok,true);await competitor;
 });
 await t.test('credential revocation waits for pinned read then prevents next recovery',async()=>{
  await reset();const entered=deferred(),resume=deferred();
  const operation=recover(async(c,at)=>{entered.resolve();await resume.promise;return read(c,at);});
  await entered.promise;let revoked=false;
  const revoke=db.query('UPDATE private.kalshi_connection_credentials SET revoked_at=now()').then(()=>{revoked=true;});
  await new Promise(r=>setTimeout(r,80));assert.equal(revoked,false);resume.resolve();assert.equal((await operation).ok,true);await revoke;
  await db.query('UPDATE public.v13_production_account SET blocked_reason=$1',[TRANSIENT_DATABASE_FREEZE]);
  assert.equal((await recover()).ok,false);
 });
 await t.test('DB-clock expiry after audit rolls back both audit and clearance',async()=>{
  await reset();
  await db.query(`CREATE FUNCTION delay_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5.1); RETURN NEW; END $$;
  CREATE TRIGGER slow_audit BEFORE INSERT ON public.v13_production_observation FOR EACH ROW EXECUTE FUNCTION delay_recovery_audit();`);
  const result=await recover();assert.equal(result.ok,false);assert.equal(result.reason,'recovery_final_freshness_or_cas_refused');
  const a=(await db.query('SELECT * FROM public.v13_production_account')).rows[0];
  assert.equal(a.blocked_reason,TRANSIENT_DATABASE_FREEZE);assert.equal(a.revision,'1');
  assert.equal((await db.query('SELECT * FROM public.v13_production_observation')).rows.length,0);
  await db.query('DROP TRIGGER slow_audit ON public.v13_production_observation');
 });
 }finally{await db.end();}
});
