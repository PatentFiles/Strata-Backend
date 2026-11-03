import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {verifyReviewedProtectiveExitFeeAuthority} from './reviewedProtectiveExitFee';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from './apiFeeRateReference';
const owner='11111111-1111-4111-8111-111111111111',admin='22222222-2222-4222-8222-222222222222';
const grant='33333333-3333-4333-8333-333333333333',model='44444444-4444-4444-8444-444444444444';
const review='55555555-5555-4555-8555-555555555555',consent='66666666-6666-4666-8666-666666666666';
const delegation='77777777-7777-4777-8777-777777777777',exit='88888888-8888-4888-8888-888888888888';
const sha='a'.repeat(40),policy='b'.repeat(64),account='protective-test';
test('actual read-only protective authority SQL: legacy, successor, negatives and revocation locks',async()=>{
 const url=new URL(process.env.DATABASE_URL!);
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(process.env.NODE_ENV,'test');
 assert.match(url.pathname,/disposable/);
 const db=await pool.connect();
 try{
 await db.query(`CREATE SCHEMA IF NOT EXISTS private; CREATE SCHEMA IF NOT EXISTS auth;
 CREATE TABLE auth.users(id uuid,email text,email_confirmed_at timestamptz);
 CREATE TABLE private.role_assignments(email text,role text);
 CREATE TABLE public.profiles(id uuid,role text);
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,policy_id text,subaccount int,exchange_index int,commissioned boolean,execution_enabled boolean,kill_switch boolean);
 CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text,approved_at timestamptz,fee_policy_version text,fee_formula_version text,fee_source_url text);
 CREATE TABLE private.strata_api_fee_source_grants(grant_id uuid,owner_user_id uuid,issuer_admin_id uuid,rate_decision_digest text,fee_model_version text,scope text,policy_version text,confirmation text,issued_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_rate_reviews(review_id uuid,owner_user_id uuid,reviewer_user_id uuid,rate_decision_digest text,fee_model_version text,scope text,confirmation text,signed_at timestamptz,expires_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_owner_consents(consent_id uuid,owner_user_id uuid,grant_id uuid,confirmation text,confirmed_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_standing_models(model_id uuid,reviewer_admin_id uuid,rate_decision_digest text,fee_model_version text,scope text,release_commit_sha text,signed_at timestamptz,valid_until timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_standing_delegations(delegation_id uuid,owner_user_id uuid,model_id uuid,grant_id uuid,policy_hash text,release_commit_sha text,confirmation text,granted_at timestamptz,valid_until timestamptz,lease_expires_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_standing_execution_reviews(release_id uuid,owner_user_id uuid,execution_account_id text,policy_hash text,release_commit_sha text,independent_reviewer_id uuid,state text,confirmation text,created_at timestamptz,revoked_at timestamptz);`);
 const before=new Date(Date.now()-3600_000).toISOString(),prior=new Date(Date.now()-7200_000).toISOString(),future=new Date(Date.now()+3600_000).toISOString();
 const insert=async(table:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);await db.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));};
 await insert('auth.users',{id:admin,email:'admin@test.invalid',email_confirmed_at:before});
 await insert('private.role_assignments',{email:'admin@test.invalid',role:'ADMIN'});
 await insert('public.profiles',{id:admin,role:'ADMIN'});
 await insert('public.v13_production_account',{id:account,owner_user_id:owner,policy_id:'p',subaccount:1,exchange_index:2,commissioned:true,execution_enabled:true,kill_switch:false});
 await insert('public.v13_live_money_policy',{id:'p',execution_account_id:account,policy_hash:policy,state:'APPROVED',approved_at:before,fee_policy_version:API_SOURCE_POLICY_VERSION,fee_formula_version:API_SOURCE_FORMULA_VERSION,fee_source_url:'strata-api-reviewed://kxbtc15m/'+grant});
 await insert('private.strata_api_fee_source_grants',{grant_id:grant,owner_user_id:owner,issuer_admin_id:admin,rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:'KXBTC15M:INDEX2',policy_version:API_SOURCE_POLICY_VERSION,confirmation:'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',issued_at:before});
 await insert('private.strata_api_fee_rate_reviews',{review_id:review,owner_user_id:owner,reviewer_user_id:admin,rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:'KXBTC15M:INDEX2',confirmation:'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',signed_at:prior,expires_at:future});
 await insert('private.strata_api_fee_owner_consents',{consent_id:consent,owner_user_id:owner,grant_id:grant,confirmation:'CONFIRM_REVIEWED_API_FEE_SOURCE_V1',confirmed_at:before});
 const check=()=>verifyReviewedProtectiveExitFeeAuthority(owner,account,sha,db);
 assert.equal((await check()).proofKind,'legacy');
 await db.query(`UPDATE private.strata_api_fee_rate_reviews SET expires_at=now()-interval '1 second'`);
 assert.equal((await check()).ok,false);
 await insert('private.strata_api_fee_standing_models',{model_id:model,reviewer_admin_id:admin,rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:'KXBTC15M:INDEX2',release_commit_sha:sha,signed_at:before,valid_until:future});
 await insert('private.strata_api_fee_standing_delegations',{delegation_id:delegation,owner_user_id:owner,model_id:model,grant_id:grant,policy_hash:policy,release_commit_sha:sha,confirmation:'I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1',granted_at:before,valid_until:future,lease_expires_at:prior});
 assert.equal((await check()).ok,false,'monetary consent alone is not exit review');
 await insert('private.strata_standing_execution_reviews',{release_id:exit,owner_user_id:owner,execution_account_id:account,policy_hash:policy,release_commit_sha:sha,independent_reviewer_id:admin,state:'approved',confirmation:'I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1',created_at:before});
 const original=await check();assert.equal(original.ok,true);assert.equal(original.proofKind,'standing_successor');
 const negatives=[
 ['private.strata_api_fee_source_grants','revoked_at=now()'],
 ['private.strata_api_fee_source_grants',"scope='OTHER'"],
 ['private.strata_api_fee_source_grants',"policy_version='OTHER'"],
 ['private.strata_api_fee_source_grants',"rate_decision_digest='OTHER'"],
 ['private.strata_api_fee_source_grants',"fee_model_version='OTHER'"],
 ['private.strata_api_fee_source_grants',`issuer_admin_id='${owner}'`],
 ['private.strata_api_fee_owner_consents',"confirmation='OTHER'"],
 ['private.strata_api_fee_owner_consents',`owner_user_id='${admin}'`],
 ['private.strata_api_fee_owner_consents',"confirmed_at=now()+interval '1 day'"],
 ['private.strata_api_fee_rate_reviews',`reviewer_user_id='${owner}'`],
 ['private.strata_api_fee_rate_reviews',"confirmation='OTHER'"],
 ['private.strata_api_fee_owner_consents','revoked_at=now()'],
 ['private.strata_api_fee_rate_reviews','revoked_at=now()'],
 ['private.strata_api_fee_rate_reviews',"signed_at=now()+interval '1 day'"],
 ['private.strata_api_fee_rate_reviews',"scope='OTHER'"],
 ['private.strata_api_fee_standing_models','revoked_at=now()'],
 ['private.strata_api_fee_standing_models',"valid_until=now()-interval '1 second'"],
 ['private.strata_api_fee_standing_models',`reviewer_admin_id='${owner}'`],
 ['private.strata_api_fee_standing_models',"scope='OTHER'"],
 ['private.strata_api_fee_standing_models',"fee_model_version='OTHER'"],
 ['private.strata_api_fee_standing_models',"rate_decision_digest='OTHER'"],
 ['private.strata_api_fee_standing_models',"release_commit_sha='OTHER'"],
 ['private.strata_api_fee_standing_models',"signed_at=now()+interval '1 day'"],
 ['private.strata_api_fee_standing_delegations','revoked_at=now()'],
 ['private.strata_api_fee_standing_delegations',"valid_until=now()-interval '1 second'"],
 ['private.strata_api_fee_standing_delegations',"granted_at=now()+interval '1 day'"],
 ['private.strata_api_fee_standing_delegations',"confirmation='OTHER'"],
 ['private.strata_api_fee_standing_delegations',"policy_hash='OTHER'"],
 ['private.strata_api_fee_standing_delegations',"release_commit_sha='OTHER'"],
 ['private.strata_api_fee_standing_delegations',`owner_user_id='${admin}'`],
 ['private.strata_standing_execution_reviews','revoked_at=now()'],
 ['private.strata_standing_execution_reviews',"confirmation='OTHER'"],
 ['private.strata_standing_execution_reviews',"state='OTHER'"],
 ['private.strata_standing_execution_reviews',"created_at=now()+interval '1 day'"],
 ['private.strata_standing_execution_reviews',"policy_hash='OTHER'"],
 ['private.strata_standing_execution_reviews',`independent_reviewer_id='${owner}'`],
 ['private.role_assignments',"role='USER'"],['public.profiles',"role='USER'"],
 ['auth.users','email_confirmed_at=NULL'],['public.v13_production_account','kill_switch=true'],
 ];
 for(const [table,change] of negatives){
  await db.query('BEGIN');await db.query(`UPDATE ${table} SET ${change}`);
  assert.equal((await check()).ok,false,table+' '+change);await db.query('ROLLBACK');
 }
 for(const table of ['private.strata_api_fee_standing_models','private.strata_api_fee_standing_delegations','private.strata_standing_execution_reviews','private.strata_api_fee_owner_consents']){
  await db.query('BEGIN');await db.query(`INSERT INTO ${table} SELECT * FROM ${table}`);
  // Duplicate consent has the same UUID in this intentionally constraint-free adversarial fixture.
  assert.equal((await check()).ok,false,'duplicate '+table);
  await db.query('ROLLBACK');
 }
 // Multiple original reviews are lineage evidence, not duplicate successor authorization.
 await db.query('BEGIN');await db.query(`INSERT INTO private.strata_api_fee_rate_reviews SELECT * FROM private.strata_api_fee_rate_reviews`);await db.query(`UPDATE private.strata_api_fee_rate_reviews SET review_id=gen_random_uuid()`);
 assert.equal((await check()).ok,true);await db.query('ROLLBACK');
 // Revoked history latches standing mode even if the original review is current.
 await db.query('BEGIN');await db.query('UPDATE private.strata_api_fee_rate_reviews SET expires_at=now()+interval \'1 hour\'');
 await db.query('UPDATE private.strata_api_fee_standing_delegations SET revoked_at=now()');
 assert.equal((await check()).ok,false);await db.query('ROLLBACK');
 // A separately authorized replacement can coexist with revoked historic rows.
 await db.query('BEGIN');await db.query(`INSERT INTO private.strata_api_fee_standing_delegations SELECT * FROM private.strata_api_fee_standing_delegations`);
 await db.query(`UPDATE private.strata_api_fee_standing_delegations SET revoked_at=now() WHERE ctid=(SELECT ctid FROM private.strata_api_fee_standing_delegations LIMIT 1)`);
 assert.equal((await check()).ok,true);await db.query('ROLLBACK');
 // No lease mutation: an expired observation lease is not borrowed or renewed.
 const lease=await db.query('SELECT lease_expires_at FROM private.strata_api_fee_standing_delegations');assert.equal(new Date(lease.rows[0].lease_expires_at).toISOString(),prior);
 // Transaction-held monetary authority blocks concurrent revocation until the fence commits.
 await db.query('BEGIN');assert.equal((await check()).ok,true);
 const other=await pool.connect();
 try{for(const table of ['private.strata_api_fee_standing_models','private.strata_api_fee_standing_delegations','private.strata_standing_execution_reviews','private.strata_api_fee_source_grants','private.strata_api_fee_rate_reviews','private.strata_api_fee_owner_consents']){
  await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'");
  await assert.rejects(other.query(`UPDATE ${table} SET revoked_at=now()`),/lock timeout/,table);
  await other.query('ROLLBACK');
 }}finally{other.release();await db.query('ROLLBACK');}
 console.log(`Protective authority matrix: ${negatives.length} negative mutations, duplicate/history/replacement/lineage and six authority row-lock checks passed.`);
 }finally{db.release();await pool.end();}
});
