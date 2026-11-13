import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool as db} from '@workspace/db';
import {renewStandingFeeObservationLease} from './apiFeeStandingDelegation';
import {READ_API_FEE_STAGE_SQL} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 as RATE,PDF_FREE_RATE_REVIEW_VECTOR_VERSION as VERSION} from './apiFeeRateReference';
if(process.env.DATABASE_URL!=='postgresql://agent@127.0.0.1:55474/legacy_fee_locks_disposable')throw Error('disposable_only');
const owner='11111111-1111-4111-8111-111111111111',issuer='22222222-2222-4222-8222-222222222222',reviewer='33333333-3333-4333-8333-333333333333',grant='44444444-4444-4444-8444-444444444444',model='55555555-5555-4555-8555-555555555555',sha='a'.repeat(40),policy='b'.repeat(64);
type Client={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;release():void};
(async()=>{try{
// Only account/auth scaffolding is minimal. All fee tables and constraints are
// installed from the exact existing migrations, without owner-self schema.
await db.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA private;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
CREATE TABLE private.role_assignments(email text,role text);
CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text,subaccount int,exchange_index int);
CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,state text,policy_hash text,fee_source_url text);`);
for(const file of ['0030_strata_api_fee_rate_source_v1.sql','0034_strata_standing_api_fee_delegation.sql','0042_standing_fee_delegation_sha_rotation.sql'])await db.query(readFileSync(process.env.LEGACY_FEE_SOURCE_ROOT+'/lib/db/drizzle/'+file,'utf8'));
await db.query(`INSERT INTO auth.users VALUES('${owner}','owner@example.invalid',now()),('${issuer}','issuer@example.invalid',now()),('${reviewer}','reviewer@example.invalid',now());
INSERT INTO private.role_assignments VALUES('issuer@example.invalid','ADMIN'),('reviewer@example.invalid','ADMIN');
INSERT INTO public.v13_production_account VALUES('acct','${owner}','p',1,2);
INSERT INTO public.v13_live_money_policy VALUES('p','acct','APPROVED','${policy}','strata-api-reviewed://kxbtc15m/${grant}');`);
await db.query(`INSERT INTO private.strata_api_fee_rate_reviews(owner_user_id,reviewer_user_id,rate_decision_digest,fee_model_version,confirmation,review_note,verified_rate_source,signed_at,expires_at)
 VALUES($1,$2,$3,$4,'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',$5,'kalshi_official_fee_publication',now()-interval '1 minute',now()+interval '1 hour')`,[owner,issuer,RATE,VERSION,'Synthetic original-schema concurrency fixture only. '.repeat(4)]);
await db.query(`INSERT INTO private.strata_api_fee_source_grants(grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,fee_model_version,authorized_stages,confirmation,issued_at,expires_at)
 VALUES($1,$2,$3,$4,$5,ARRAY['STEP_9','STEP_11','ORDER_ENTRY'],'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',now(),now()+interval '15 minutes')`,[grant,owner,issuer,RATE,VERSION]);
await db.query(`INSERT INTO private.strata_api_fee_owner_consents(grant_id,owner_user_id,confirmation) VALUES($1,$2,'CONFIRM_REVIEWED_API_FEE_SOURCE_V1')`,[grant,owner]);
await db.query(`INSERT INTO private.strata_api_fee_standing_models(model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,scope,release_commit_sha,evidence_url,evidence_sha256,evidence_note,signed_at,valid_until)
 VALUES($1,$2,$3,$4,'KXBTC15M:INDEX2',$5,'https://example.invalid/synthetic',$6,$7,now(),now()+interval '2 days')`,[model,reviewer,RATE,VERSION,sha,'c'.repeat(64),'Synthetic independent concurrency fixture only, not live provider evidence. '.repeat(3)]);
await db.query(`INSERT INTO private.strata_api_fee_standing_delegations(delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,confirmation,granted_at,valid_until,lease_expires_at)
 VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1',now(),now()+interval '1 day',now()+interval '15 minutes')`,[owner,model,grant,policy,sha]);
const mutations:Array<[string,string,unknown[]]>=[
 ['model','UPDATE private.strata_api_fee_standing_models SET revoked_at=now() WHERE model_id=$1',[model]],
 ['delegation','UPDATE private.strata_api_fee_standing_delegations SET revoked_at=now() WHERE model_id=$1',[model]],
 ['grant','UPDATE private.strata_api_fee_source_grants SET revoked_at=now() WHERE grant_id=$1',[grant]],
 ['consent','UPDATE private.strata_api_fee_owner_consents SET revoked_at=now() WHERE grant_id=$1',[grant]],
 ['original review','UPDATE private.strata_api_fee_rate_reviews SET revoked_at=now() WHERE owner_user_id=$1',[owner]],
 ['account',"UPDATE public.v13_production_account SET subaccount=3 WHERE id='acct'",[]],
 ['policy',"UPDATE public.v13_live_money_policy SET state='REVOKED' WHERE id='p'",[]],
 ['issuer identity','UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[issuer]],
 ['issuer role',"DELETE FROM private.role_assignments WHERE email='issuer@example.invalid'",[]],
 ['reviewer identity','UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[reviewer]],
 ['reviewer role',"DELETE FROM private.role_assignments WHERE email='reviewer@example.invalid'",[]],
];
async function prove(name:string,acquire:(c:Client)=>Promise<void>,cases:typeof mutations){
 for(const [label,sql,args] of cases){const entry=await db.connect(),writer=await db.connect();try{
  await entry.query('BEGIN');await acquire(entry);
  await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='150ms'");
  await assert.rejects(writer.query(sql,args),(e:unknown)=>typeof e==='object'&&e!==null&&'code' in e&&e.code==='55P03',name+': '+label);
  await writer.query('ROLLBACK');await entry.query('ROLLBACK');
  await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='150ms'");await writer.query(sql,args);await writer.query('ROLLBACK');
 }finally{await entry.query('ROLLBACK');await writer.query('ROLLBACK');entry.release();writer.release()}}
 console.log(`PASS ${name}: ${cases.length} mutations block through borrowed transaction, succeed after release, then roll back`);
}
await prove('legacy standing ORDER_ENTRY',async c=>{assert.equal((await renewStandingFeeObservationLease(owner,grant,'ORDER_ENTRY',{db:{query:(sql,args)=>c.query(sql,args),connect:async()=>c},sha:()=>sha})).ok,true)},mutations);
await prove('legacy finite source ORDER_ENTRY',async c=>{assert.equal((await c.query(READ_API_FEE_STAGE_SQL,[owner,grant,'ORDER_ENTRY',RATE,VERSION])).rows.length,1)},mutations.filter(([label])=>['grant','consent','original review','issuer identity','issuer role'].includes(label)));
// Verify schema remains genuinely legacy, with no owner-authority columns.
assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='private' AND table_name='strata_api_fee_standing_models' AND column_name IN ('authority_kind','owner_authorizer_id','execution_account_id','policy_hash')")).rows.length,0);
console.log('PASS original0030/0034/0042 fee constraints; no owner-self schema or authority changes; synthetic fixtures only');
}finally{await db.end()}})().catch(e=>{console.error(e);process.exitCode=1});
