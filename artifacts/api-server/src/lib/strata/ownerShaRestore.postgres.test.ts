import test from 'node:test';
import assert from 'node:assert/strict';
import {pool as db} from '@workspace/db';
import {authorizeOwnerShaRelease,OWNER_SHA_RELEASE_CONFIRM,ownerRestoreStatus} from './ownerShaRelease';
import {checkContinuousBootstrap,hasContinuousGrantHistory,enrollContinuousGrant,CONTINUOUS_OWNER_CONFIRM} from './continuousExecutionAuthorization';
import {digest} from '../v13-production/types';
const url=process.env.V13_RESTORE_DISPOSABLE_URL;
if(!url||url!==process.env.DATABASE_URL)throw Error('explicit_disposable_restore_database_required');
const destination=new URL(url);
if(destination.hostname!=='127.0.0.1'||!/^\/restore_disposable_\d+$/.test(destination.pathname))throw Error('disposable_restore_destination_required');
const owner='11111111-1111-4111-8111-111111111111',reviewer='22222222-2222-4222-8222-222222222222';
const approval='33333333-3333-4333-8333-333333333333',qualification='44444444-4444-4444-8444-444444444444';
const review='55555555-5555-4555-8555-555555555555',grant='66666666-6666-4666-8666-666666666666';
const sha='a'.repeat(40),hash='b'.repeat(64),fingerprint='f'.repeat(64);
const body={restoreExistingApproval:true,expectedSha:sha,expectedAccountId:'a',expectedPolicyId:'p',expectedPolicyHash:hash,
 qualificationId:qualification,confirmation:OWNER_SHA_RELEASE_CONFIRM};
const readFeeds=async(_material:unknown,observedAtMs:number)=>({ok:true as const,observedAtMs,historicalCoverageComplete:true,
 cashMicros:'25000000',orders:[],fills:[],positions:[],settlements:[]});
const restore=()=>authorizeOwnerShaRelease(owner,body,{db,sha:()=>sha,readFeeds:readFeeds as never});
const reset=async()=>{await db.query(`DELETE FROM private.strata_continuous_execution_grants WHERE grant_id<>'${grant}';
 UPDATE public.v13_production_account SET execution_enabled=false,kill_switch=true,blocked_reason=NULL;
 UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL;
 UPDATE private.strata_standing_execution_reviews SET revoked_at=NULL;
 UPDATE private.strata_continuous_execution_grants SET revoked_at=NULL;
 UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=false;
 UPDATE public.live_execution_config SET live_execution_enabled=true,manual_kill_switch=false;
 DELETE FROM public.v13_production_position;DELETE FROM public.v13_production_intent;
 DELETE FROM private.strata_emergency_exit_reservations;
 UPDATE private.strata_protective_release_qualification SET observed_at=now(),expires_at=now()+interval '15 minutes';`);};
test('real disposable PostgreSQL owner restore preserves exact authority and closed gates',async t=>{
 try{
 await db.query(`CREATE SCHEMA private;CREATE SCHEMA vault;
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,
 policy_id text,kalshi_connection_id text,key_fingerprint text,blocked_reason text,commissioned boolean,cash_precision_verified boolean,
 reserved_micros bigint,cash_micros bigint,revision bigint,execution_enabled boolean,kill_switch boolean,
 reconciled_at timestamptz,minimum_exit_micros bigint,commissioning_digest text,fee_artifact_digest text);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,created_by text,state text,policy_hash text,
 fee_source_url text,fee_policy_version text,fee_formula_version text,approved_at timestamptz,max_entry_stake_cents int,max_entry_all_in_cents int);
 CREATE TABLE public.strata_configured_stake(execution_account_id text,configured_stake_cents int);
 CREATE TABLE public.live_execution_config(id text,mode text,live_execution_enabled boolean,manual_kill_switch boolean);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean,credential_fingerprint text);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id text,role text,revoked_at timestamptz,
 verified_at timestamptz,verification_reason text,key_fingerprint text,vault_secret_id text);
 CREATE TABLE vault.decrypted_secrets(id text,decrypted_secret text);
 CREATE TABLE public.v13_production_intent(id text,account_id text,created_at timestamptz,request jsonb,state text,terminal boolean,reserved_micros bigint,kind text);
 CREATE TABLE public.v13_production_position(account_id text,quantity_hundredths bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE public.v13_production_observation(id text,account_id text,kind text,payload jsonb,digest text,observed_at timestamptz DEFAULT now());
 CREATE TABLE private.strata_protective_release_qualification(qualification_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text,evidence_digest text,observed_at timestamptz,expires_at timestamptz);
 CREATE TABLE private.strata_owner_sha_approvals(approval_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text,revoked_at timestamptz);
 CREATE TABLE private.strata_standing_execution_reviews(release_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text,policy_hash text,independent_reviewer_id uuid,state text,revoked_at timestamptz,created_at timestamptz);
 CREATE TABLE private.strata_continuous_execution_grants(grant_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text,policy_hash text,independent_reviewer_id uuid,reviewed_release_id uuid,revoked_at timestamptz,owner_confirmation text);
 CREATE TABLE private.strata_continuous_execution_audit(grant_id uuid,execution_account_id text,kind text,reason text);
 INSERT INTO public.v13_production_account VALUES('a','${owner}',1,2,'p','connection','${fingerprint}',NULL,true,true,0,25000000,1,false,true,now(),10000,'${hash}','${hash}');
 INSERT INTO public.v13_live_money_policy VALUES('p','a','${owner}','APPROVED','${hash}',NULL,NULL,NULL,now(),2500,2500);
 INSERT INTO public.strata_configured_stake VALUES('a',500);
 INSERT INTO public.live_execution_config VALUES('singleton','V13_PRODUCTION',true,false);
 INSERT INTO private.kalshi_account_worker_lease VALUES('a','${owner}','released',false,'${fingerprint}');
 INSERT INTO private.kalshi_connection_credentials VALUES('${owner}','connection','restricted_execution',NULL,now(),'credential_verified','${fingerprint}','secret');
 INSERT INTO vault.decrypted_secrets VALUES('secret','{"api_key_id":"offline-only","private_key":"offline-only"}');
 INSERT INTO private.strata_owner_sha_approvals VALUES('${approval}','${owner}','a','${sha}',NULL);
 INSERT INTO private.strata_standing_execution_reviews VALUES('${review}','${owner}','a','${sha}','${hash}','${reviewer}','approved',NULL,now());
 INSERT INTO private.strata_continuous_execution_grants VALUES('${grant}','${owner}','a','${sha}','${hash}','${reviewer}','${review}',NULL,NULL);
 INSERT INTO private.strata_protective_release_qualification VALUES('${qualification}','${owner}','a','${sha}','${hash}',now(),now()+interval '15 minutes');`);
 await db.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,digest) VALUES('activation','a','OWNER_ACTIVATION_REQUEST',$1)`,[
 digest({accountId:'a',policyId:'p',feeDigest:hash,stakeCents:500,commissioningDigest:hash,minimumExitMicros:10000})]);
 await t.test('valid restore preserves IDs; worker remains released; bootstrap only becomes eligible',async()=>{
  assert.equal((await ownerRestoreStatus(owner,sha,db)).available,true);
  const result=await restore();assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal('approvalId' in result?result.approvalId:null,approval);
  assert.deepEqual((await db.query('SELECT execution_enabled,kill_switch FROM public.v13_production_account')).rows,[{execution_enabled:true,kill_switch:false}]);
  assert.deepEqual((await db.query('SELECT grant_id,reviewed_release_id FROM private.strata_continuous_execution_grants')).rows,[{grant_id:grant,reviewed_release_id:review}]);
  assert.equal((await db.query('SELECT count(*)::int n FROM private.strata_owner_sha_approvals')).rows[0].n,1);
  assert.equal(await hasContinuousGrantHistory(db,owner,sha),true);assert.equal(await checkContinuousBootstrap(db,owner,sha),true);
  assert.equal((await db.query('SELECT state FROM private.kalshi_account_worker_lease')).rows[0].state,'released');
 });
 for(const [name,change] of [
  ['revoked review',"UPDATE private.strata_standing_execution_reviews SET revoked_at=now()"],
  ['revoked owner approval',"UPDATE private.strata_owner_sha_approvals SET revoked_at=now()"],
  ['worker running',"UPDATE private.kalshi_account_worker_lease SET state='owned'"],
  ['worker armed',"UPDATE private.kalshi_account_worker_lease SET arm_requested=true"],
  ['open position',"INSERT INTO public.v13_production_position VALUES('a',1)"],
  ['unknown exit',"INSERT INTO private.strata_emergency_exit_reservations VALUES('a','UNKNOWN')"],
  ['freeze',"UPDATE public.v13_production_account SET blocked_reason='risk_freeze'"],
  ['stale qualification',"UPDATE private.strata_protective_release_qualification SET observed_at=now()-interval '61 seconds'"],
 ] as const)await t.test(name+' remains fail closed',async()=>{
  await reset();await db.query(change);assert.equal((await restore()).ok,false);
  assert.deepEqual((await db.query('SELECT execution_enabled,kill_switch FROM public.v13_production_account')).rows,[{execution_enabled:false,kill_switch:true}]);
  assert.equal(await checkContinuousBootstrap(db,owner,sha),false);
  assert.equal((await db.query('SELECT count(*)::int n FROM private.strata_owner_sha_approvals')).rows[0].n,1);
 });
 await t.test('revoked grant remains revoked after readiness restore; START still blocked',async()=>{
  await reset();await db.query('UPDATE private.strata_continuous_execution_grants SET revoked_at=now()');
  const before=(await db.query('SELECT * FROM private.strata_continuous_execution_grants')).rows;
  const result=await restore();assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual((await db.query('SELECT * FROM private.strata_continuous_execution_grants')).rows,before);
  assert.equal(await hasContinuousGrantHistory(db,owner,sha),true);
  assert.equal(await checkContinuousBootstrap(db,owner,sha),false);
  assert.deepEqual((await db.query('SELECT execution_enabled,kill_switch FROM public.v13_production_account')).rows,[{execution_enabled:true,kill_switch:false}]);
  const enrolled=await enrollContinuousGrant(owner,{expectedSha:sha,accountId:'a',policyHash:hash,confirmation:CONTINUOUS_OWNER_CONFIRM},{db,sha:()=>sha});
  assert.equal(enrolled.ok,true,JSON.stringify(enrolled));
  assert.equal(await checkContinuousBootstrap(db,owner,sha),true);
  assert.deepEqual((await db.query('SELECT * FROM private.strata_continuous_execution_grants WHERE grant_id=$1',[grant])).rows,before);
 });
 await t.test('global manual kill stays on',async()=>{
  await reset();await db.query('UPDATE public.live_execution_config SET live_execution_enabled=false,manual_kill_switch=true');
  const result=await restore();assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual((await db.query('SELECT execution_enabled,kill_switch FROM public.v13_production_account')).rows,[{execution_enabled:true,kill_switch:true}]);
  assert.equal(await checkContinuousBootstrap(db,owner,sha),false);
 });
 }finally{await db.end();}
});
