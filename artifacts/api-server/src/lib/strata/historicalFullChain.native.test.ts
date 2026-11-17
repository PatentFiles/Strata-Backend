import {HISTORICAL_FEE_VERSION,HISTORICAL_BASELINE_ID,HISTORICAL_SOURCE_KIND,HISTORICAL_MIGRATION_CONFIRM,HISTORICAL_RISK_ACCEPTANCE} from './historicalOwnerFeeBaseline';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {createHash} from 'node:crypto';
import {migrateOwnedDurableFeePolicy,durableMigrationOutcome,DURABLE_MIGRATION_CONFIRM,DURABLE_PUBLICATION_RISK_ACCEPTANCE} from './durableFeeMigration';
import {requestOwnedAccountActivation,REQUEST_OWNED_ACTIVATION_CONFIRMATION} from './personalAccountActivation';
import {row as originalRow,old,computeV13LiveMoneyPolicyHash} from './durableFeeMigration.fixture';
import {verifyDurableOwnerFee,DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';
import {collectFinalReleaseEvidence,qualifyProtectiveRelease} from './inAppProtectiveRelease';
import {activateOwnerSelfAccount,ownerSelfActivationOutcome,OWNER_SELF_ACTIVATION_CONFIRM} from './ownerSelfAccountActivation';
import {V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,encodeV3FeeSource} from './ownerFeeV3Authority';
import {recordOwnerSelfStandingReview} from './ownerSelfStandingReview';
import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
import {createJoinedSigner} from './signedTransport.local.fixture';
import {dedicatedSignerFingerprint} from './commissioning';
import {digest} from '../v13-production/types';
let unexpectedNetwork=0;globalThis.fetch=(async()=>{unexpectedNetwork++;throw Error('unexpected live HTTP forbidden in isolated test');}) as typeof fetch;
const url=new URL(process.env.DATABASE_URL!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55486');assert.equal(url.pathname,'/owner_activation_disposable');
const owner='11111111-1111-4111-8111-111111111111', connection='44444444-4444-4444-8444-444444444444',provider='55555555-5555-4555-8555-555555555555',vault='66666666-6666-4666-8666-666666666666';
const authority='77777777-7777-4777-8777-777777777777', attestation='88888888-8888-4888-8888-888888888888',consent='99999999-9999-4999-8999-999999999999';
process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='true';process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED='true';process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';
let qid='33333333-3333-4333-8333-333333333333';
const root=process.env.OWNER_FINAL_SOURCE_ROOT!;
const bytes=readFileSync(root+'/attached_assets/0_kalshi-fee-schedule_1790474920034.pdf');
const account='owner-final-synthetic',sha='a'.repeat(40),sourceDigest=createHash('sha256').update(bytes).digest('hex');
let hash=sourceDigest;
const legacyPolicy={...old,maxEntryStakeCents:500,maxEntryAllInCents:625};const legacyRow={...originalRow,max_entry_stake_cents:500,max_entry_all_in_cents:625,policy_hash:computeV13LiveMoneyPolicyHash(legacyPolicy)};
const signer=createJoinedSigner('25.0000'),fingerprint=dedicatedSignerFingerprint(signer.material.keyId,signer.material.privateKey)!;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {resolve,promise};};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function schema(){
 await pool.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE SCHEMA private;CREATE SCHEMA vault;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE private.strata_railway_official_fee_capture_v5(capture_id bigint PRIMARY KEY,execution_account_id text,content_sha256 text,effective_date date,canonical_url text,source_kind text,captured_at timestamptz,expires_at timestamptz,original_bytes bytea,byte_length integer,policy_version text);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text,subaccount int,exchange_index int,
 commissioned boolean,execution_enabled boolean,kill_switch boolean,blocked_reason text,cash_precision_verified boolean,minimum_exit_micros bigint,
 cash_micros bigint,reserved_micros bigint,initial_cash_micros bigint,revision bigint,reconciled_at timestamptz,
 key_fingerprint text,commissioning_digest text,fee_artifact_digest text,kalshi_connection_id uuid,UNIQUE(id,owner_user_id));
 CREATE TABLE public.v13_live_money_policy(${Object.entries(legacyRow).map(([k,v])=>`${k} ${v instanceof Date?'timestamptz':typeof v==='number'?'integer':typeof v==='boolean'?'boolean':'text'}${k==='id'?' PRIMARY KEY':''}`).join(',')},execution_account_id text NOT NULL, UNIQUE(execution_account_id,version));
 CREATE TABLE private.kalshi_owner_pilot_transfers(execution_account_id text,owner_user_id uuid,state text,bot_after_cents int,completed_at timestamptz);
 CREATE TABLE private.kalshi_owner_historical_funding(execution_account_id text,owner_user_id uuid,bot_after_cents int,primary_after_cents int,verified_at timestamptz);
 CREATE UNIQUE INDEX active_policy_one ON public.v13_live_money_policy(execution_account_id) WHERE state='APPROVED';
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
 'sql/held-consent-deadlines.sql','lib/db/drizzle/0036_owner_fee_v3_evidence.sql','lib/db/drizzle/0037_owner_v3_fee_authority.sql','lib/db/owner-self-release/002_owner_standing_fee_v1.sql','docs/durable-fee/schema.sql'])await pool.query(readFileSync(root+'/'+f,'utf8'));
}
const migrationBody=()=>({accountId:account,sourceKind:HISTORICAL_SOURCE_KIND,baselineId:HISTORICAL_BASELINE_ID,modelId:authority,expectedSha:sha,expectedPolicyId:legacyRow.id,expectedPolicyHash:legacyRow.policy_hash,expectedPolicyVersion:1,confirmation:HISTORICAL_MIGRATION_CONFIRM,riskAcceptance:HISTORICAL_RISK_ACCEPTANCE});
const migrationDeps={db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account}),read:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never};
async function noMigration(){const a=(await pool.query('SELECT policy_id,execution_enabled,kill_switch FROM public.v13_production_account')).rows[0];assert.equal(a.policy_id,legacyRow.id);assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);assert.equal((await pool.query('SELECT count(*) FROM private.strata_durable_owner_fee_model')).rows[0].count,'0');assert.equal((await pool.query("SELECT count(*) FROM public.v13_live_money_policy WHERE state='APPROVED'")).rows[0].count,'1');}
async function reset(priorSameSha: false|true|'old'=false,prepareOnly=false){
 hash=sourceDigest;
 await pool.query(`TRUNCATE private.kalshi_owner_historical_funding,private.kalshi_owner_pilot_transfers,private.strata_railway_official_fee_capture_v5,auth.users,public.v13_production_account,public.v13_live_money_policy,public.strata_configured_stake,
 public.financial_accounts,private.provider_connections,private.kalshi_connection_credentials,vault.decrypted_secrets,public.live_execution_config,
 private.kalshi_account_worker_lease,public.v13_production_intent,public.v13_production_event,public.v13_production_position,
 public.v13_production_observation,private.strata_emergency_exit_reservations CASCADE`);
 await pool.query('INSERT INTO auth.users VALUES($1)',[owner]);
 await pool.query("INSERT INTO private.kalshi_owner_historical_funding VALUES($1,$2,2500,0,now()-interval '1 hour')",[account,owner]);
 await pool.query(`INSERT INTO public.v13_production_account VALUES($1,$2,'22222222-2222-4222-8222-222222222222',1,2,true,false,true,NULL,true,10000,25000000,0,25000000,1,now(),$3,$4,$4,$5)`,[account,owner,fingerprint,hash,connection]);
 const entries=Object.entries({...legacyRow,execution_account_id:account});await pool.query(`INSERT INTO public.v13_live_money_policy(${entries.map(x=>x[0])}) VALUES(${entries.map((_,i)=>'$'+(i+1))})`,entries.map(x=>x[1]));
 await pool.query('INSERT INTO public.strata_configured_stake VALUES($1,500)',[account]);
 await pool.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[connection,owner]);
 await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[provider,connection]);
 await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,'restricted_execution',NULL,now(),'credential_verified',$5)",[owner,connection,provider,fingerprint,vault]);
 await pool.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[vault,JSON.stringify({api_key_id:signer.material.keyId,private_key:signer.material.privateKey})]);
 await pool.query("INSERT INTO public.live_execution_config VALUES('singleton','V13_PRODUCTION',true,false,now())");
 await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,$3,$4,$5,$6,'killed',true,false,7,now(),NULL)",[account,owner,connection,provider,fingerprint,vault]);
 const activation={accountId:account,policyId:'p',feeDigest:hash,stakeCents:500,commissioningDigest:hash,minimumExitMicros:10000};
 await pool.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES('activation',$1,'OWNER_ACTIVATION_REQUEST',$2,$3)",[account,activation,digest(activation)]);
 if(priorSameSha){await pool.query(`INSERT INTO private.strata_protective_release_qualification(qualification_id,release_commit_sha,owner_user_id,execution_account_id,evidence_digest) VALUES($1,$2,$3,$4,$5)`,['33333333-3333-4333-8333-333333333333',priorSameSha==='old'?'c'.repeat(40):sha,owner,account,sourceDigest]);await pool.query(`INSERT INTO private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest) VALUES($1,$2,$3,$4,$5)`,[owner,account,priorSameSha==='old'?'c'.repeat(40):sha,'33333333-3333-4333-8333-333333333333',sourceDigest]);}
 if(prepareOnly)return null;
 const migration=await migrateOwnedDurableFeePolicy(owner,migrationBody(),migrationDeps);if(priorSameSha===true){assert.equal(migration.ok,false,JSON.stringify(migration));assert.equal(migration.reason,'durable_migration_fresh_release_sha_required');return null;}assert.equal(migration.ok,true,JSON.stringify(migration));assert.ok('newPolicyHash' in migration);hash=migration.newPolicyHash;
 const policies=(await pool.query("SELECT * FROM public.v13_live_money_policy ORDER BY version")).rows;assert.equal(policies.length,2);assert.equal(policies[0].state,'REVOKED');assert.equal(policies[1].state,'APPROVED');assert.equal(policies[1].max_entry_stake_cents,500);assert.equal(policies[1].max_entry_all_in_cents,625);assert.equal(policies[1].max_daily_loss_cents,legacyRow.max_daily_loss_cents);
 const stale=await qualifyProtectiveRelease(owner,{db:pool,sha:()=>sha});assert.equal(stale.ok,false);assert.equal(stale.reason,'owner_activation_request_stale_or_missing');
 const requested=await requestOwnedAccountActivation(pool,{ownerUserId:owner,confirmation:REQUEST_OWNED_ACTIVATION_CONFIRMATION});assert.equal(requested.ok,true,JSON.stringify(requested));
 const qualified=await qualifyProtectiveRelease(owner,{db:pool,sha:()=>sha,readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never,verifyDurableFee:stage as never});assert.equal(qualified.ok,true,JSON.stringify(qualified));qid=String('qualificationId' in qualified?qualified.qualificationId:'');
 const review=await recordOwnerSelfStandingReview(owner,{expectedSha:sha,accountId:account,policyHash:hash,qualificationId:qid,confirmation:OWNER_SELF_REVIEW_CONFIRM},
 {db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account})});assert.equal(review.ok,true,JSON.stringify(review));
 return {reviewId:String('reviewId' in review?review.reviewId:''),qualificationId:qid,accountId:account,policyHash:hash,expectedSha:sha,confirmation:OWNER_SELF_ACTIVATION_CONFIRM};
}

// Real durable verifier SQL and current-market validation; synthetic HTTP only.
const market='KXBTC15M-EXACT-TEST';
const feed=async(url:any)=>{assert.ok(!String(url).includes('.pdf'));const at=Date.now(),iso=(ms:number)=>new Date(at+ms).toISOString();const path=String(url).replace('https://external-api.kalshi.com/trade-api/v2','');
const pages:Record<string,unknown>={['/markets/'+market]:{market:{ticker:market,event_ticker:market,status:'open',exchange_index:2,open_time:iso(-60000),close_time:iso(600000),expiration_time:iso(660000),latest_expiration_time:iso(660000),expected_expiration_time:iso(660000)}},['/events/'+market]:{event:{event_ticker:market,series_ticker:'KXBTC15M',fee_type_override:null,fee_multiplier_override:null}},'/series/KXBTC15M':{series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:1}},'/series/fee_changes?series_ticker=KXBTC15M&show_historical=false':{series_fee_change_arr:[],cursor:''},['/events/fee_changes?event_ticker='+market+'&limit=100']:{event_fee_changes:[],cursor:''}};
assert.ok(path in pages,'unexpected HTTP '+path);return new Response(JSON.stringify(pages[path]),{status:200,headers:{'content-type':'application/json'}});};
const locked:typeof verifyDurableOwnerFee=(tx,scope,ticker,intent)=>verifyDurableOwnerFee(tx,scope,ticker,intent,{fetcher:feed});
const stage=async()=>locked(pool,{owner,account,sha,policyHash:hash},market,'ENTRY');
const deps={db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account}),verifyDurableStage:stage as never,verifyDurableLocked:locked,
 signedEvidence:((o:string)=>collectFinalReleaseEvidence(o,{db:pool,readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never})) as never};
const state=async()=>({a:(await pool.query('SELECT execution_enabled,kill_switch FROM public.v13_production_account')).rows[0],w:(await pool.query('SELECT state,account_kill,arm_requested,fencing_token FROM private.kalshi_account_worker_lease')).rows[0],count:Number((await pool.query("SELECT count(*) FROM public.v13_production_observation WHERE kind='OWNER_SELF_ACCOUNT_ACTIVATED'")).rows[0].count),approvals:Number((await pool.query('SELECT count(*) FROM private.strata_owner_sha_approvals')).rows[0].count)});
const wrap=(hook:(sql:string,args:unknown[]|undefined,c:any)=>Promise<any>)=>({...deps,db:{query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:(sql:string,args?:unknown[])=>hook(sql,args,c)};}}});
async function untouched(){const s=await state();assert.equal(s.a.kill_switch,true);assert.equal(s.a.execution_enabled,false);assert.equal(s.w.state,'killed');assert.equal(s.w.fencing_token,'7');assert.equal(s.w.arm_requested,false);assert.equal(s.count,0);assert.equal(s.approvals,0);}
test('historical baseline full chain, consent, source separation and atomicity',async(t)=>{try{await schema();
 await t.test('no prior same-SHA approval completes all actual stages, preserved limits, remains disarmed',async()=>{const b=await reset();assert.ok(b);const r=await activateOwnerSelfAccount(owner,b,deps);assert.equal(r.ok,true,JSON.stringify(r));const proof=await stage();assert.equal(proof.ok,true);if(proof.ok){assert.equal(proof.sourceAuthenticityVerified,false);assert.equal(proof.publicationKnownCurrent,false);assert.equal(proof.sourceKind,HISTORICAL_SOURCE_KIND);assert.equal(proof.policyVersion,HISTORICAL_FEE_VERSION);}const model=(await pool.query('SELECT source_capture_id,genuine_source_verified,source_kind FROM private.strata_durable_owner_fee_model')).rows[0];assert.equal(model.source_capture_id,null);assert.equal(model.genuine_source_verified,false);assert.equal(model.source_kind,HISTORICAL_SOURCE_KIND);assert.equal((await pool.query('SELECT count(*) FROM private.strata_railway_official_fee_capture_v5')).rows[0].count,'0');const st=await state();assert.equal(st.a.execution_enabled,true);assert.equal(st.a.kill_switch,false);assert.equal(st.w.state,'released');assert.equal(st.w.arm_requested,false);assert.equal(st.count,1);assert.equal(st.approvals,1);});
 await t.test('existing same-SHA approval refuses migration before any write or revocation',async()=>{await reset(true);const st=await state();assert.equal(st.a.kill_switch,true);assert.equal(st.a.execution_enabled,false);assert.equal(st.count,0);assert.equal(st.w.state,'killed');assert.equal((await pool.query('SELECT count(*) FROM private.strata_durable_owner_fee_model')).rows[0].count,'0');const p=(await pool.query('SELECT id,state FROM public.v13_live_money_policy')).rows;assert.equal(p.length,1);assert.equal(p[0].id,legacyRow.id);assert.equal(p[0].state,'APPROVED');assert.equal((await pool.query('SELECT revoked_at FROM private.strata_owner_sha_approvals')).rows[0].revoked_at,null);});
 await t.test('prior OLD-SHA approval revoked by migration does not poison new-SHA activation',async()=>{const b=await reset('old');assert.ok(b);const r=await activateOwnerSelfAccount(owner,b,deps);assert.equal(r.ok,true,JSON.stringify(r));const st=await state();assert.equal(st.approvals,2);assert.equal(st.count,1);assert.equal(st.w.arm_requested,false);const approvals=(await pool.query('SELECT release_commit_sha,revoked_at FROM private.strata_owner_sha_approvals ORDER BY release_commit_sha')).rows;assert.equal(approvals[0].release_commit_sha,sha);assert.equal(approvals[0].revoked_at,null);assert.ok(approvals[1].revoked_at);});

 for(const [name,change] of [
 ['missing risk acceptance',{riskAcceptance:undefined}],['fresh capture consent',{confirmation:DURABLE_MIGRATION_CONFIRM,riskAcceptance:DURABLE_PUBLICATION_RISK_ACCEPTANCE}],['unrecognized baseline',{baselineId:'other-baseline'}],['added capture ID',{captureId:'1'}],['fake source kind',{sourceKind:'FRESH_CANONICAL_CAPTURE'}],
 ] as const)await t.test('migration refuses '+name,async()=>{await reset(false,true);const result=await migrateOwnedDurableFeePolicy(owner,{...migrationBody(),...change},migrationDeps);assert.equal(result.ok,false,JSON.stringify(result));await noMigration();});
 await t.test('historical feature disabled refuses migration and active proof',async()=>{await reset(false,true);process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='false';try{assert.equal((await migrateOwnedDurableFeePolicy(owner,migrationBody(),migrationDeps)).ok,false);await noMigration();}finally{process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='true';}const b=await reset();assert.ok(b);process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='false';try{assert.equal((await stage()).ok,false);assert.equal((await activateOwnerSelfAccount(owner,b,deps)).ok,false);}finally{process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='true';}});
 await t.test('known conflicting canonical capture blocks historical migration',async()=>{await reset(false,true);await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 VALUES(1,$1,repeat('f',64),'2026-07-07','https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct',now(),now()+interval '55 minutes',$2,$3,'issuer_pdf_55m_signed_api_recheck_v2')",[account,bytes,bytes.length]);assert.equal((await migrateOwnedDurableFeePolicy(owner,migrationBody(),migrationDeps)).ok,false);await noMigration();});
 await t.test('concurrent historical migrations commit exactly once',async()=>{await reset(false,true);const results=await Promise.all([migrateOwnedDurableFeePolicy(owner,migrationBody(),migrationDeps),migrateOwnedDurableFeePolicy(owner,migrationBody(),migrationDeps)]);assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));assert.equal((await pool.query('SELECT count(*) FROM private.strata_durable_owner_fee_model')).rows[0].count,'1');});
 for(const point of ['UPDATE public.v13_live_money_policy SET','INSERT INTO private.strata_durable_owner_fee_model','INSERT INTO private.strata_durable_fee_migration'])await t.test('rollback at '+point,async()=>{await reset(false,true);let hit=false;const db={connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{const result=await c.query(sql,args);if(point==='INSERT INTO private.strata_durable_fee_migration'?/INSERT INTO private\.strata_durable_fee_migration\s/.test(sql):sql.includes(point)){hit=true;throw Error('injected after write');}return result;}}}};const result=await migrateOwnedDurableFeePolicy(owner,migrationBody(),{...migrationDeps,db});assert.equal(hit,true);assert.equal(result.ok,false);await noMigration();});
 await t.test('historical authenticity cannot be relabeled as verified canonical source',async()=>{await reset();await assert.rejects(pool.query("UPDATE private.strata_durable_owner_fee_model SET genuine_source_verified=true,source_kind='FRESH_CANONICAL_CAPTURE'"));const p=await stage();assert.equal(p.ok,true);if(p.ok)assert.equal(p.sourceAuthenticityVerified,false);});
 for(const mutation of ['entry_revoked=true','known_publication_change=true'])await t.test('historical activation fails closed after '+mutation,async()=>{const b=await reset();assert.ok(b);await pool.query('UPDATE private.strata_durable_owner_fee_state SET '+mutation);assert.equal((await stage()).ok,false);assert.equal((await activateOwnerSelfAccount(owner,b,deps)).ok,false);const s=await state();assert.equal(s.a.execution_enabled,false);assert.equal(s.a.kill_switch,true);assert.equal(s.w.arm_requested,false);});

 await t.test('lost migration COMMIT ACK has historical readback, not retry permission or authenticity claim',async()=>{await reset(false,true);const db={connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{const out=await c.query(sql,args);if(sql==='COMMIT')throw Error('injected lost ACK');return out;}}}};const result=await migrateOwnedDurableFeePolicy(owner,migrationBody(),{...migrationDeps,db});assert.equal(result.ok,false);assert.equal(result.reason,'durable_migration_commit_unknown');assert.equal('retryAuthorized' in result&&result.retryAuthorized,false);const outcome=await durableMigrationOutcome(owner,authority,sha,pool);assert.equal(outcome.outcome,'RECORDED');if(outcome.outcome==='RECORDED'){assert.equal(outcome.sourceEffectiveDate,'2026-07-07');assert.equal(outcome.policyVersion,HISTORICAL_FEE_VERSION);assert.equal(outcome.sourceKind,HISTORICAL_SOURCE_KIND);assert.equal(outcome.sourceAuthenticityVerified,false);assert.equal(outcome.publicationKnownCurrent,false);assert.equal(outcome.baselineId,HISTORICAL_BASELINE_ID);}assert.equal((await state()).a.kill_switch,true);});
 await t.test('new conflicting capture after qualification latches and blocks activation',async()=>{const b=await reset();assert.ok(b);await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 VALUES(1,$1,repeat('f',64),'2026-07-07','https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct',now(),now()+interval '55 minutes',$2,$3,'issuer_pdf_55m_signed_api_recheck_v2')",[account,bytes,bytes.length]);assert.equal((await pool.query('SELECT known_publication_change FROM private.strata_durable_owner_fee_state')).rows[0].known_publication_change,true);assert.equal((await activateOwnerSelfAccount(owner,b,deps)).ok,false);assert.equal((await state()).a.kill_switch,true);});
 await t.test('two simultaneous historical activation requests commit only once',async()=>{const b=await reset();assert.ok(b);const result=await Promise.all([activateOwnerSelfAccount(owner,b,deps),activateOwnerSelfAccount(owner,b,deps)]);assert.equal(result.filter(r=>r.ok).length,1,JSON.stringify(result));const st=await state();assert.equal(st.count,1);assert.equal(st.w.fencing_token,'8');assert.equal(st.w.arm_requested,false);});
 await t.test('missing current API applicability blocks historical qualification',async()=>{await reset();const denied=async()=>verifyDurableOwnerFee(pool,{owner,account,sha,policyHash:hash},market,'ENTRY',{fetcher:async()=>new Response('{}',{status:503})});const before=(await pool.query('SELECT count(*) FROM private.strata_protective_release_qualification')).rows[0].count;const r=await qualifyProtectiveRelease(owner,{db:pool,sha:()=>sha,readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never,verifyDurableFee:denied as never});assert.equal(r.ok,false);assert.equal((await pool.query('SELECT count(*) FROM private.strata_protective_release_qualification')).rows[0].count,before);});
 await t.test('all stages remained off live network',()=>{assert.equal(unexpectedNetwork,0);});
}finally{await pool.end();}});
