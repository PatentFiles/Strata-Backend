import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {authorizeOwnerSelfFinalRelease,lookupOwnerFinalReleaseAuthorization} from './inAppProtectiveRelease';
import {OWNER_FINAL_RELEASE_CONFIRM} from './ownerFinalReleaseAuthority';
import {recordOwnerSelfStandingReview} from './ownerSelfStandingReview';
import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
import {createJoinedSigner} from './signedTransport.local.fixture';
import {dedicatedSignerFingerprint} from './commissioning';
import {digest} from '../v13-production/types';
const url=new URL(process.env.DATABASE_URL!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55480');assert.equal(url.pathname,'/owner_final_disposable');
const owner='11111111-1111-4111-8111-111111111111', qid='33333333-3333-4333-8333-333333333333', connection='44444444-4444-4444-8444-444444444444',provider='55555555-5555-4555-8555-555555555555',vault='66666666-6666-4666-8666-666666666666';
const account='owner-final-synthetic',sha='a'.repeat(40),hash='b'.repeat(64);
const signer=createJoinedSigner('25.0000'),fingerprint=dedicatedSignerFingerprint(signer.material.keyId,signer.material.privateKey)!;
const root=process.env.OWNER_FINAL_SOURCE_ROOT!;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {resolve,promise};};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function schema(){
 await pool.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE SCHEMA private;CREATE SCHEMA vault;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text,subaccount int,exchange_index int,
 commissioned boolean,execution_enabled boolean,kill_switch boolean,blocked_reason text,cash_precision_verified boolean,minimum_exit_micros bigint,
 cash_micros bigint,reserved_micros bigint,initial_cash_micros bigint,revision bigint,reconciled_at timestamptz,
 key_fingerprint text,commissioning_digest text,fee_artifact_digest text,kalshi_connection_id uuid,UNIQUE(id,owner_user_id));
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,created_by text,state text,policy_hash text,
 fee_source_url text,fee_policy_version text,fee_formula_version text,approved_at timestamptz,max_entry_stake_cents int,max_entry_all_in_cents int);
 CREATE TABLE public.strata_configured_stake(execution_account_id text PRIMARY KEY,configured_stake_cents int);
 CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,key_fingerprint text,
 role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text,vault_secret_id uuid);
 CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY,decrypted_secret text);
 CREATE TABLE public.live_execution_config(id text PRIMARY KEY,mode text,live_execution_enabled boolean,manual_kill_switch boolean,updated_at timestamptz);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text NOT NULL,owner_user_id uuid NOT NULL,financial_account_id uuid,provider_connection_id uuid,
 credential_fingerprint text,vault_secret_id uuid,state text,account_kill boolean,arm_requested boolean,fencing_token bigint,heartbeat_at timestamptz,released_at timestamptz,
 CONSTRAINT kalshi_account_worker_lease_owner_fk FOREIGN KEY(execution_account_id,owner_user_id) REFERENCES public.v13_production_account(id,owner_user_id));
 CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text,created_at timestamptz,kind text,state text,request jsonb,
 client_order_id text,exchange_order_id text,terminal boolean,filled_hundredths bigint,reserved_micros bigint);
 CREATE TABLE public.v13_production_event(event_id text,account_id text,intent_id text,cash_delta_micros bigint,pnl_micros bigint);
 CREATE TABLE public.v13_production_position(id text,account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE public.v13_production_observation(id text PRIMARY KEY,account_id text,kind text,payload jsonb,digest text,observed_at timestamptz DEFAULT now());
 CREATE TABLE private.strata_emergency_exit_reservations(reservation_id text,execution_account_id text,state text);`);
 for(const f of ['sql/strata_protective_exit_release_private.sql','sql/strata_protective_exit_release_renewable.sql','sql/strata_in_app_protective_release_approval.sql',
 'sql/strata_owner_sha_approval.sql','lib/db/drizzle/0043_strata_continuous_execution_grants.sql','lib/db/owner-self-release/001_explicit_owner_authority.sql',
 'sql/held-consent-deadlines.sql','docs/owner-final-release-candidate/002_owner_final_authority.sql'])await pool.query(readFileSync(root+'/'+f,'utf8'));
}
async function reset(){
 await pool.query(`TRUNCATE auth.users,public.v13_production_account,public.v13_live_money_policy,public.strata_configured_stake,
 public.financial_accounts,private.provider_connections,private.kalshi_connection_credentials,vault.decrypted_secrets,public.live_execution_config,
 private.kalshi_account_worker_lease,public.v13_production_intent,public.v13_production_event,public.v13_production_position,
 public.v13_production_observation,private.strata_emergency_exit_reservations CASCADE`);
 await pool.query('INSERT INTO auth.users VALUES($1)',[owner]);
 await pool.query(`INSERT INTO public.v13_production_account VALUES($1,$2,'p',1,2,true,false,true,NULL,true,10000,25000000,0,25000000,1,now()-interval '1 day',$3,$4,$4,$5)`,[account,owner,fingerprint,hash,connection]);
 await pool.query(`INSERT INTO public.v13_live_money_policy VALUES('p',$1,$2,'APPROVED',$3,'https://kalshi.com/docs/kalshi-fee-schedule.pdf','synthetic','synthetic',now(),500,625)`,[account,owner,hash]);
 await pool.query('INSERT INTO public.strata_configured_stake VALUES($1,500)',[account]);
 await pool.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[connection,owner]);
 await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[provider,connection]);
 await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,'restricted_execution',NULL,now(),'credential_verified',$5)",[owner,connection,provider,fingerprint,vault]);
 await pool.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[vault,JSON.stringify({api_key_id:signer.material.keyId,private_key:signer.material.privateKey})]);
 await pool.query("INSERT INTO public.live_execution_config VALUES('singleton','V13_PRODUCTION',true,false,now())");
 await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,$3,$4,$5,$6,'killed',true,false,7,now(),NULL)",[account,owner,connection,provider,fingerprint,vault]);
 const activation={accountId:account,policyId:'p',feeDigest:hash,stakeCents:500,commissioningDigest:hash,minimumExitMicros:10000};
 await pool.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES('activation',$1,'OWNER_ACTIVATION_REQUEST',$2,$3)",[account,activation,digest(activation)]);
 await pool.query(`INSERT INTO private.strata_protective_release_qualification(qualification_id,release_commit_sha,owner_user_id,execution_account_id,evidence_digest) VALUES($1,$2,$3,$4,$5)`,[qid,sha,owner,account,hash]);
 await pool.query(`INSERT INTO private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest) VALUES($1,$2,$3,$4,$5)`,[owner,account,sha,qid,hash]);
 const review=await recordOwnerSelfStandingReview(owner,{expectedSha:sha,accountId:account,policyHash:hash,qualificationId:qid,confirmation:OWNER_SELF_REVIEW_CONFIRM},
 {db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account})});assert.equal(review.ok,true,JSON.stringify(review));
 return {reviewId:String('reviewId' in review?review.reviewId:''),qualificationId:qid,accountId:account,policyHash:hash,expectedSha:sha,confirmation:OWNER_FINAL_RELEASE_CONFIRM};
}
const deps={db:pool,sha:()=>sha,ownerFinalEnabled:()=>true,ownerFinalScope:()=>({ownerId:owner,accountId:account}),readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never};
const state=async()=>({a:(await pool.query('SELECT execution_enabled,kill_switch,reconciled_at FROM public.v13_production_account')).rows[0],w:(await pool.query('SELECT state,account_kill,arm_requested,fencing_token FROM private.kalshi_account_worker_lease')).rows[0],count:Number((await pool.query('SELECT count(*) FROM private.strata_protective_exit_release')).rows[0].count)});
test('actual owner final transaction: commit, replay lookup, rollback and revocation concurrency',async(t)=>{
 try{await schema();
 await t.test('happy path uses actual signed synthetic GET, immutable authority, fences killed lease, never starts',async()=>{
 const b=await reset();const r=await authorizeOwnerSelfFinalRelease(owner,b,deps);assert.equal(r.ok,true,JSON.stringify(r));
 const s=await state();assert.equal(s.a.kill_switch,false);assert.equal(s.a.execution_enabled,true);assert.equal(s.w.state,'released');assert.equal(s.w.arm_requested,false);assert.equal(s.w.fencing_token,'8');assert.equal(s.count,1);
 assert.equal((await lookupOwnerFinalReleaseAuthorization(owner,b.reviewId,account,deps)).outcome,'RECORDED');
 assert.equal((await lookupOwnerFinalReleaseAuthorization(owner,b.reviewId,'another-account',deps)).outcome,'UNKNOWN');
 assert.equal((await lookupOwnerFinalReleaseAuthorization('22222222-2222-4222-8222-222222222222',b.reviewId,account,deps)).outcome,'UNKNOWN');
 assert.equal((await lookupOwnerFinalReleaseAuthorization(owner,'77777777-7777-4777-8777-777777777777',account,deps)).outcome,'UNKNOWN');
 const repeat=await authorizeOwnerSelfFinalRelease(owner,b,deps);assert.equal(repeat.ok,false);assert.equal((await state()).count,1);
 });
 await t.test('database refuses a different fresh qualification than the one reviewed',async()=>{
 const b=await reset(),other='99999999-9999-4999-8999-999999999999';
 await pool.query(`INSERT INTO private.strata_protective_release_qualification(qualification_id,release_commit_sha,owner_user_id,execution_account_id,evidence_digest) VALUES($1,$2,$3,$4,$5)`,[other,sha,owner,account,hash]);
 await assert.rejects(()=>pool.query(`INSERT INTO private.strata_protective_exit_release
 (release_commit_sha,operator_approver_id,review_url,release_evidence_digest,state,expires_at,release_authority,owner_authorizer_id,execution_account_id,policy_hash,standing_review_id,qualification_id)
 VALUES($1,$2,$3,$4,'approved',now()+interval '2 hours','OWNER_SELF_V1',$2,$5,$4,$6,$7)`,
 [sha,owner,'https://github.com/PatentFiles/Strata-Backend/commit/'+sha,hash,account,b.reviewId,other]),/owner final authority evidence invalid/);
 assert.equal((await state()).count,0);assert.equal((await state()).a.kill_switch,true);
 });
 await t.test('concurrent owner finalizations produce exactly one authority and one lease fence',async()=>{
 const b=await reset();const outcomes=await Promise.all([authorizeOwnerSelfFinalRelease(owner,b,deps),authorizeOwnerSelfFinalRelease(owner,b,deps)]);
 assert.equal(outcomes.filter(r=>r.ok).length,1,JSON.stringify(outcomes));const s=await state();assert.equal(s.count,1);assert.equal(s.w.fencing_token,'8');assert.equal(s.w.arm_requested,false);
 });
 await t.test('failure after account enable rolls back release, account and lease together',async()=>{
 const b=await reset();const broken={...deps,db:{query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{if(sql.includes('UPDATE private.kalshi_account_worker_lease'))throw Error('synthetic failure');return c.query(sql,args);}};}}};
 const r=await authorizeOwnerSelfFinalRelease(owner,b,broken as never);assert.equal(r.ok,false);assert.notEqual('outcome' in r&&r.outcome,'PROVEN_NOT_COMMITTED');const s=await state();assert.equal(s.a.kill_switch,true);assert.equal(s.a.execution_enabled,false);assert.equal(s.w.state,'killed');assert.equal(s.count,0);
 });
 await t.test('revocation during signed read prevents any enabling write',async()=>{
 const b=await reset(),entered=deferred(),resume=deferred();
 const pending=authorizeOwnerSelfFinalRelease(owner,b,{...deps,readFeeds:(async(m:typeof signer.material,at:number)=>signer.read(m,at,[],true,()=>entered.resolve(),resume.promise)) as never});
 await Promise.race([entered.promise,pending.then(r=>{throw Error(JSON.stringify(r));})]);await pool.query("UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='synthetic revoked' WHERE release_id=$1",[b.reviewId]);resume.resolve();
 const r=await pending;assert.equal(r.ok,false);assert.equal((await state()).count,0);assert.equal((await state()).a.kill_switch,true);
 });
 for(const [name,mutation] of [
 ['credential revocation',"UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp()"],
 ['policy change',"UPDATE public.v13_live_money_policy SET policy_hash=repeat('c',64)"],
 ['owner consent revocation',"UPDATE private.strata_owner_sha_approvals SET revoked_at=clock_timestamp()"],
 ] as const) await t.test(name+' during signed read prevents release',async()=>{
 const b=await reset(),entered=deferred(),resume=deferred();
 const pending=authorizeOwnerSelfFinalRelease(owner,b,{...deps,readFeeds:(async(m:typeof signer.material,at:number)=>signer.read(m,at,[],true,()=>entered.resolve(),resume.promise)) as never});
 await Promise.race([entered.promise,pending.then(r=>{throw Error('did not reach signed read: '+JSON.stringify(r));})]);
 await pool.query(mutation);resume.resolve();const r=await pending;assert.equal(r.ok,false);const s=await state();assert.equal(s.count,0);assert.equal(s.a.kill_switch,true);
 });
 await t.test('deferred database five-second deadline rolls back at COMMIT',async()=>{
 const b=await reset();const slow={...deps,db:{query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{if(sql==='COMMIT')await delay(5100);return c.query(sql,args);}};}}};
 const r=await authorizeOwnerSelfFinalRelease(owner,b,slow as never);assert.equal(r.ok,false);const s=await state();assert.equal(s.a.kill_switch,true);assert.equal(s.w.state,'killed');assert.equal(s.count,0);
 });
 await t.test('lost commit acknowledgment returns UNKNOWN with durable lookup, not retry permission',async()=>{
 const b=await reset();const lost={...deps,db:{query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{const out=await c.query(sql,args);if(sql==='COMMIT')throw Error('synthetic lost acknowledgment');return out;}};}}};
 const r=await authorizeOwnerSelfFinalRelease(owner,b,lost as never);assert.equal(r.ok,false);assert.equal(r.reason,'owner_release_outcome_unknown');assert.equal((await state()).count,1);assert.equal((await lookupOwnerFinalReleaseAuthorization(owner,b.reviewId,account,deps)).outcome,'RECORDED');
 });
 }finally{await pool.end();}
});
