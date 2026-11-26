import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool as db} from '@workspace/db';
import {generateKeyPairSync} from 'node:crypto';
import {previewOwnerSettledCashFreeze,ownerSettledCashRecoveryOutcome,recoverOwnerSettledCashFreeze,OWNER_SETTLED_CASH_RECOVERY_CONFIRM,SETTLED_CASH_FREEZE} from './ownerSettledCashFreezeRecovery';
import {retainedHistorySchema,seedSettledCashHistory} from './settledCashRecovery.fixture';
import {readBracketedSettledCash} from './settledCashBracket';
import type {getOwnedProductionKalshiJson,readOwnedKalshiFeeds} from './personalExchangeRead';
import {dedicatedSignerFingerprint} from './commissioning';
import {digest} from '../v13-production/types';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
const url=process.env.V13_RECOVERY_DISPOSABLE_URL;
if(!url||url!==process.env.DATABASE_URL)throw Error('explicit_disposable_recovery_database_required');
const parsed=new URL(url);
if(parsed.hostname!=='127.0.0.1'||!/^\/recovery_disposable_\d+$/.test(parsed.pathname))throw Error('disposable_recovery_destination_required');
const owner='11111111-1111-4111-8111-111111111111';
const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const fp=dedicatedSignerFingerprint('test',pem)!;
const policyHash=computeV13LiveMoneyPolicyHash({id:'p',state:'APPROVED',createdBy:owner} as never);
let fixture:Awaited<ReturnType<typeof seedSettledCashHistory>>;
const scope={confirmation:OWNER_SETTLED_CASH_RECOVERY_CONFIRM,accountId:'a',expectedRevision:'1',settlementEventId:''};
const reset=async()=>{
 await db.query(`DELETE FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY';
 UPDATE public.v13_production_account SET blocked_reason='production_external_cash_mismatch',revision=1,execution_enabled=true,kill_switch=false;
 UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=false;
 UPDATE private.kalshi_connection_credentials SET revoked_at=NULL;`);
};
const read:typeof readOwnedKalshiFeeds=async(c,ts)=>fixture.read(c,ts);
const recover=(readFn:typeof readOwnedKalshiFeeds=read,options:Record<string,unknown>={})=>recoverOwnerSettledCashFreeze(owner,scope,{db,isScheduled:()=>false,read:readFn,...options});
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
 CREATE TABLE public.v13_production_intent(id text,account_id text,created_at timestamptz,request jsonb,state text,terminal boolean,reserved_micros bigint,
 client_order_id text NOT NULL,exchange_order_id text,filled_hundredths bigint NOT NULL DEFAULT 0);
 CREATE TABLE public.v13_production_position(account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE public.v13_production_event(account_id text,event_id text,digest text,kind text,payload jsonb,cash_delta_micros bigint,pnl_micros bigint);
 CREATE TABLE public.v13_production_observation(id text,account_id text,kind text,payload jsonb,digest text);`);
 await db.query(`INSERT INTO public.v13_production_account VALUES('a',$1,1,2,'p','connection',$2,$3,true,true,0,26484500,27720000,1,true,false,NULL,NULL)`,[owner,fp,SETTLED_CASH_FREEZE]);
 await db.query(`INSERT INTO public.v13_live_money_policy VALUES('p','a',$1,'APPROVED',$2)`,[owner,policyHash]);
 await db.query(`INSERT INTO private.kalshi_account_worker_lease VALUES('a',$1,'released',false,$2,22)`,[owner,fp]);
 await db.query(`INSERT INTO private.kalshi_connection_credentials VALUES($1,'connection','restricted_execution',NULL,now(),'credential_verified',$2,'secret')`,[owner,fp]);
 await db.query(`INSERT INTO vault.decrypted_secrets VALUES('secret',$1)`,[JSON.stringify({api_key_id:'test',private_key:pem})]);
 await db.query(retainedHistorySchema);
 fixture=await seedSettledCashHistory(db,'a',owner,fp);scope.settlementEventId=fixture.settlementEventId;
 await t.test('read-only preview proves all 173 retained intents and leaves the account untouched',async()=>{
  const p=await previewOwnerSettledCashFreeze(owner,{db,isScheduled:()=>false,read});assert.equal(p.ok,true,JSON.stringify(p));if(!p.ok)throw Error('fixture preview');
  assert.equal(p.retainedIntents,173);assert.equal(p.neverPostedIntents,170);assert.equal(p.postedOrders,3);assert.equal(p.fills,3);assert.equal(p.settlements,3);
  assert.equal(p.cashMicros,'26484500');assert.equal(p.openingMicros,'27720000');assert.equal(p.stakeCents,500);assert.equal(p.scope.settlementEventId,scope.settlementEventId);
  assert.equal((await db.query("SELECT blocked_reason FROM public.v13_production_account")).rows[0].blocked_reason,SETTLED_CASH_FREEZE);
  assert.equal((await previewOwnerSettledCashFreeze('22222222-2222-4222-8222-222222222222',{db,isScheduled:()=>false,read})).ok,false);
 });
 await t.test('BLOCKED status alone, wrong owner, tampered receipt and provider contradiction refuse',async()=>{
  const cases=[
   ["UPDATE private.strata_protective_exit_local_no_send SET evidence_sha256=repeat('0',64)","private.strata_protective_exit_local_no_send"],
   ["UPDATE private.strata_protective_exit_local_no_send SET owner_user_id='22222222-2222-4222-8222-222222222222'","private.strata_protective_exit_local_no_send"],
   ["DELETE FROM private.strata_protective_exit_local_no_send WHERE client_order_id='v13p-recovery-124'","private.strata_protective_exit_local_no_send"],
   ["UPDATE private.strata_emergency_exit_reservations SET worker_fencing_token=23 WHERE client_order_id='v13p-recovery-124'","private.strata_emergency_exit_reservations"],
   ["DELETE FROM public.v13_production_observation WHERE id='proof-46'","public.v13_production_observation"],
  ];
  for(const [sql,table] of cases){
   const saved=(await db.query('SELECT * FROM '+table)).rows;
   await db.query(sql!);let reads=0;const r=await recover(async(c,ts)=>{reads++;return read(c,ts);});assert.equal(r.ok,false,sql);assert.equal(reads,0,sql);
   await db.query('DELETE FROM '+table);
   for(const row of saved){const entries=Object.entries(row);await db.query('INSERT INTO '+table+'('+entries.map(e=>e[0]).join(',')+') VALUES('+entries.map((_,n)=>'$'+(n+1)).join(',')+')',entries.map(e=>e[1]));}
  }
  assert.equal((await recover(async(c,ts)=>({...await fixture.read(c,ts),orders:[...fixture.orders,{...fixture.orders[0],order_id:'contradiction',client_order_id:'v13p-recovery-124'}]}))).ok,false);
 });
 await t.test('incomplete history, mismatched cash, activity and stale scope refuse',async()=>{
  for(const change of [{historicalCoverageComplete:false},{fills:fixture.fills.slice(1)},{settlements:fixture.settlements.slice(1)},{cashMicros:'26484501'}])assert.equal((await recover(async(c,ts)=>({...await fixture.read(c,ts),...change}))).ok,false);
  for(const [set,restore] of [["arm_requested=true","arm_requested=false"],["state='owned'","state='released'"]]){
   await db.query('UPDATE private.kalshi_account_worker_lease SET '+set);assert.equal((await recover()).ok,false);await db.query('UPDATE private.kalshi_account_worker_lease SET '+restore);
  }
  assert.equal((await recover(read,{isScheduled:()=>true})).ok,false);
  for(const change of [{expectedRevision:'2'},{settlementEventId:'settlement:absent'}])assert.equal((await recoverOwnerSettledCashFreeze(owner,{...scope,...change},{db,isScheduled:()=>false,read})).ok,false);
 });
 await t.test('success preserves finances and history; exact replay is idempotent',async()=>{
  assert.equal((await recover()).ok,true);
  const a=(await db.query('SELECT * FROM public.v13_production_account')).rows[0];
  assert.equal(a.blocked_reason,null);assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);
  assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rows.length,1);
  assert.equal((await recover()).ok,true);
  assert.equal(a.cash_micros,'26484500');assert.equal(a.initial_cash_micros,'27720000');
  assert.equal((await db.query('SELECT configured_stake_cents FROM public.strata_configured_stake')).rows[0].configured_stake_cents,500);
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
  await db.query('UPDATE public.v13_production_account SET blocked_reason=$1,revision=1',[SETTLED_CASH_FREEZE]);
  assert.equal((await recover()).ok,false);
 });
 await t.test('DB-clock expiry after audit rolls back both audit and clearance',async()=>{
  await reset();
  await db.query(`CREATE FUNCTION delay_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5.1); RETURN NEW; END $$;
  CREATE TRIGGER slow_audit BEFORE INSERT ON public.v13_production_observation FOR EACH ROW EXECUTE FUNCTION delay_recovery_audit();`);
  const result=await recover();assert.equal(result.ok,false);assert.equal(result.reason,'recovery_final_freshness_or_cas_refused');
  const a=(await db.query('SELECT * FROM public.v13_production_account')).rows[0];
  assert.equal(a.blocked_reason,SETTLED_CASH_FREEZE);assert.equal(a.revision,'1');
  assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rows.length,0);
  await db.query('DROP TRIGGER slow_audit ON public.v13_production_observation');
 });
 await t.test('another freeze reason refuses before any exchange-shaped fixture read',async()=>{
  await reset();await db.query("UPDATE public.v13_production_account SET blocked_reason='production_uncertain_order'");
  let reads=0;const r=await recover(async(c,at)=>{reads++;return read(c,at);});
  assert.equal(r.ok,false);assert.equal(reads,0);
 });
 await t.test('one-cent signed mismatch and nonconserving event both retain the freeze',async()=>{
  await reset();
  const mismatched=await recover(async(c,ts)=>({...await read(c,ts),cashMicros:'24990000'}));
  assert.equal(mismatched.ok,false);
  await db.query('UPDATE public.v13_production_event SET cash_delta_micros=2990000 WHERE cash_delta_micros=3000000');
  try{assert.equal((await recover()).ok,false);}
  finally{await db.query('UPDATE public.v13_production_event SET cash_delta_micros=3000000 WHERE cash_delta_micros=2990000');}
  const a=(await db.query("SELECT revision,blocked_reason,cash_micros FROM public.v13_production_account WHERE id='a'")).rows[0];
  assert.deepEqual(a,{revision:'1',blocked_reason:SETTLED_CASH_FREEZE,cash_micros:'26484500'});
  assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rowCount,0);
 });
 await t.test('post-audit revision CAS refusal rolls back audit and account changes',async()=>{
  await reset();
  await db.query(`CREATE FUNCTION change_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   UPDATE public.v13_production_account SET revision=2 WHERE id='a'; RETURN NEW; END $$;
   CREATE TRIGGER change_revision BEFORE INSERT ON public.v13_production_observation FOR EACH ROW EXECUTE FUNCTION change_revision();`);
  try{const r=await recover();assert.equal(r.reason,'recovery_final_freshness_or_cas_refused');
   const a=(await db.query("SELECT revision,blocked_reason FROM public.v13_production_account WHERE id='a'")).rows[0];
   assert.deepEqual(a,{revision:'1',blocked_reason:SETTLED_CASH_FREEZE});
   assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rowCount,0);
  }finally{await db.query('DROP TRIGGER change_revision ON public.v13_production_observation');}
 });
 const acl=async()=>await db.query(`SELECT 'relation:'||relname AS object, relacl::text AS acl
  FROM pg_catalog.pg_class WHERE oid IN ('public.v13_production_observation'::regclass,'public.v13_production_account'::regclass)
  UNION ALL SELECT 'schema:'||nspname,nspacl::text FROM pg_catalog.pg_namespace WHERE nspname='private' ORDER BY object`).then(x=>x.rows);
 const beforeAcl=await acl();
 await db.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE fixture_recovery_runtime');
 const migration=readFileSync('../../sql/strata_owner_settled_cash_recovery_commit_fence.sql','utf8');
 await t.test('unexpected default function allocation rolls the entire migration back',async()=>{
  const client=await db.connect();
  try{
   await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO fixture_recovery_runtime');
   await assert.rejects(client.query(migration),/owner_settled_cash_recovery_unexpected_function_acl/);
   await client.query('ROLLBACK');
   const remaining=await client.query("SELECT to_regprocedure('private.enforce_owner_settled_cash_recovery_commit_fence()') AS fence");
   assert.equal(remaining.rows[0].fence,null);
  }finally{
   await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM fixture_recovery_runtime');
   client.release();
  }
 });
 await db.query(migration);
 await t.test('bounded signed-GET fixture bracket reaches real deferred recovery commit',async()=>{
  for(const drift of [false,true]){
   await reset();let balances=0,reads=0;
   const get:typeof getOwnedProductionKalshiJson=async(_creds,path,query,_fetch,_host,_member,signal)=>{
    assert.equal(signal?.aborted,false);reads++;
    if(path.endsWith('/balance')){
     assert.equal(query,'?subaccount=1&exchange_index=2');balances++;
     return {balance:2648,balance_dollars:drift&&balances===2?'26.4846':'26.4845',updated_ts:55+balances};
    }
    if(path.endsWith('/orders'))return {orders:path.includes('/historical/')?[]:fixture.orders};
    if(path.endsWith('/fills'))return {fills:path.includes('/historical/')?[]:fixture.fills};
    if(path.endsWith('/positions'))return {market_positions:[]};
    if(path.endsWith('/settlements'))return {settlements:fixture.settlements};
    throw Error('unexpected signed fixture path');
   };
   const result=await recover((c,ts)=>readBracketedSettledCash(c,ts,{get}));
   assert.equal(result.ok,!drift);assert.equal(balances,drift?2:3);assert.equal(reads,drift?8:15);
   const a=(await db.query('SELECT blocked_reason,execution_enabled,kill_switch FROM public.v13_production_account')).rows[0];
   assert.deepEqual(a,drift?{blocked_reason:SETTLED_CASH_FREEZE,execution_enabled:true,kill_switch:false}:
     {blocked_reason:null,execution_enabled:false,kill_switch:true});
   assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rowCount,drift?0:1);
  }
 });
 await t.test('exact migration pins invoker functions and reciprocal deferred ALWAYS triggers, with no new grants',async()=>{
  assert.deepEqual(await acl(),beforeAcl);
  const catalog=await db.query(`SELECT c.relname,t.tgname,t.tgtype::int,t.tgenabled,t.tgdeferrable,t.tginitdeferred,t.tgconstraint::text,
   p.proname,p.prosecdef,p.prorettype::regtype::text,p.proconfig, n.nspname,
   has_function_privilege('anon',p.oid,'EXECUTE') AS anon_can_execute,
   has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_can_execute,
   has_function_privilege('fixture_recovery_runtime',p.oid,'EXECUTE') AS runtime_can_execute
   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
   JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE tgname IN ('owner_settled_cash_recovery_commit_fence','owner_settled_cash_recovery_transition_fence')
   ORDER BY t.tgname`);
  assert.equal(catalog.rows.length,2);
  assert.deepEqual(catalog.rows.map(r=>[r.relname,r.tgname,r.tgtype]),[
   ['v13_production_observation','owner_settled_cash_recovery_commit_fence',5],
   ['v13_production_account','owner_settled_cash_recovery_transition_fence',17],
  ]);
  for(const r of catalog.rows){
   assert.equal(r.proname,'enforce_'+r.tgname);assert.equal(r.nspname,'private');
   assert.equal(r.tgenabled,'A');assert.equal(r.tgdeferrable,true);assert.equal(r.tginitdeferred,true);
   assert.notEqual(r.tgconstraint,'0');assert.equal(r.prosecdef,false);assert.equal(r.prorettype,'trigger');
   assert.deepEqual(r.proconfig,['search_path=pg_catalog']);
   assert.equal(r.anon_can_execute,false);assert.equal(r.authenticated_can_execute,false);assert.equal(r.runtime_can_execute,false);
  }
 });
 await t.test('direct freeze clear without its audit fails at commit and rolls back',async()=>{
  await reset();const client=await db.connect();
  try{await client.query('BEGIN');
   assert.equal((await client.query(`UPDATE public.v13_production_account SET
      blocked_reason=NULL,revision=revision+1,execution_enabled=false,kill_switch=true,
      evidence_digest=repeat('a',64),reconciled_at=now() WHERE id='a'`)).rowCount,1);
   await assert.rejects(client.query('COMMIT'),/owner_settled_cash_recovery_transition_unproven/);
  }finally{await client.query('ROLLBACK');client.release();}
  assert.equal((await db.query('SELECT blocked_reason FROM public.v13_production_account')).rows[0].blocked_reason,SETTLED_CASH_FREEZE);
 });
 await t.test('matching audit from an earlier transaction cannot authorize a second clearance',async()=>{
  await reset();assert.equal((await recover()).ok,true);
  await db.query(`UPDATE public.v13_production_account SET revision=1,blocked_reason=$1,
   execution_enabled=true,kill_switch=false WHERE id='a'`,[SETTLED_CASH_FREEZE]);
  const client=await db.connect();
  try{await client.query('BEGIN');
   assert.equal((await client.query(`UPDATE public.v13_production_account SET
      blocked_reason=NULL,revision=revision+1,execution_enabled=false,kill_switch=true
      WHERE id='a'`)).rowCount,1);
   await assert.rejects(client.query('COMMIT'),/owner_settled_cash_recovery_transition_unproven/);
  }finally{await client.query('ROLLBACK');client.release();}
  assert.equal((await db.query('SELECT blocked_reason FROM public.v13_production_account')).rows[0].blocked_reason,SETTLED_CASH_FREEZE);
  assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rowCount,1);
 });
 await t.test('non-owner service role with preexisting DML grants uses both triggers without EXECUTE grant',async()=>{
  await reset();
  // Fixture privileges only; the migration itself is deliberately grant-free.
  await db.query(`GRANT USAGE ON SCHEMA private,vault TO fixture_recovery_runtime;
   GRANT SELECT ON public.v13_production_account,public.v13_live_money_policy,private.kalshi_account_worker_lease,
    private.kalshi_connection_credentials,vault.decrypted_secrets,public.v13_production_intent,
    public.v13_production_position,private.strata_emergency_exit_reservations,
    public.v13_production_event,public.v13_production_observation,private.strata_protective_exit_reconciliations,private.strata_protective_exit_local_no_send TO fixture_recovery_runtime;
   GRANT UPDATE (blocked_reason,reconciled_at,evidence_digest,revision,execution_enabled,kill_switch)
    ON public.v13_production_account TO fixture_recovery_runtime;
   GRANT INSERT ON public.v13_production_observation TO fixture_recovery_runtime;
   GRANT UPDATE (state) ON public.v13_live_money_policy,private.kalshi_account_worker_lease TO fixture_recovery_runtime;
   GRANT UPDATE (revoked_at) ON private.kalshi_connection_credentials TO fixture_recovery_runtime; GRANT UPDATE (event_id) ON public.v13_production_event TO fixture_recovery_runtime; GRANT UPDATE ON public.v13_production_intent,public.v13_production_observation,public.v13_production_position,private.strata_emergency_exit_reservations,private.strata_protective_exit_reconciliations,private.strata_protective_exit_local_no_send TO fixture_recovery_runtime;`);
  const client=await db.connect();
  try{
   await client.query('SET ROLE fixture_recovery_runtime');
   const query=async(sql:string,args?:unknown[])=>{try{return await client.query(sql,args);}catch(e){console.error('fixture_role_failure',e);throw e;}};
   const scoped={query,connect:async()=>({query,release:()=>{}})};
   const result=await recover(read,{db:scoped});
   assert.equal(result.ok,true,JSON.stringify(result));
   assert.equal(result.tradingAuthorized,false);
  }finally{await client.query('RESET ROLE');client.release();}
  const a=(await db.query('SELECT blocked_reason,execution_enabled,kill_switch FROM public.v13_production_account')).rows[0];
  assert.deepEqual(a,{blocked_reason:null,execution_enabled:false,kill_switch:true});
 });
 await t.test('deferred fence accepts fresh expected state and rejects delay after successful CAS',async()=>{
  await reset();assert.equal((await recover()).ok,true);
  await reset();let updateAppliedInTx=false;
  const injected={query:db.query.bind(db),connect:async()=>{const c=await db.connect();return {
   query:async(sql:string,args?:unknown[])=>{
    if(sql==='COMMIT')await c.query('SELECT pg_sleep(5.1)');
    const result=await c.query(sql,args);
    if(sql.startsWith('UPDATE public.v13_production_account'))updateAppliedInTx=result.rowCount===1;
    return result;
   },
   release:(err?:Error|boolean)=>c.release(err),
  };}};
  const result=await recover(read,{db:injected});
  assert.equal(updateAppliedInTx,true);
  assert.equal(result.reason,'recovery_commit_outcome_unverified');
  assert.equal(result.riskFreezeCleared,null);
  const a=(await db.query('SELECT revision,blocked_reason FROM public.v13_production_account')).rows[0];
  assert.deepEqual(a,{revision:'1',blocked_reason:SETTLED_CASH_FREEZE});
  assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rowCount,0);
 });
 await t.test('lost successful COMMIT acknowledgement remains typed unknown and disarmed',async()=>{
  await reset();
  const injected={query:db.query.bind(db),connect:async()=>{const c=await db.connect();return {
   query:async(sql:string,args?:unknown[])=>{const result=await c.query(sql,args);if(sql==='COMMIT')throw Error('fixture_lost_ack');return result;},
   release:(err?:Error|boolean)=>c.release(err),
  };}};
  const result=await recover(read,{db:injected});
  assert.equal(result.reason,'recovery_commit_outcome_unverified');assert.equal(result.riskFreezeCleared,null);
  assert.equal('outcomeUnknown' in result && result.outcomeUnknown,true);
  const outcome=await ownerSettledCashRecoveryOutcome(owner,scope,db);assert.equal(outcome.ok,true);assert.equal(outcome.tradingAuthorized,false);
  assert.equal((await recover()).ok,true);
  assert.equal((await ownerSettledCashRecoveryOutcome('22222222-2222-4222-8222-222222222222',scope,db)).ok,false);
  const a=(await db.query('SELECT blocked_reason,execution_enabled,kill_switch FROM public.v13_production_account')).rows[0];
  assert.deepEqual(a,{blocked_reason:null,execution_enabled:false,kill_switch:true});
  assert.equal((await db.query("SELECT * FROM public.v13_production_observation WHERE kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'")).rowCount,1);
 });
 }finally{await db.end();}
});
