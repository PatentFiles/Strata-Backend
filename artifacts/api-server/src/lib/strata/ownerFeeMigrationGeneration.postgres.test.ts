import {migrateOwnedApiFeePolicy,OWNER_API_FEE_MIGRATION_CONFIRM} from './ownerApiFeePolicyMigration';
import {migrateOwnedV3FeePolicy,OWNER_V3_POLICY_MIGRATION_CONFIRM} from './ownerFeeV3Migration';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from './ownerFeeV3Authority';
import {TEST_TWENTY_PERCENT_PRESET_ID,TEST_TWENTY_PERCENT_PRESET} from './sharedPresets';
import {advanceOwnerConsent,readConsentGeneration} from './ownerConsentGeneration';
import {disabledKilledApprovalStatus,disabledStoppedApprovalStatus} from './ownerNeverPostedReleaseRenewal';
import {ownerRenewalFailureDiagnostics} from './ownerRenewalFailureDiagnostics';
// Keep the new proof-unit matrix on the existing credential-fenced PG16/17
// renewal CI path, without requiring a separate unconfigured workflow.

import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
import {getTableColumns} from 'drizzle-orm';import {v13ProductionEventTable} from '@workspace/db';
import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {pool as db} from '@workspace/db';import {digest} from '../v13-production/types';
import {authorizeOwnerShaRelease,revokeOwnerShaRelease,OWNER_SHA_REVOKE_CONFIRM,OWNER_SHA_RELEASE_CONFIRM} from './ownerShaRelease';
import {inspectOwnerSignedExchangeReleaseProof} from './ownerSignedExchangeReleaseProof';
import {dedicatedSignerFingerprint} from './commissioning';
import {qualifyProtectiveRelease} from './inAppProtectiveRelease';
import {personalAccountSnapshot} from './personalExchangeRead';
import {migrationFlatHistoryCheck} from './ownerApiFeePolicyMigration';
import {ProductionLedger} from '../v13-production/ledger';
import {approvedFromRow} from './ownerStakePolicyAmendment';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {STANDING_REVIEW_CONFIRM} from './standingExecutionReview';
import {createHash} from 'node:crypto';
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
async function fixtureChange(sql:string){
 if(/UPDATE private\.strata_owner_sha_approvals SET revoked_at=now\(\)/.test(sql)){
  const c=await db.connect();try{await c.query('BEGIN');await c.query("SELECT id FROM public.v13_production_account WHERE id='a' FOR UPDATE");await advanceOwnerConsent(c,owner,'a','test_prior_revocation');await c.query(sql);await c.query('COMMIT');}finally{c.release();}
 }else await db.query(sql);
}
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
 INSERT INTO public.v13_production_account VALUES('a','${owner}',1,2,'12121212-1212-4212-8212-121212121212','${financial}','${fingerprint}',NULL,true,true,0,25000000,1,true,false,now(),10000,'${hash}','${hash}');
 INSERT INTO public.v13_live_money_policy VALUES('12121212-1212-4212-8212-121212121212','a','${owner}','APPROVED','${hash}',NULL,NULL,NULL,now(),500,625);
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
 digest({accountId:'a',policyId:'12121212-1212-4212-8212-121212121212',feeDigest:hash,stakeCents:500,commissioningDigest:hash,minimumExitMicros:10000})]);
}
async function reset(){await db.query('DELETE FROM private.strata_owner_consent_bindings;DELETE FROM private.strata_owner_consent_heads');beforeRead=async()=>{};afterRead=async()=>{};extraFeeds={};clock=()=>Date.now();
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
 review:(await db.query('SELECT * FROM private.strata_standing_execution_reviews')).rows,
 events:(await db.query('SELECT * FROM public.v13_production_event ORDER BY event_id')).rows,
 positions:(await db.query('SELECT * FROM public.v13_production_position ORDER BY id')).rows,
 markers:(await db.query('SELECT * FROM private.strata_emergency_exit_reservations ORDER BY execution_account_id,state')).rows,
 observations:(await db.query("SELECT * FROM public.v13_production_observation WHERE kind<>'OWNER_SHA_RELEASE_AUTHORIZATION' ORDER BY id")).rows});
const policyId='12121212-1212-4212-8212-121212121212',authority='34343434-3434-4434-8434-343434343434',attestation='56565656-5656-4565-8565-565656565656';
test('actual fee migration SQL workflow preserves consent generation',async t=>{try{
 await setup();await db.query(readFileSync(resolve(process.cwd(),'consent-generation.sql'),'utf8'));
 await db.query(`ALTER TABLE public.v13_live_money_policy ADD COLUMN version int DEFAULT1,ADD COLUMN supersedes_policy_id text,
 ADD COLUMN strategy_version text DEFAULT 'V1.3',ADD COLUMN strategy_parameter_set_id text DEFAULT 'synthetic',ADD COLUMN strategy_parameter_hash text DEFAULT repeat('d',64),
 ADD COLUMN entry_policy_version text,ADD COLUMN champion_selection_review_id text,ADD COLUMN champion_selection_evidence_hash text,ADD COLUMN champion_selected_by text,ADD COLUMN champion_selected_at timestamptz,
 ADD COLUMN capital_limit_cents int DEFAULT2500,ADD COLUMN max_open_positions int DEFAULT1,ADD COLUMN max_daily_loss_cents int DEFAULT500,ADD COLUMN max_total_loss_cents int DEFAULT1500,
 ADD COLUMN max_quote_age_ms int DEFAULT5000,ADD COLUMN max_fee_evidence_age_ms int DEFAULT15000,ADD COLUMN require_full_depth boolean DEFAULTtrue,
 ADD COLUMN entry_time_in_force text DEFAULT 'IOC',ADD COLUMN entry_limit_source text DEFAULT 'SIGNAL_REFERENCE_OFFER',ADD COLUMN approved_by text;
 ALTER TABLE public.strata_configured_stake ADD COLUMN risk_preset_id text,ADD COLUMN risk_capital_cents int,ADD COLUMN risk_preset_revision int;
 UPDATE public.v13_production_account SET execution_enabled=false,kill_switch=true;
 UPDATE public.v13_live_money_policy SET fee_policy_version='micro-live-standing-fee-policy-v1',fee_source_url='https://kalshi.com/docs/kalshi-fee-schedule.pdf',fee_formula_version='standard_quadratic_v1',approved_by=created_by;
 CREATE TABLE private.strata_api_fee_source_grants(grant_id uuid,owner_user_id uuid,policy_version text,scope text,revoked_at timestamptz,expires_at timestamptz,issuer_admin_id uuid,rate_decision_digest text,authorized_stages text[]);
 CREATE TABLE private.strata_api_fee_owner_consents(grant_id uuid,owner_user_id uuid,revoked_at timestamptz,confirmation text);
 CREATE TABLE private.strata_api_fee_rate_reviews(owner_user_id uuid,reviewer_user_id uuid,rate_decision_digest text,revoked_at timestamptz,expires_at timestamptz);
 CREATE TABLE private.strata_owner_fee_authority_v3(authority_id uuid,owner_user_id uuid,execution_account_id text,attestation_id uuid,release_commit_sha text,official_source_digest text,policy_version text,formula_version text,scope text,official_source_url text,revoked_at timestamptz,expires_at timestamptz,authorized_stages text[]);
 CREATE TABLE private.strata_owner_fee_evidence_v3(attestation_id uuid,owner_user_id uuid,execution_account_id text,source_digest text,release_commit_sha text,revoked_at timestamptz,expires_at timestamptz);` .replace(/DEFAULT(?=\d|true)/g,'DEFAULT '));
 await db.query('UPDATE public.strata_configured_stake SET risk_preset_id=$1,risk_capital_cents=2500,risk_preset_revision=$2',[TEST_TWENTY_PERCENT_PRESET_ID,TEST_TWENTY_PERCENT_PRESET.revision]);
 await db.query(`INSERT INTO private.strata_api_fee_source_grants VALUES($1,$2,$3,'KXBTC15M:INDEX2',NULL,now()+interval '1 hour',$4,$5,ARRAY['STEP_9','STEP_11','ORDER_ENTRY']);`,[authority,owner,API_SOURCE_POLICY_VERSION,reviewer,hash]);
 await db.query(`INSERT INTO private.strata_api_fee_owner_consents VALUES('${authority}','${owner}',NULL,'CONFIRM_REVIEWED_API_FEE_SOURCE_V1');INSERT INTO private.strata_api_fee_rate_reviews VALUES('${owner}','${reviewer}','${hash}',NULL,now()+interval '1 hour');`);
 await db.query(`INSERT INTO private.strata_owner_fee_authority_v3 VALUES($1,$2,'a',$3,$4,$5,$6,$7,'KXBTC15M:INDEX2:SUBACCOUNT1','https://kalshi.com/docs/kalshi-fee-schedule.pdf',NULL,now()+interval '1 hour',ARRAY['STEP_9','STEP_11','ORDER_ENTRY'])`,[authority,owner,attestation,sha,hash,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION]);
 await db.query(`INSERT INTO private.strata_owner_fee_evidence_v3 VALUES($1,$2,'a',$3,$4,NULL,now()+interval '1 hour')`,[attestation,owner,hash,sha]);
 const parsed=approvedFromRow((await db.query('SELECT * FROM public.v13_live_money_policy')).rows[0])!;const pHash=computeV13LiveMoneyPolicyHash(parsed);await db.query('UPDATE public.v13_live_money_policy SET policy_hash=$1',[pHash]);
 const initialAccount=(await db.query('SELECT * FROM public.v13_production_account')).rows[0],initialPolicy=(await db.query('SELECT * FROM public.v13_live_money_policy')).rows[0];
 const controls=()=>db.query('SELECT execution_enabled,kill_switch FROM public.v13_production_account');
 const restore=async()=>{await db.query('UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL');for(const [table,row] of [['public.v13_production_account',initialAccount],['public.v13_live_money_policy',initialPolicy]] as const){const cols=Object.keys(row).filter(k=>k!=='id');await db.query(`UPDATE ${table} SET ${cols.map((c,i)=>c+'=$'+(i+1)).join(',')} WHERE id=$${cols.length+1}`,[...cols.map(c=>row[c]),row.id]);}await db.query('DELETE FROM public.v13_live_money_policy WHERE id<>$1',[policyId]);};
 const source='strata-owner-fee-v3://kxbtc15m/'+authority;
 const apiIdentity={grantId:authority,sourceUrl:'strata-api-reviewed://kxbtc15m/'+authority,digest:hash,feePolicyVersion:API_SOURCE_POLICY_VERSION,formulaVersion:API_SOURCE_FORMULA_VERSION,marketTicker:'KXBTC15M-TEST',verifiedAtMs:Date.now()};
 const v3Identity={authorityId:authority,sourceUrl:source,sourceDigest:hash,releaseCommitSha:sha,feePolicyVersion:V3_FEE_POLICY_VERSION,formulaVersion:V3_FEE_FORMULA_VERSION,marketTicker:'KXBTC15M-TEST',verifiedAtMs:Date.now()};
 for(const mode of ['api','v3'] as const){await t.test(mode+' full migration with actual SQL and consent triggers',async()=>{
  await restore();const invoke=(dbArg:unknown=db)=>mode==='api'?migrateOwnedApiFeePolicy(owner,{confirmation:OWNER_API_FEE_MIGRATION_CONFIRM,expectedPolicyId:policyId,expectedPolicyHash:pHash,expectedPolicyVersion:1},{db:dbArg as never,read:feeds as never,verify:async()=>({ok:true,identity:apiIdentity}) as never}):migrateOwnedV3FeePolicy(owner,{confirmation:OWNER_V3_POLICY_MIGRATION_CONFIRM,expectedPolicyId:policyId,expectedPolicyHash:pHash,expectedPolicyVersion:1,expectedV3SourceUrl:source},{db:dbArg as never,enabled:()=>true,read:feeds as never,verify:async()=>({ok:true,identity:v3Identity}) as never});
  const authorityTable=mode==='api'?'private.strata_api_fee_source_grants':'private.strata_owner_fee_authority_v3';
  await db.query(`UPDATE ${authorityTable} SET expires_at=clock_timestamp()`);
  const expired=await invoke();assert.equal(expired.ok,false);assert.equal(expired.reason,mode==='api'?'reviewed_fee_source_grant_expired_or_revoked':'v3_fee_authority_expired_revoked_or_changed');
  await db.query(`UPDATE ${authorityTable} SET expires_at=clock_timestamp()+interval '1 hour'`);
  const before=await readConsentGeneration(db,owner,'a');const originalPolicy=(await db.query('SELECT policy_id,revision FROM public.v13_production_account')).rows;
  const failureDb={connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(sql:string,p?:unknown[])=>{if(sql.includes("'OWNER_CODE_CONSENT_REVOKED'"))throw Error('synthetic_audit_failure');return c.query(sql,p);}};}};
  const failed=await invoke(failureDb);assert.equal(failed.ok,false,JSON.stringify(failed));assert.equal(failed.reason,'fee_migration_transaction_failed');assert.equal(await readConsentGeneration(db,owner,'a'),before);assert.deepEqual((await db.query('SELECT policy_id,revision FROM public.v13_production_account')).rows,originalPolicy);
  const passed=await invoke();assert.equal(passed.ok,true,JSON.stringify(passed));assert.equal(passed.tradingAuthorized,false);assert.equal(BigInt(await readConsentGeneration(db,owner,'a')),BigInt(before)+1n);
  assert.equal((await db.query('SELECT revoked_at IS NOT NULL yes FROM private.strata_owner_sha_approvals WHERE approval_id=$1',[oldApproval])).rows[0].yes,true);
  assert.deepEqual((await controls()).rows,[{execution_enabled:false,kill_switch:true}]);
  assert.deepEqual((await db.query('SELECT cash_micros::text,reserved_micros::text FROM public.v13_production_account')).rows,[{cash_micros:'25000000',reserved_micros:'0'}]);
  await assert.rejects(db.query(`INSERT INTO private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest) VALUES($1,'a',$2,$3,$4)`,[owner,sha,qualification,hash]),/owner_renewal_fresh_consent_binding_required/);

  assert.equal((await db.query('SELECT state,arm_requested,account_kill FROM private.kalshi_account_worker_lease')).rows[0].state,'released');
  assert.equal((await db.query('SELECT state FROM public.v13_live_money_policy WHERE id=$1',[policyId])).rows[0].state,'REVOKED');
 });}
 // No active approval: each migration still advances generation and commits audit.
 await db.query('DELETE FROM private.strata_owner_sha_approvals');
 for(const mode of ['api','v3'] as const){await restore();const before=await readConsentGeneration(db,owner,'a');
 const result=mode==='api'?await migrateOwnedApiFeePolicy(owner,{confirmation:OWNER_API_FEE_MIGRATION_CONFIRM,expectedPolicyId:policyId,expectedPolicyHash:pHash,expectedPolicyVersion:1},{db:db as never,read:feeds as never,verify:async()=>({ok:true,identity:apiIdentity}) as never}):await migrateOwnedV3FeePolicy(owner,{confirmation:OWNER_V3_POLICY_MIGRATION_CONFIRM,expectedPolicyId:policyId,expectedPolicyHash:pHash,expectedPolicyVersion:1,expectedV3SourceUrl:source},{db:db as never,enabled:()=>true,read:feeds as never,verify:async()=>({ok:true,identity:v3Identity}) as never});
 assert.equal(result.ok,true,JSON.stringify({mode,result}));assert.equal(BigInt(await readConsentGeneration(db,owner,'a')),BigInt(before)+1n);assert.equal((await db.query('SELECT count(*)::int n FROM private.strata_owner_sha_approvals')).rows[0].n,0);
 }
}finally{await db.end();}});
