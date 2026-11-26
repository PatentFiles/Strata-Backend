import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {createHash} from 'node:crypto';
import {enrollDurableOwnerFee} from './durableFeeLifecycle';
import {verifyDurableOwnerFee,DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';
import {collectFinalReleaseEvidence,qualifyProtectiveRelease} from './inAppProtectiveRelease';
import {activateOwnerSelfAccount,ownerSelfActivationOutcome,OWNER_SELF_ACTIVATION_CONFIRM} from './ownerSelfAccountActivation';
import {V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,encodeV3FeeSource} from './ownerFeeV3Authority';
import {recordOwnerSelfStandingReview} from './ownerSelfStandingReview';
import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
import {createJoinedSigner} from './signedTransport.local.fixture';
import {dedicatedSignerFingerprint} from './commissioning';
import {digest} from '../v13-production/types';
const url=new URL(process.env.DATABASE_URL!);
assert.equal(process.env.NODE_ENV,'test');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55481');assert.equal(url.pathname,'/owner_activation_disposable');
const owner='11111111-1111-4111-8111-111111111111', connection='44444444-4444-4444-8444-444444444444',provider='55555555-5555-4555-8555-555555555555',vault='66666666-6666-4666-8666-666666666666';
const authority='77777777-7777-4777-8777-777777777777', attestation='88888888-8888-4888-8888-888888888888',consent='99999999-9999-4999-8999-999999999999';
process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED='true';process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';
let qid='33333333-3333-4333-8333-333333333333';
const root=process.env.OWNER_FINAL_SOURCE_ROOT!;
const bytes=readFileSync(root+'/attached_assets/0_kalshi-fee-schedule_1790474920034.pdf');
const account='owner-final-synthetic',sha='a'.repeat(40),hash=createHash('sha256').update(bytes).digest('hex');
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
 CREATE TABLE public.v13_production_event(event_id text,account_id text,intent_id text,digest text NOT NULL,cash_delta_micros bigint,pnl_micros bigint);
 CREATE TABLE public.v13_production_position(id text,account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE public.v13_production_observation(id text PRIMARY KEY,account_id text,kind text,payload jsonb,digest text,observed_at timestamptz DEFAULT now());
 CREATE TABLE private.strata_emergency_exit_reservations(reservation_id text,execution_account_id text,state text);`);
 for(const f of ['sql/strata_protective_exit_release_private.sql','sql/strata_protective_exit_release_renewable.sql','sql/strata_in_app_protective_release_approval.sql',
 'sql/strata_owner_sha_approval.sql','lib/db/drizzle/0043_strata_continuous_execution_grants.sql','lib/db/owner-self-release/001_explicit_owner_authority.sql',
 'sql/held-consent-deadlines.sql','lib/db/drizzle/0036_owner_fee_v3_evidence.sql','lib/db/drizzle/0037_owner_v3_fee_authority.sql','lib/db/owner-self-release/002_owner_standing_fee_v1.sql','docs/durable-fee/schema.sql','lib/db/owner-self-release/005_durable_fee_release_authorization.sql'])await pool.query(readFileSync(root+'/'+f,'utf8'));
}
async function reset(){
 await pool.query(`TRUNCATE private.strata_railway_official_fee_capture_v5,auth.users,public.v13_production_account,public.v13_live_money_policy,public.strata_configured_stake,
 public.financial_accounts,private.provider_connections,private.kalshi_connection_credentials,vault.decrypted_secrets,public.live_execution_config,
 private.kalshi_account_worker_lease,public.v13_production_intent,public.v13_production_event,public.v13_production_position,
 public.v13_production_observation,private.strata_emergency_exit_reservations CASCADE`);
 await pool.query('INSERT INTO auth.users VALUES($1)',[owner]);
 await pool.query(`INSERT INTO public.v13_production_account VALUES($1,$2,'p',1,2,true,false,true,NULL,true,10000,25000000,0,25000000,1,now()-interval '1 day',$3,$4,$4,$5)`,[account,owner,fingerprint,hash,connection]);
 await pool.query(`INSERT INTO public.v13_live_money_policy VALUES('p',$1,$2,'APPROVED',$3,$4,$5,$6,now(),500,625)`,[account,owner,hash,'strata-durable-owner-fee://'+authority,DURABLE_FEE_VERSION,V3_FEE_FORMULA_VERSION]);
 await pool.query('INSERT INTO public.strata_configured_stake VALUES($1,500)',[account]);
 await pool.query("INSERT INTO public.financial_accounts VALUES($1,$2,'kalshi')",[connection,owner]);
 await pool.query('INSERT INTO private.provider_connections VALUES($1,$2)',[provider,connection]);
 await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,'restricted_execution',NULL,now(),'credential_verified',$5)",[owner,connection,provider,fingerprint,vault]);
 await pool.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[vault,JSON.stringify({api_key_id:signer.material.keyId,private_key:signer.material.privateKey})]);
 await pool.query("INSERT INTO public.live_execution_config VALUES('singleton','V13_PRODUCTION',true,false,now())");
 await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,$3,$4,$5,$6,'killed',true,false,7,now(),NULL)",[account,owner,connection,provider,fingerprint,vault]);
 const activation={accountId:account,policyId:'p',feeDigest:hash,stakeCents:500,commissioningDigest:hash,minimumExitMicros:10000};
 await pool.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES('activation',$1,'OWNER_ACTIVATION_REQUEST',$2,$3)",[account,activation,digest(activation)]);
 await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 VALUES(1,$1,$2,'2026-07-07','https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct',now(),now()+interval '55 minutes',$3,$4,'issuer_pdf_55m_signed_api_recheck_v2')",[account,hash,bytes,bytes.length]);
 const enrolled=await enrollDurableOwnerFee(owner,{accountId:account,captureId:'1',confirmation:'I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',expectedSha:sha,modelId:authority,policyHash:hash},{db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account})});assert.equal(enrolled.ok,true,JSON.stringify(enrolled));
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
test('durable enrollment + qualification + actual activation on native PostgreSQL',async(t)=>{try{await schema();
 await t.test('happy path + replay readback: account enabled, lease released/disarmed, no START',async()=>{
 const b=await reset();const r=await activateOwnerSelfAccount(owner,b,deps);assert.equal(r.ok,true,JSON.stringify(r));const s=await state();assert.equal(s.a.execution_enabled,true);assert.equal(s.a.kill_switch,false);assert.equal(s.w.state,'released');assert.equal(s.w.fencing_token,'8');assert.equal(s.w.arm_requested,false);assert.equal(s.count,1);assert.equal(s.approvals,1);assert.equal(r.workerStarted,false);assert.equal(r.ordersSubmitted,false);
 assert.equal((await ownerSelfActivationOutcome(owner,sha,pool)).outcome,'RECORDED');assert.equal((await activateOwnerSelfAccount(owner,b,deps)).ok,false);assert.equal((await state()).count,1);
 });
 await t.test('two concurrent requests commit exactly one activation and fence',async()=>{const b=await reset();const r=await Promise.all([activateOwnerSelfAccount(owner,b,deps),activateOwnerSelfAccount(owner,b,deps)]);assert.equal(r.filter(x=>x.ok).length,1,JSON.stringify(r));const s=await state();assert.equal(s.count,1);assert.equal(s.approvals,1);assert.equal(s.w.fencing_token,'8');});
 for(const label of ['UPDATE public.v13_production_account','OWNER_SELF_ACCOUNT_ACTIVATED'])await t.test('rollback after '+label,async()=>{const b=await reset();let hit=false;const d=wrap(async(sql,args,c)=>{const out=await c.query(sql,args);if(sql.includes(label)||(label==='OWNER_SELF_ACCOUNT_ACTIVATED'&&args?.[2]===label)){hit=true;throw Error('injected post-write fault');}return out;});const r=await activateOwnerSelfAccount(owner,b,d);assert.equal(hit,true);assert.equal(r.ok,false);await untouched();});
 await t.test('deferred five-second freshness guard rolls back at COMMIT',async()=>{const b=await reset();const d=wrap(async(sql,args,c)=>{if(sql==='COMMIT')await delay(5100);return c.query(sql,args);});const r=await activateOwnerSelfAccount(owner,b,d);assert.equal(r.ok,false);assert.equal(r.reason,'owner_self_activation_commit_outcome_unknown');await untouched();assert.equal((await ownerSelfActivationOutcome(owner,sha,pool)).outcome,'UNKNOWN');});
 await t.test('source monotonic deadline refuses COMMIT despite post-proof wall rollback',async()=>{
 const b=await reset();let mono=0,wall=Date.now(),commits=0,advanced=false;
 const d=wrap(async(sql,args,c)=>{const out=await c.query(sql,args);
  if(args?.[2]==='OWNER_RELEASE_SIGNED_RECHECK'){mono=5001;wall-=1000;advanced=true;}
  if(sql==='COMMIT')commits++;return out;});
 const r=await activateOwnerSelfAccount(owner,b,{...d,verifyDurableLocked:async(tx,scope,ticker,intent)=>{
  const proof=await verifyDurableOwnerFee(tx,scope,ticker,intent,{fetcher:feed,clock:()=>wall,monotonicNow:()=>mono});
  wall+=4000;mono=4000;return proof;}});
 assert.equal(advanced,true);assert.equal(r.ok,false);assert.equal(r.reason,'owner_self_durable_fee_changed_or_unverified');
 assert.equal(commits,0);await untouched();
 });
 await t.test('lost COMMIT acknowledgment is UNKNOWN, no retry authorization, durable readback',async()=>{const b=await reset();const d=wrap(async(sql,args,c)=>{const out=await c.query(sql,args);if(sql==='COMMIT')throw Error('injected lost acknowledgment');return out;});const r=await activateOwnerSelfAccount(owner,b,d);assert.equal(r.ok,false);assert.equal(r.reason,'owner_self_activation_commit_outcome_unknown');assert.equal('retryAuthorized' in r&&r.retryAuthorized,false);assert.equal((await state()).count,1);assert.equal((await ownerSelfActivationOutcome(owner,sha,pool)).outcome,'RECORDED');});

 for(const [name,mutation] of [
 ['review revocation',"UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='synthetic revoked'"],
 ['durable entry revocation',"UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true"],
 ['known publication change',"UPDATE private.strata_durable_owner_fee_state SET known_publication_change=true"],
 ['credential revocation',"UPDATE private.kalshi_connection_credentials SET revoked_at=clock_timestamp()"],
 ['policy change',"UPDATE public.v13_live_money_policy SET policy_hash=repeat('c',64)"],
 ] as const)await t.test(name+' during signed read refuses activation',async()=>{
 const b=await reset(),entered=deferred(),resume=deferred();const d={...deps,signedEvidence:((o:string)=>collectFinalReleaseEvidence(o,{db:pool,readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true,()=>entered.resolve(),resume.promise)) as never})) as never};
 const pending=activateOwnerSelfAccount(owner,b,d);await Promise.race([entered.promise,pending.then(r=>{throw Error('never reached signed read: '+JSON.stringify(r));})]);await pool.query(mutation);resume.resolve();assert.equal((await pending).ok,false);await untouched();
 });
 await t.test('V2 policy is refused, not relabeled by owner-self activation',async()=>{const b=await reset();await pool.query("UPDATE public.v13_live_money_policy SET fee_policy_version='strata_reviewed_api_fee_v2',fee_source_url='strata-api-fee-v2://synthetic'");const r=await activateOwnerSelfAccount(owner,b,deps);assert.equal(r.ok,false);assert.match(r.reason,/scope_required/);await untouched();});
 await t.test('unknown before COMMIT takes effect retains killed state and no retry authorization',async()=>{const b=await reset();const d=wrap(async(sql,args,c)=>{if(sql==='COMMIT')throw Error('injected disconnect before COMMIT');return c.query(sql,args);});const r=await activateOwnerSelfAccount(owner,b,d);assert.equal(r.ok,false);assert.equal(r.reason,'owner_self_activation_commit_outcome_unknown');await delay(50);await untouched();assert.equal((await ownerSelfActivationOutcome(owner,sha,pool)).outcome,'UNKNOWN');});

 for(const [name,mutation] of [
 ['revoked entry',"UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true"],
 ['changed publication',"UPDATE private.strata_durable_owner_fee_state SET known_publication_change=true"],
 ] as const)await t.test('qualification refuses '+name+' without a new receipt',async()=>{await reset();await pool.query(mutation);const before=(await pool.query('SELECT count(*) FROM private.strata_protective_release_qualification')).rows[0].count;const r=await qualifyProtectiveRelease(owner,{db:pool,sha:()=>sha,readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never,verifyDurableFee:stage as never});assert.equal(r.ok,false,JSON.stringify(r));assert.equal((await pool.query('SELECT count(*) FROM private.strata_protective_release_qualification')).rows[0].count,before);await untouched();});
 await t.test('qualification refuses unavailable fresh market metadata, no receipt',async()=>{await reset();const bad=async()=>verifyDurableOwnerFee(pool,{owner,account,sha,policyHash:hash},market,'ENTRY',{fetcher:async()=>new Response('{}',{status:503})});const before=(await pool.query('SELECT count(*) FROM private.strata_protective_release_qualification')).rows[0].count;const r=await qualifyProtectiveRelease(owner,{db:pool,sha:()=>sha,readFeeds:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never,verifyDurableFee:bad as never});assert.equal(r.ok,false);assert.equal((await pool.query('SELECT count(*) FROM private.strata_protective_release_qualification')).rows[0].count,before);await untouched();});
 await t.test('durable state revocation waits through activation COMMIT then blocks next fee proof',async()=>{const b=await reset(),entered=deferred(),resume=deferred();const d=wrap(async(sql,args,c)=>{if(sql==='COMMIT'){entered.resolve();await resume.promise;}return c.query(sql,args);});const pending=activateOwnerSelfAccount(owner,b,d);await Promise.race([entered.promise,pending.then(r=>{throw Error('did not reach commit '+JSON.stringify(r));})]);let revoked=false;const mutation=pool.query('UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true').then(()=>{revoked=true});await delay(100);assert.equal(revoked,false);resume.resolve();assert.equal((await pending).ok,true);await mutation;assert.equal(revoked,true);assert.equal((await stage()).ok,false);assert.equal((await state()).w.arm_requested,false);});
}finally{await pool.end();}});
