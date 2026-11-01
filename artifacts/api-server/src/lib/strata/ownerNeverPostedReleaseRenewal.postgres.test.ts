import {ownerRenewalFailureDiagnostics} from './ownerRenewalFailureDiagnostics';
import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
import {getTableColumns} from 'drizzle-orm';import {v13ProductionEventTable} from '@workspace/db';
import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {pool as db} from '@workspace/db';import {digest} from '../v13-production/types';
import {authorizeOwnerShaRelease,OWNER_SHA_RELEASE_CONFIRM} from './ownerShaRelease';
import {inspectOwnerSignedExchangeReleaseProof} from './ownerSignedExchangeReleaseProof';
import {dedicatedSignerFingerprint} from './commissioning';
const migration=readFileSync(resolve(process.cwd(),'../../lib/db/drizzle/0000_reviewed_release_schema.sql'),'utf8');
const eventDdl=migration.match(/CREATE TABLE IF NOT EXISTS "v13_production_event" \([\s\S]*?\n\);/)?.[0];
if(!eventDdl)throw Error('actual_event_migration_ddl_required');
const url=process.env.V13_RENEWAL_DISPOSABLE_URL;
if(!url||url!==process.env.DATABASE_URL||new URL(url).hostname!=='127.0.0.1'||!/^\/renewal_disposable_\d+$/.test(new URL(url).pathname))throw Error('explicit_disposable_renewal_database_required');
const owner='11111111-1111-4111-8111-111111111111',reviewer='22222222-2222-4222-8222-222222222222';
const oldApproval='33333333-3333-4333-8333-333333333333',qualification='44444444-4444-4444-8444-444444444444';
const review='55555555-5555-4555-8555-555555555555',grant='66666666-6666-4666-8666-666666666666';
const oldQualification='77777777-7777-4777-8777-777777777777',financial='88888888-8888-4888-8888-888888888888';
const provider='99999999-9999-4999-8999-999999999999',secret='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sha='b'.repeat(40),oldSha='a'.repeat(40),hash='c'.repeat(64);
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const keyId='offline-only',fingerprint=dedicatedSignerFingerprint(keyId,privateKey)!;
const body={qualificationId:qualification,confirmation:OWNER_SHA_RELEASE_CONFIRM};
let beforeRead=async()=>{},afterRead=async()=>{},extraFeeds:Record<string,unknown>={},clock=()=>Date.now();
const feeds=async(_m:unknown,observedAtMs:number)=>{await beforeRead();await afterRead();return {ok:true as const,observedAtMs,historicalCoverageComplete:true,
 cashMicros:'25000000',orders:[],fills:[],positions:[],settlements:[],...extraFeeds};};
const run=(id=owner)=>authorizeOwnerShaRelease(id,body,{db:db as never,sha:()=>sha,now:()=>clock(),readFeeds:feeds as never});
const diagnostic=()=>inspectOwnerSignedExchangeReleaseProof(owner,{db:db as never,now:()=>clock(),read:feeds as never,
 feeProbe:async()=>({ok:true}) as never,v4:async()=>({ok:true,checks:{protectiveExitRelease:false,ownerShaApproval:false}}) as never});
async function setup(){await db.query(`CREATE SCHEMA private;CREATE SCHEMA vault;
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,
 policy_id text,kalshi_connection_id uuid,key_fingerprint text,blocked_reason text,commissioned boolean,cash_precision_verified boolean,
 reserved_micros bigint,cash_micros bigint,revision bigint,execution_enabled boolean,kill_switch boolean,
 reconciled_at timestamptz,minimum_exit_micros bigint,commissioning_digest text,fee_artifact_digest text);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,created_by text,state text,policy_hash text,
 fee_source_url text,fee_policy_version text,fee_formula_version text,approved_at timestamptz,max_entry_stake_cents int,max_entry_all_in_cents int);
 CREATE TABLE public.strata_configured_stake(execution_account_id text,configured_stake_cents int);
 CREATE TABLE public.live_execution_config(id text,mode text,live_execution_enabled boolean,manual_kill_switch boolean);
 CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY REFERENCES public.v13_production_account(id),owner_user_id uuid,state text,arm_requested boolean,account_kill boolean,
 credential_fingerprint text,financial_account_id uuid,provider_connection_id uuid,vault_secret_id uuid,holder_id text,fencing_token bigint,heartbeat_at timestamptz);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,role text,revoked_at timestamptz,
 verified_at timestamptz,verification_reason text,key_fingerprint text,vault_secret_id uuid);
 CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY,decrypted_secret text);
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text REFERENCES public.v13_production_account(id),created_at timestamptz DEFAULT now(),request jsonb,decision jsonb,
 state text,terminal boolean,reserved_micros bigint,filled_hundredths bigint,kind text,market text,side text,parent_id text,cancel_attempted boolean,exchange_order_id text,
 policy_hash text,fee_fingerprint text,capability_digest text,client_order_id text UNIQUE);
 CREATE TABLE public.v13_production_position(id text,account_id text REFERENCES public.v13_production_account(id),quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 ${eventDdl}
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text REFERENCES public.v13_production_account(id),state text);
 CREATE TABLE public.v13_production_observation(id text PRIMARY KEY,account_id text REFERENCES public.v13_production_account(id),kind text,payload jsonb,digest text,observed_at timestamptz DEFAULT now());
 CREATE TABLE private.strata_protective_release_qualification(qualification_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,release_commit_sha text,evidence_digest text,observed_at timestamptz,expires_at timestamptz);
 CREATE TABLE private.strata_owner_sha_approvals(approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid,execution_account_id text,release_commit_sha text,
 qualification_id uuid,qualification_digest text,confirmed_at timestamptz DEFAULT now(),revoked_at timestamptz);
 CREATE UNIQUE INDEX active_approvals ON private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha) WHERE revoked_at IS NULL;
 CREATE TABLE private.strata_standing_execution_reviews(release_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,release_commit_sha text,policy_hash text,independent_reviewer_id uuid,state text,revoked_at timestamptz,created_at timestamptz);
 CREATE TABLE private.strata_continuous_execution_grants(grant_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,release_commit_sha text,policy_hash text,independent_reviewer_id uuid,
 reviewed_release_id uuid,revoked_at timestamptz,owner_confirmation text,consented_at timestamptz);
 INSERT INTO public.v13_production_account VALUES('a','${owner}',1,2,'p','${financial}','${fingerprint}',NULL,true,true,0,25000000,1,true,false,now(),10000,'${hash}','${hash}');
 INSERT INTO public.v13_live_money_policy VALUES('p','a','${owner}','APPROVED','${hash}',NULL,NULL,NULL,now(),500,625);
 INSERT INTO public.strata_configured_stake VALUES('a',500);
 INSERT INTO public.live_execution_config VALUES('singleton','V13_PRODUCTION',true,false);
 INSERT INTO public.financial_accounts VALUES('${financial}','${owner}','kalshi');INSERT INTO private.provider_connections VALUES('${provider}','${financial}');
 INSERT INTO private.kalshi_account_worker_lease VALUES('a','${owner}','released',false,false,'${fingerprint}','${financial}','${provider}','${secret}','old-worker',25,now());
 INSERT INTO private.kalshi_connection_credentials VALUES('${owner}','${financial}','${provider}','restricted_execution',NULL,now(),'credential_verified','${fingerprint}','${secret}');
 INSERT INTO private.strata_protective_release_qualification VALUES('${oldQualification}','${owner}','a','${oldSha}','${hash}',now()-interval '1 day',now()-interval '23 hours 45 minutes');
 INSERT INTO private.strata_owner_sha_approvals VALUES('${oldApproval}','${owner}','a','${oldSha}','${oldQualification}','${hash}',now()-interval '23 hours 55 minutes',NULL);
 INSERT INTO private.strata_standing_execution_reviews VALUES('${review}','${owner}','a','${oldSha}','${hash}','${reviewer}','approved',NULL,now()-interval '23 hours 54 minutes');
 INSERT INTO private.strata_continuous_execution_grants VALUES('${grant}','${owner}','a','${oldSha}','${hash}','${reviewer}','${review}',NULL,'I_AUTHORIZE_REVOCABLE_CONTINUOUS_EXECUTION_FOR_MY_REVIEWED_EXACT_SHA_V1',now()-interval '23 hours 53 minutes');
 INSERT INTO private.strata_protective_release_qualification VALUES('${qualification}','${owner}','a','${sha}','${hash}',now(),now()+interval '15 minutes');`);
 await db.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[secret,JSON.stringify({api_key_id:keyId,private_key:privateKey})]);
 await db.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES('activation','a','OWNER_ACTIVATION_REQUEST','{}',$1)`,[
 digest({accountId:'a',policyId:'p',feeDigest:hash,stakeCents:500,commissioningDigest:hash,minimumExitMicros:10000})]);
}
async function reset(){beforeRead=async()=>{};afterRead=async()=>{};extraFeeds={};clock=()=>Date.now();
 await db.query(`DELETE FROM private.strata_owner_sha_approvals WHERE approval_id<>'${oldApproval}';UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL,qualification_digest='${hash}';
 UPDATE private.strata_standing_execution_reviews SET revoked_at=NULL,policy_hash='${hash}';UPDATE private.strata_continuous_execution_grants SET revoked_at=NULL,policy_hash='${hash}';
 UPDATE public.v13_production_account SET owner_user_id='${owner}',execution_enabled=true,kill_switch=false,blocked_reason=NULL,reserved_micros=0,cash_micros=25000000,key_fingerprint='${fingerprint}',revision=1;
 UPDATE public.v13_live_money_policy SET policy_hash='${hash}';
 UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=false,account_kill=false,credential_fingerprint='${fingerprint}',fencing_token=25;
 UPDATE private.kalshi_connection_credentials SET revoked_at=NULL;
 UPDATE public.live_execution_config SET live_execution_enabled=true,manual_kill_switch=false;
 UPDATE private.strata_protective_release_qualification SET observed_at=now(),expires_at=now()+interval '15 minutes' WHERE qualification_id='${qualification}';
 DELETE FROM public.v13_production_event;DELETE FROM public.v13_production_position;DELETE FROM private.strata_emergency_exit_reservations;
 DELETE FROM public.v13_production_observation WHERE id<>'activation';DELETE FROM public.v13_production_intent;`);
 for(let n=0;n<5;n++){
  const id=`00000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`,request={market:'KXBTC15M-TEST',side:'NO',action:'BUY',contracts:3,limitMicros:500000,reduceOnly:false,timeInForce:'IOC',clientOrderId:`v13p-${id}`};
  const decision={source:{id:`source-${n}`}},fee='d'.repeat(64),cap=digest({id,request,decision,policyHash:hash,fee});
  await db.query(`INSERT INTO public.v13_production_intent(id,account_id,request,decision,state,terminal,reserved_micros,filled_hundredths,kind,market,side,parent_id,cancel_attempted,exchange_order_id,policy_hash,fee_fingerprint,capability_digest,client_order_id)
   VALUES($1,'a',$2,$3,'BLOCKED',true,0,0,'ENTRY','KXBTC15M-TEST','NO',NULL,false,NULL,$4,$5,$6,$7)`,[id,request,decision,hash,fee,cap,request.clientOrderId]);
  const payload={id,reason:'production_final_fee_or_quote_changed'};
  await db.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,'a','PROVEN_NOT_POSTED',$2,$3)`,[`proof-${n}`,payload,digest(payload)]);
 }
}
const count=async()=>Number((await db.query(`SELECT count(*)::int n FROM private.strata_owner_sha_approvals WHERE release_commit_sha=$1`,[sha])).rows[0].n);
const state=async()=>({account:(await db.query('SELECT * FROM public.v13_production_account')).rows,
 worker:(await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows,
 intents:(await db.query('SELECT * FROM public.v13_production_intent ORDER BY id')).rows,
 grant:(await db.query('SELECT * FROM private.strata_continuous_execution_grants')).rows,
 review:(await db.query('SELECT * FROM private.strata_standing_execution_reviews')).rows});
test('commissioned never-posted release renewal, actual PostgreSQL',async t=>{try{await setup();
 await t.test('unexpected SQLSTATE diagnostic is bounded and contains no raw error fields',()=>{
  const error=Object.assign(new Error('secret SQL and credentials'),{code:'42703',detail:'secret value',query:'SELECT secret',account:'private'});
  assert.deepEqual(ownerRenewalFailureDiagnostics(error,'preflight_history'),{version:1,phase:'preflight_history',category:'schema_contract',sqlState:'42703'});
  assert.doesNotMatch(JSON.stringify(ownerRenewalFailureDiagnostics(error,'preflight_history')),/secret|credentials|SELECT|private/);
 });
 await t.test('unknown codes/phases and hostile code getters cannot leak or throw',()=>{
  assert.deepEqual(ownerRenewalFailureDiagnostics({code:'secret'},'secret phase'),{version:1,phase:'unknown',category:'unclassified',sqlState:null});
  const hostile={get code(){throw Error('secret getter');}};
  assert.equal(ownerRenewalFailureDiagnostics(hostile,'commit').sqlState,null);
  assert.equal(ownerRenewalFailureDiagnostics({code:'42501'},'locked_authority').category,'database_permission');
 });
 await t.test('actual migration/schema parity: old id projection fails42703 even with no events',async()=>{
  const columns=(await db.query("SELECT attname FROM pg_attribute WHERE attrelid='public.v13_production_event'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attname")).rows.map(r=>r.attname);
  assert.deepEqual(columns,Object.values(getTableColumns(v13ProductionEventTable)).map(c=>c.name).sort());
  assert.ok(columns.includes('event_id'));assert.ok(!columns.includes('id'));
  assert.equal((await db.query('SELECT count(*)::int n FROM public.v13_production_event')).rows[0].n,0);
  await assert.rejects(db.query('SELECT id FROM public.v13_production_event WHERE account_id=$1 AND intent_id=ANY($2::text[]) LIMIT 1',['a',[]]),{code:'42703'});
 });
 await t.test('five authentic no-send intents renew without changing controls/history; idempotent current SHA',async()=>{
  await reset();const before=await state();let unlocked=false;
  beforeRead=async()=>{const c=await db.connect();try{await c.query('BEGIN');await c.query("SELECT id FROM public.v13_production_account WHERE id='a' FOR UPDATE NOWAIT");await c.query("SELECT execution_account_id FROM private.kalshi_account_worker_lease WHERE execution_account_id='a' FOR UPDATE NOWAIT");unlocked=true;}finally{await c.query('ROLLBACK');c.release();}};
  const r=await run();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(unlocked,true);assert.deepEqual(await state(),before);assert.equal(await count(),1);
  const again=await run();assert.equal(again.ok,true,JSON.stringify(again));assert.equal((again as any).approvalId,(r as any).approvalId);assert.equal(await count(),1);assert.deepEqual(await state(),before);
 });
 await t.test('diagnostic correctly reports flat, stays read-only and grants no authority',async()=>{await reset();const before=await state();const r=await diagnostic();assert.equal(r.ok,true,JSON.stringify(r));if(!r.ok)return;
  assert.equal(r.authenticatedExchangeFlat,true);assert.equal(r.tradingAuthorized,false);assert.equal(r.recordPersisted,false);assert.equal(await count(),0);assert.deepEqual(await state(),before);});
 const mutations:[string,string][]=[
 ['UNKNOWN intent',"UPDATE public.v13_production_intent SET state='UNKNOWN',terminal=false"],
 ['nonterminal BLOCKED',"UPDATE public.v13_production_intent SET terminal=false"],
 ['reserved intent',"UPDATE public.v13_production_intent SET reserved_micros=1"],
 ['filled intent',"UPDATE public.v13_production_intent SET filled_hundredths=1"],
 ['exchange acknowledgment',"UPDATE public.v13_production_intent SET exchange_order_id='ack'"],
 ['missing proof',"DELETE FROM public.v13_production_observation WHERE id='proof-0'"],
 ['forged proof',"UPDATE public.v13_production_observation SET digest=repeat('0',64) WHERE id='proof-0'"],
 ['duplicate proof',"INSERT INTO public.v13_production_observation SELECT 'copy',account_id,kind,payload,digest,observed_at FROM public.v13_production_observation WHERE id='proof-0'"],
 ['contradictory POST_ATTEMPT',"INSERT INTO public.v13_production_observation SELECT 'post',account_id,'POST_ATTEMPT',payload,digest,observed_at FROM public.v13_production_observation WHERE id='proof-0'"],
 ['contradictory POST_UNCERTAIN',"INSERT INTO public.v13_production_observation SELECT 'post',account_id,'POST_UNCERTAIN',payload,digest,observed_at FROM public.v13_production_observation WHERE id='proof-0'"],
 ['mutated request',"UPDATE public.v13_production_intent SET request=jsonb_set(request,'{contracts}','4')"],
 ['mutated client',"UPDATE public.v13_production_intent SET client_order_id='other-'||id"],
 ['mutated decision',"UPDATE public.v13_production_intent SET decision='{}'"],
 ['financial event',"INSERT INTO public.v13_production_event(account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at) SELECT 'a','fill',id,'FILL',repeat('a',64),'{}',0,0,now() FROM public.v13_production_intent LIMIT 1"],
 ['nonzero position',"INSERT INTO public.v13_production_position VALUES('pos','a',1,0,0)"],
 ['closed position with historical pnl',"INSERT INTO public.v13_production_position VALUES('pos','a',0,0,1)"],
 ['protective UNKNOWN',"INSERT INTO private.strata_emergency_exit_reservations VALUES('a','UNKNOWN')"],
 ['protective VOID history unsupported',"INSERT INTO private.strata_emergency_exit_reservations VALUES('a','VOID')"],
 ['reserved account',"UPDATE public.v13_production_account SET reserved_micros=1"],
 ['risk freeze',"UPDATE public.v13_production_account SET blocked_reason='risk_freeze'"],
 ['changed policy',"UPDATE public.v13_live_money_policy SET policy_hash=repeat('e',64)"],
 ['active worker',"UPDATE private.kalshi_account_worker_lease SET state='owned'"],
 ['armed worker',"UPDATE private.kalshi_account_worker_lease SET arm_requested=true"],
 ['wrong worker key',"UPDATE private.kalshi_account_worker_lease SET credential_fingerprint=repeat('e',64)"],
 ['revoked signer',"UPDATE private.kalshi_connection_credentials SET revoked_at=now()"],
 ['revoked prior grant',"UPDATE private.strata_continuous_execution_grants SET revoked_at=now()"],
 ['revoked prior approval',"UPDATE private.strata_owner_sha_approvals SET revoked_at=now()"],
 ['revoked prior review',"UPDATE private.strata_standing_execution_reviews SET revoked_at=now()"],
 ['wrong prior qualification digest',"UPDATE private.strata_owner_sha_approvals SET qualification_digest=repeat('e',64)"],
 ['stale qualification',`UPDATE private.strata_protective_release_qualification SET expires_at=now()+interval '30 seconds' WHERE qualification_id='${qualification}'`],
 ['foreign qualification',`UPDATE private.strata_protective_release_qualification SET owner_user_id='${reviewer}' WHERE qualification_id='${qualification}'`],
 ];
 for(const [name,sql] of mutations)await t.test(name+' rejects without approval',async()=>{await reset();await db.query(sql);const r=await run();assert.equal(r.ok,false,JSON.stringify(r));assert.equal(await count(),0);
  if(name==='foreign qualification')await db.query(`UPDATE private.strata_protective_release_qualification SET owner_user_id=$1 WHERE qualification_id=$2`,[owner,qualification]);});
 await t.test('missing prior grant cannot fall back to bootstrap',async()=>{await reset();const c=await db.query('SELECT * FROM private.strata_continuous_execution_grants');await db.query('DELETE FROM private.strata_continuous_execution_grants');const r=await run();assert.equal(r.ok,false);assert.match(r.reason,/prior_grant/);assert.equal(await count(),0);const g=c.rows[0];await db.query('INSERT INTO private.strata_continuous_execution_grants SELECT * FROM json_populate_record(NULL::private.strata_continuous_execution_grants,$1::json)',[JSON.stringify(g)]);});
 await t.test('foreign owner cannot read signer or renew',async()=>{await reset();let reads=0;beforeRead=async()=>{reads++;};assert.equal((await run(reviewer)).ok,false);assert.equal(reads,0);assert.equal(await count(),0);});
 for(const [name,change] of [
  ['lease ARM→DISARM ABA',"UPDATE private.kalshi_account_worker_lease SET arm_requested=true; UPDATE private.kalshi_account_worker_lease SET arm_requested=false"],
  ['account revision',"UPDATE public.v13_production_account SET revision=revision+1"],
  ['history decision mutation',"UPDATE public.v13_production_intent SET decision='{}'"],
  ['proof deletion',"DELETE FROM public.v13_production_observation WHERE id='proof-0'"],
  ['credential revoke→restore ABA',"UPDATE private.kalshi_connection_credentials SET revoked_at=now(); UPDATE private.kalshi_connection_credentials SET revoked_at=NULL"],
  ['prior grant revoked',"UPDATE private.strata_continuous_execution_grants SET revoked_at=now()"],
 ] as const)await t.test(name+' during signed read rejects',async()=>{await reset();afterRead=async()=>{await db.query(change);};const r=await run();assert.equal(r.ok,false,JSON.stringify(r));assert.equal(await count(),0);});
 for(const [name,value] of [['incomplete archive',{historicalCoverageComplete:false}],['cash mismatch',{cashMicros:'24999999'}],['foreign provider order',{orders:[{client_order_id:'foreign'}]}],['provider fill',{fills:[{order_id:'foreign'}]}],['provider position',{positions:[{ticker:'KXBTC15M-TEST',position_fp:'0.01'}]}],['provider settlement',{settlements:[{}]}]] as const)
  await t.test(name+' rejects',async()=>{await reset();extraFeeds=value;assert.equal((await run()).ok,false);assert.equal(await count(),0);});
 await t.test('stale/clock-regressed signed proof rejects',async()=>{for(const delta of [15001,-1]){await reset();const start=Date.now();let reads=0;clock=()=>reads++===0?start:start+delta;assert.equal((await run()).ok,false);assert.equal(await count(),0);}});
 await t.test('normal qualification expiry and fifteen-second signed proof are retained',async()=>{
  for(const elapsed of [14000,15000]){await reset();await db.query(`UPDATE private.strata_protective_release_qualification SET observed_at=now()-interval '5 minutes',expires_at=now()+interval '10 minutes' WHERE qualification_id='${qualification}'`);
   const start=Date.now();let advanced=false;clock=()=>start+(advanced?elapsed:0);afterRead=async()=>{advanced=true;};
   const r=await run();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(await count(),1);}
 });
 await t.test('duplicate client hidden in mixed diagnostic history is rejected',async()=>{await reset();const source=(await db.query('SELECT * FROM public.v13_production_intent ORDER BY id LIMIT 1')).rows[0];
  await db.query(`INSERT INTO public.v13_production_intent(id,account_id,request,kind,state,terminal,reserved_micros,client_order_id) VALUES('mixed','a',$1,'ENTRY','TERMINAL',true,0,'different-column-client')`,[source.request]);
  assert.equal((await diagnostic()).ok,false);assert.equal((await run()).ok,false);assert.equal(await count(),0);
 });
 await t.test('no-send receipt from another account is not borrowed',async()=>{await reset();
  await db.query(`INSERT INTO public.v13_production_account SELECT 'foreign', '${reviewer}'::uuid,subaccount,exchange_index,policy_id,kalshi_connection_id,key_fingerprint,blocked_reason,commissioned,cash_precision_verified,reserved_micros,cash_micros,revision,execution_enabled,kill_switch,reconciled_at,minimum_exit_micros,commissioning_digest,fee_artifact_digest FROM public.v13_production_account WHERE id='a'`);
  await db.query("UPDATE public.v13_production_observation SET account_id='foreign' WHERE id='proof-0'");
  assert.equal((await run()).ok,false);assert.equal((await diagnostic()).ok,false);assert.equal(await count(),0);
  await db.query("DELETE FROM public.v13_production_observation WHERE account_id='foreign';DELETE FROM public.v13_production_account WHERE id='foreign'");
 });
 await t.test('concurrent approvals serialize to one current SHA approval',async()=>{await reset();const results=await Promise.all([run(),run()]);assert.ok(results.some(r=>r.ok));assert.equal(await count(),1);for(const r of results)assert.equal(r.ok,true,JSON.stringify(r));});
 await t.test('transaction account+lease locks block concurrent START/mutation through approval insert',async()=>{await reset();let checked=false;
  const custom={query:db.query.bind(db),connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
   if(sql.startsWith('INSERT INTO private.strata_owner_sha_approvals')){const rival=await db.connect();try{for(const statement of ["SELECT execution_account_id FROM private.kalshi_account_worker_lease WHERE execution_account_id='a' FOR UPDATE NOWAIT","SELECT id FROM public.v13_production_account WHERE id='a' FOR UPDATE NOWAIT","SELECT id FROM public.v13_production_intent WHERE account_id='a' FOR UPDATE NOWAIT","SELECT id FROM public.v13_production_observation WHERE kind='PROVEN_NOT_POSTED' FOR UPDATE NOWAIT","SELECT grant_id FROM private.strata_continuous_execution_grants FOR UPDATE NOWAIT"]){await rival.query('BEGIN');await assert.rejects(rival.query(statement),{code:'55P03'});await rival.query('ROLLBACK');}checked=true;}finally{await rival.query('ROLLBACK');rival.release();}}
   return c.query(sql,args);}};}};
  const r=await authorizeOwnerShaRelease(owner,body,{db:custom as never,sha:()=>sha,readFeeds:feeds as never});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(checked,true);});
 await t.test('lost COMMIT acknowledgment is uncertain, retry retains one approval',async()=>{await reset();let lost=false;
  const custom={query:db.query.bind(db),connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
   const r=await c.query(sql,args);if(sql==='COMMIT'&&!lost){lost=true;throw Error('lost_ack_after_server_commit');}return r;}};}};
  const r=await authorizeOwnerShaRelease(owner,body,{db:custom as never,sha:()=>sha,readFeeds:feeds as never});assert.equal(r.ok,false);assert.equal(await count(),1);
  const retry=await run();assert.equal(retry.ok,true,JSON.stringify(retry));assert.equal(await count(),1);
 });
 await t.test('provider order contradicting a valid never-posted receipt is never flat',async()=>{await reset();const i=(await db.query('SELECT * FROM public.v13_production_intent ORDER BY id LIMIT 1')).rows[0];
  extraFeeds={orders:[{order_id:'unexpected-provider-ack',client_order_id:i.client_order_id,ticker:i.market,book_side:'ask',action:'buy',status:'canceled',initial_count_fp:'3.00',fill_count_fp:'0.00',yes_price_dollars:'0.5000'}]};
  const r=await diagnostic();assert.equal(r.ok,true,JSON.stringify(r));if(r.ok)assert.equal(r.authenticatedExchangeFlat,false);assert.equal((await run()).ok,false);assert.equal(await count(),0);
 });
 await t.test('diagnostic catches history changed after its signed read',async()=>{await reset();afterRead=async()=>{await db.query("DELETE FROM public.v13_production_observation WHERE id='proof-0'");};const r=await diagnostic();assert.equal(r.ok,false);assert.equal(await count(),0);});
 }finally{await db.end();}});
