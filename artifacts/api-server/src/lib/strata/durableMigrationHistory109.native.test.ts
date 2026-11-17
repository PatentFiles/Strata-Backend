import {KalshiApiError} from '../kalshiAccountClient';
import {capitalCreditPreview,applyCapitalCredit,capitalCreditOutcome,cancelCapitalCredit,CREDIT_CONFIRM,CREDIT_CANCEL} from './capitalCreditRepair';
import {capitalCreditProof,scopeDigest,type CreditScope} from './capitalCreditProof';
import {reconciliationObservation} from '../v13-production/reconciliationObservation';
import {reauthorizeDurableFeeRelease,DURABLE_REAUTH_CONFIRM} from './durableFeeReauthorization';
import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
import {personalAccountSnapshot} from './personalExchangeRead';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {randomUUID} from 'node:crypto';
import {HISTORICAL_FEE_VERSION,HISTORICAL_BASELINE_ID,HISTORICAL_SOURCE_KIND,HISTORICAL_MIGRATION_CONFIRM,HISTORICAL_RISK_ACCEPTANCE} from './historicalOwnerFeeBaseline';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {createHash} from 'node:crypto';
import {migrateOwnedDurableFeePolicy,durableMigrationOutcome,DURABLE_MIGRATION_CONFIRM,DURABLE_PUBLICATION_RISK_ACCEPTANCE} from './durableFeeMigration';
import {getScopedKalshiJson} from '../kalshiAccountClient';
import {requestOwnedAccountActivation,REQUEST_OWNED_ACTIVATION_CONFIRMATION,reconcileOwnedSubaccountCash} from './personalAccountActivation';
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
const migrationBody=()=>({accountId:account,sourceKind:HISTORICAL_SOURCE_KIND,baselineId:HISTORICAL_BASELINE_ID,modelId:authority,expectedSha:sha,expectedPolicyId:legacyRow.id,expectedPolicyHash:legacyRow.policy_hash,expectedPolicyVersion:1,confirmation:HISTORICAL_MIGRATION_CONFIRM,riskAcceptance:HISTORICAL_RISK_ACCEPTANCE});
const migrationDeps={load:async()=>signer.material,db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account}),read:((m:typeof signer.material,at:number)=>signer.read(m,at,[],true)) as never};
async function noMigration(){const a=(await pool.query('SELECT policy_id,execution_enabled,kill_switch FROM public.v13_production_account')).rows[0];assert.equal(a.policy_id,legacyRow.id);assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);assert.equal((await pool.query('SELECT count(*) FROM private.strata_durable_owner_fee_model')).rows[0].count,'0');assert.equal((await pool.query("SELECT count(*) FROM public.v13_live_money_policy WHERE state='APPROVED'")).rows[0].count,'1');}
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
 await pool.query(`ALTER TABLE public.v13_production_intent ADD COLUMN evaluation_id text, ADD COLUMN crossing_key text, ADD COLUMN parent_id text, ADD COLUMN decision jsonb, ADD COLUMN policy_hash text, ADD COLUMN fee_fingerprint text, ADD COLUMN capability_digest text, ADD COLUMN market text, ADD COLUMN side text, ADD COLUMN cancel_attempted boolean, ADD COLUMN exit_fee_micros bigint, ADD COLUMN dispatch_at timestamptz;
 ALTER TABLE public.v13_production_event ADD COLUMN kind text, ADD COLUMN digest text, ADD COLUMN payload jsonb, ADD COLUMN occurred_at timestamptz;
 ALTER TABLE private.strata_emergency_exit_reservations ADD COLUMN owner_user_id uuid,ADD COLUMN client_order_id text,ADD COLUMN trading_authorized boolean,ADD COLUMN market_ticker text,ADD COLUMN reducing_side text,ADD COLUMN quantity_hundredths bigint,ADD COLUMN order_request_json text,ADD COLUMN order_digest text;
 ALTER TABLE public.v13_production_intent ADD FOREIGN KEY(account_id) REFERENCES public.v13_production_account(id);
 ALTER TABLE public.v13_production_observation ADD FOREIGN KEY(account_id) REFERENCES public.v13_production_account(id);
 ALTER TABLE public.v13_production_event ADD FOREIGN KEY(account_id) REFERENCES public.v13_production_account(id);
 ALTER TABLE private.strata_emergency_exit_reservations ADD FOREIGN KEY(execution_account_id) REFERENCES public.v13_production_account(id);
 ALTER TABLE public.v13_production_intent ADD CHECK (kind='ENTRY' AND evaluation_id IS NOT NULL AND crossing_key IS NOT NULL AND parent_id IS NULL OR kind='EXIT' AND parent_id IS NOT NULL);
 ALTER TABLE public.v13_production_intent ADD CHECK(reserved_micros>=0 AND exit_fee_micros>=0 AND filled_hundredths>=0);
 `);
 for(const f of ['sql/strata_protective_exit_release_private.sql','sql/strata_protective_exit_release_renewable.sql','sql/strata_in_app_protective_release_approval.sql',
 'sql/strata_owner_sha_approval.sql','lib/db/drizzle/0043_strata_continuous_execution_grants.sql','lib/db/owner-self-release/001_explicit_owner_authority.sql',
 'sql/held-consent-deadlines.sql','lib/db/drizzle/0036_owner_fee_v3_evidence.sql','lib/db/drizzle/0037_owner_v3_fee_authority.sql','lib/db/owner-self-release/002_owner_standing_fee_v1.sql','lib/db/owner-self-release/003_durable_owner_fee_v1.sql','lib/db/owner-self-release/004_durable_trigger_search_path.sql','lib/db/owner-self-release/005_durable_fee_release_authorization.sql'])await pool.query(readFileSync(root+'/'+f,'utf8'));
}
async function setup(){
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

const orders:any[]=[],fills:any[]=[],settlements:any[]=[];
async function seedHistory(){
 const at=Date.now(),fillAt=new Date(at-60000).toISOString(),settledAt=new Date(at-10000).toISOString();
 for(let n=0;n<109;n++){
 const posted=n<2,entry=n<40,id='history-'+n,ticker='KXBTC15M-HISTORY'+(posted?n:0),request={clientOrderId:'v13p-'+id,market:ticker,side:'YES',action:entry?'BUY':'SELL',reduceOnly:!entry,timeInForce:'IOC',contracts:2,limitMicros:500000};
 const decision=entry?{}:{ownedEvaluation:{source:{evaluated_at:new Date(at-40000).toISOString()}},policy:{maxQuoteAgeMs:5000}};
 await pool.query(`INSERT INTO public.v13_production_intent(id,account_id,request,decision,state,terminal,reserved_micros,exit_fee_micros,filled_hundredths,kind,market,side,parent_id,cancel_attempted,exchange_order_id,policy_hash,fee_fingerprint,capability_digest,client_order_id,dispatch_at,evaluation_id,crossing_key) VALUES($1,$2,$3,$4,$5,true,0,0,$6,$7,$8,'YES',$9,false,$10,$11,$11,$12,$13,$14,$15,$16)`,[id,account,request,decision,posted?'TERMINAL':'BLOCKED',posted?200:0,entry?'ENTRY':'EXIT',ticker,entry?null:'history-0',posted?'order-'+n:null,sourceDigest,digest({id,request,decision,policyHash:sourceDigest,fee:sourceDigest}),request.clientOrderId,entry?new Date(at-60000):null,entry?id:null,entry?id:null]);
 if(!posted){const payload=entry?{id,reason:'production_final_source_changed_or_expired'}:{id,reason:'production_prepared_exit_expired',reservationId:null,sourceAtMs:at-40000,maxQuoteAgeMs:5000,evidenceObservedAtMs:at-30000,ownedQuantityHundredths:'200'};await pool.query('INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,\'PROVEN_NOT_POSTED\',$3,$4)',['proof-'+n,account,payload,digest(payload)]);}
 else{
 orders.push({order_id:'order-'+n,client_order_id:request.clientOrderId,ticker,book_side:'bid',action:'buy',status:'executed',initial_count_fp:'2.00',fill_count_fp:'2.00',yes_price_dollars:'0.5000'});
 fills.push({order_id:'order-'+n,trade_id:'fill-'+n,ticker,count_fp:'2.00',yes_price_dollars:'0.5000',fee_cost:'0.0500',created_time:fillAt});
 settlements.push({ticker,yes_count_fp:'2.00',no_count_fp:'0.00',market_result:'yes',revenue:200,settled_time:settledAt});
 }
 }
 const history=await readNeverPostedReleaseHistory(pool,account,false,{expiredExitOwnerId:owner});assert.equal(history.requests.length,109);assert.equal(history.neverPosted.length,107);assert.equal(history.expectedRequests.length,2);
 const feeds=await read();const mapped=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:fingerprint},feeds as never,history.requests);assert.ok('identity'in mapped);if(!('identity'in mapped))throw Error(JSON.stringify(mapped));
 for(let n=0;n<2;n++){const f=mapped.fills[n],st=mapped.settlements.find(s=>s.market==='KXBTC15M-HISTORY'+n)??mapped.settlements[n];await pool.query(`INSERT INTO public.v13_production_event(account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at) VALUES($1,$2,$3,'FILL',$4,$5,-1050000,0,$6),($1,$7,$3,'SETTLEMENT',$8,$9,2000000,950000,$10)`,[account,'fill:fill-'+n,'history-'+n,digest(f),f,fillAt,'settlement:'+st.id,digest(st),st,settledAt]);await pool.query("INSERT INTO public.v13_production_position(id,account_id,market,side,quantity_hundredths,basis_micros,realized_pnl_micros) VALUES($1,$2,'KXBTC15M-HISTORY0','YES',0,0,950000)",['history-'+n,account]);}
 await pool.query('UPDATE public.v13_production_account SET initial_cash_micros=23100000');
}
const read=(complete=true,os=orders,at=Date.now())=>signer.read(signer.material,at,os,complete,undefined,undefined,undefined,fills,settlements);
const run=(extra:any={})=>migrateOwnedDurableFeePolicy(owner,{...migrationBody(),modelId:randomUUID()},{...migrationDeps,read:(_m:any,at:number)=>read(true,orders,at),...extra});
async function assertLateInsertBlocked(){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='100ms'");const payload={id:'history-2',reason:'late contradiction'};await assert.rejects(c.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES('late-proof',$1,'POST_ATTEMPT',$2,$3)",[account,payload,digest(payload)]),(e:any)=>e.code==='55P03');}finally{await c.query('ROLLBACK');c.release();}}
test('109 intent minimal-schema migration regression with real account foreign-key fences',async(t)=>{try{
 await schema();await setup();await seedHistory();
 await t.test('missing entry no-send receipt refuses atomically',async()=>{const row=(await pool.query("DELETE FROM public.v13_production_observation WHERE id='proof-2' RETURNING *")).rows[0];assert.equal((await run()).ok,false);await noMigration();const keys=Object.keys(row);await pool.query(`INSERT INTO public.v13_production_observation(${keys}) VALUES(${keys.map((_,i)=>'$'+(i+1))})`,Object.values(row));});
 await t.test('tampered exit receipt refuses atomically',async()=>{const row=(await pool.query("SELECT digest FROM public.v13_production_observation WHERE id='proof-40'")).rows[0];await pool.query("UPDATE public.v13_production_observation SET digest=repeat('0',64) WHERE id='proof-40'");assert.equal((await run()).ok,false);await noMigration();await pool.query("UPDATE public.v13_production_observation SET digest=$1 WHERE id='proof-40'",[row.digest]);});
 await t.test('missing archive refuses atomically',async()=>{const r=await run({read:(_m:any,at:number)=>read(false,orders,at)});assert.equal(r.ok,false);await noMigration();});
 await t.test('provider order contradicting no-send refuses',async()=>{const r=await run({read:(_m:any,at:number)=>read(true,[...orders,{...orders[0],order_id:'contradiction',client_order_id:'v13p-history-2'}],at)});assert.equal(r.ok,false);assert.equal(r.reason,'proven_never_posted_provider_record_conflict');await noMigration();});
 await t.test('missing provider fill remains unreconciled',async()=>{const r=await run({read:(_m:any,at:number)=>signer.read(signer.material,at,orders,true,undefined,undefined,undefined,fills.slice(0,1),settlements)});assert.equal(r.ok,false);assert.equal(r.reason,'authenticated_exchange_fills_unreconciled');await noMigration();});
 await t.test('unexpected provider order refuses',async()=>{const r=await run({read:(_m:any,at:number)=>read(true,[...orders,{...orders[0],order_id:'foreign',client_order_id:'foreign'}],at)});assert.equal(r.ok,false);await noMigration();});
 await t.test('concurrent valid receipt revision during signed network rejects locked digest',async()=>{const r=await run({read:async(_m:any,at:number)=>{await pool.query("UPDATE public.v13_production_observation SET observed_at=clock_timestamp() WHERE id='proof-2'");return read(true,orders,at);}});assert.equal(r.ok,false);assert.equal(r.reason,'financial_history_changed_during_migration');await noMigration();});
 await t.test('postwrite policy failure rolls all policy/model mutations back',async()=>{const db={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(s:string,a?:unknown[])=>{const r=await c.query(s,a);if(s.startsWith('INSERT INTO public.v13_live_money_policy')){await assertLateInsertBlocked();throw Error('synthetic rollback after policy write');}return r;}};}};const r=await run({db});assert.equal(r.ok,false);await noMigration();});
 await t.test('109 intents with 107 proven no-sends and two filled settled orders migrate',async()=>{let checked=false;const db={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(s:string,a?:unknown[])=>{const r=await c.query(s,a);if(s.startsWith('INSERT INTO public.v13_live_money_policy')){await assertLateInsertBlocked();checked=true;}return r;}};}};const r=await run({db});assert.equal(checked,true);assert.equal(r.ok,true,JSON.stringify(r));assert.equal((await pool.query('SELECT count(*) FROM public.v13_production_intent')).rows[0].count,'109');const st=await state();assert.equal(st.a.execution_enabled,false);assert.equal(st.a.kill_switch,true);assert.equal(st.w.arm_requested,false);});
 await t.test('retained109 migrated historical model explicitly reauthorizes exact new build without policy replacement',async()=>{
 const m=(await pool.query('SELECT * FROM private.strata_durable_owner_fee_model')).rows[0],newSha='d'.repeat(40);
 const before=await state();
 const result=await reauthorizeDurableFeeRelease(owner,{authorizationId:randomUUID(),accountId:account,modelId:m.model_id,originalSha:sha,expectedSha:newSha,policyHash:m.approved_policy_hash,sourceDigest,confirmation:DURABLE_REAUTH_CONFIRM,riskAcceptance:HISTORICAL_RISK_ACCEPTANCE},
 {...migrationDeps,sha:()=>newSha,read:(_m,at)=>read(true,orders,at),probe:()=>probeCurrentKalshiFeeApi(feed,Date.now,market)});
 assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(await state(),before);assert.equal((await pool.query('SELECT count(*) FROM public.v13_production_intent')).rows[0].count,'109');
 assert.equal((await locked(pool,{owner,account,sha:newSha,policyHash:m.approved_policy_hash},market,'ENTRY')).ok,true);
 });
 await t.test('retained109 signed provider credit repairs only capital, keeps real P&L and cannot double count',async(ct)=>{
  await pool.query('ALTER TABLE private.kalshi_owner_historical_funding ADD COLUMN exchange_transfer_id text;ALTER TABLE private.kalshi_owner_pilot_transfers ADD COLUMN verified_exchange_transfer_id text;CREATE TABLE private.kalshi_owner_topups(id uuid,owner_user_id uuid);CREATE TABLE private.kalshi_owner_topup_legs(topup_id uuid,exchange_transfer_id text)');
  await pool.query(readFileSync(root+'/lib/db/owner-self-release/006_capital_credit_repair.sql','utf8'));
  const history=await readNeverPostedReleaseHistory(pool,account,false,{expiredExitOwnerId:owner});const beforeRead=await read();const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:fingerprint},beforeRead as never,history.requests);assert.ok('identity'in snapshot);if(!('identity'in snapshot))throw Error('fixture');
  await pool.query("UPDATE public.v13_production_intent SET created_at=clock_timestamp()-interval '2 minutes' WHERE created_at IS NULL");
  const checkpoint={...snapshot,observedAtMs:Date.now()-2000};const receipt=reconciliationObservation(checkpoint);
  await pool.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES('capital-checkpoint',$1,'RECONCILIATION',$2,$3)",[account,receipt,digest(receipt)]);
  const transfer={transfer_id:'synthetic-capital-272',from_subaccount:0,to_subaccount:1,exchange_index:2,amount_cents:272,created_ts:Math.floor(Date.now()/1000)};
  await pool.query('UPDATE public.v13_production_account SET cash_micros=27720000');signer.setCashDollars('27.7200');
  const cd={...migrationDeps,read:(_m:typeof signer.material,at:number)=>read(true,orders,at),get:signer.transferGet([transfer])};
  await capitalCreditProof(owner,account,sha,cd);const preview=await capitalCreditPreview(owner,cd);assert.equal(preview.ok,true,JSON.stringify(preview));if(!preview.ok)throw Error('preview');
  const {ok,confirmation,observedAt,expiresAt,transferAttempted,tradingAuthorized,workerStarted,ordersSubmitted,retryAuthorized,...scope}=preview;
  const beforeEvents=(await pool.query('SELECT * FROM public.v13_production_event ORDER BY event_id')).rows,beforePositions=(await pool.query('SELECT * FROM public.v13_production_position ORDER BY id')).rows;
  await ct.test('capital diagnostic distinguishes typed provider refusal from local SQL failure without retry',async()=>{
   const provider=await capitalCreditPreview(owner,{...cd,get:async()=>{throw new KalshiApiError('HTTP_ERROR',403);}});assert.equal(provider.ok,false);if(!provider.ok){assert.equal(provider.reason,'capital_credit_refused');assert.ok('diagnostic'in provider);assert.deepEqual(provider.diagnostic,{stage:'transfer_history',failureCode:'capital_provider_read_failed',providerType:'HTTP_ERROR',providerStatus:403});}
   const db={...pool,query:async(sql:string,args?:unknown[])=>{if(sql.includes('UNION ALL SELECT 1 FROM private.kalshi_owner_pilot_transfers'))throw Object.assign(Error('private SQL secret'),{code:'42703'});return pool.query(sql,args);},connect:pool.connect.bind(pool)};
   const local=await capitalCreditPreview(owner,{...cd,db});assert.equal(local.ok,false);if(!local.ok){assert.ok('diagnostic'in local);assert.deepEqual(local.diagnostic,{stage:'receipt_registry',failureCode:'capital_internal_failure',sqlState:'42703'});}
  });
  const body=(repairId:string)=>({repairId,scope,confirmation:CREDIT_CONFIRM});
  const unchanged=async()=>assert.equal((await pool.query('SELECT initial_cash_micros::text FROM public.v13_production_account')).rows[0].initial_cash_micros,'23100000');
  const cancel=(repairId:string)=>cancelCapitalCredit(owner,{repairId,accountId:account,expectedSha:sha,confirmation:CREDIT_CANCEL,scope},pool);
  await ct.test('capital cancel before any POST creates immutable fence and preserves account',async()=>{
   const id=randomUUID();assert.equal((await cancel(id)).outcome,'REJECTED');assert.equal((await applyCapitalCredit(owner,body(id),cd)).ok,false);await unchanged();
  });
  await ct.test('capital partial provider archive and duplicate transfer evidence refuse without accounting changes',async()=>{
   const id=randomUUID();assert.equal((await applyCapitalCredit(owner,body(id),{...cd,read:(_m,at)=>read(false,orders,at)})).ok,false);assert.equal((await capitalCreditOutcome(owner,id,sha,pool)).outcome,'REJECTED');await unchanged();
   assert.equal((await capitalCreditPreview(owner,{...cd,get:signer.transferGet([transfer,transfer])})).ok,false);await unchanged();
  });
  await ct.test('capital pending cancellation fences late provider response',async()=>{
   const entered=deferred(),resume=deferred(),id=randomUUID();const applying=applyCapitalCredit(owner,body(id),{...cd,read:async(m,at)=>{entered.resolve();await resume.promise;return read(true,orders,at);}});await entered.promise;const {scopeDigest:oldDigest,...otherCore}=scope;const changedCore={...otherCore,accountRevision:String(BigInt(scope.accountRevision)+1n)},otherScope={...changedCore,scopeDigest:scopeDigest(changedCore)};
   assert.equal((await cancelCapitalCredit(owner,{repairId:id,accountId:account,expectedSha:sha,confirmation:CREDIT_CANCEL,scope:otherScope},pool)).outcome,'UNKNOWN');assert.equal((await capitalCreditOutcome(owner,id,sha,pool)).outcome,'UNKNOWN');
   assert.equal((await cancel(id)).outcome,'REJECTED');resume.resolve();assert.equal((await applying).ok,false);await unchanged();
  });
  await ct.test('capital post-update exception atomically rolls base and receipt back',async()=>{
   const id=randomUUID(),db={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{const r=await c.query(sql,args);if(sql.startsWith('UPDATE public.v13_production_account SET initial_cash_micros='))throw Error('synthetic postwrite failure');return r;}};}};
   assert.equal((await applyCapitalCredit(owner,body(id),{...cd,db})).ok,false);assert.equal((await capitalCreditOutcome(owner,id,sha,pool)).outcome,'REJECTED');await unchanged();
  });
  await ct.test('capital deferred commit deadline rejects stale signed proof without late credit',async()=>{
   const id=randomUUID(),db={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{if(sql==='COMMIT')await delay(15100);return c.query(sql,args);}};}};
   assert.equal((await applyCapitalCredit(owner,body(id),{...cd,db})).ok,false);assert.equal((await capitalCreditOutcome(owner,id,sha,pool)).outcome,'UNKNOWN');await unchanged();assert.equal((await cancel(id)).outcome,'REJECTED');
  });
  // A lost successful commit acknowledgment must be resolved by exact receipt,
  // never by retrying or canceling an already-recorded capital adjustment.
  const committing=deferred(),allowCommit=deferred();
  const lostAckDb={query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {release:c.release.bind(c),query:async(sql:string,args?:unknown[])=>{if(sql==='COMMIT'){committing.resolve();await allowCommit.promise;}const r=await c.query(sql,args);if(sql==='COMMIT')throw Error('synthetic lost commit ack');return r;}};}};
  const id=randomUUID(),applying=applyCapitalCredit(owner,body(id),{...cd,db:lostAckDb});await committing.promise;const cancelling=cancel(id);await delay(40);allowCommit.resolve();const result=await applying;assert.equal((await cancelling).outcome,'RECORDED');assert.equal(result.ok,false,JSON.stringify(result));
  assert.equal((await pool.query('SELECT initial_cash_micros::text FROM public.v13_production_account')).rows[0].initial_cash_micros,'25820000');
  assert.deepEqual((await pool.query('SELECT * FROM public.v13_production_event ORDER BY event_id')).rows,beforeEvents);assert.deepEqual((await pool.query('SELECT * FROM public.v13_production_position ORDER BY id')).rows,beforePositions);
  assert.equal((await capitalCreditOutcome(owner,id,sha,pool)).outcome,'RECORDED');assert.equal((await cancelCapitalCredit(owner,{repairId:id,accountId:account,expectedSha:sha,confirmation:CREDIT_CANCEL,scope},pool)).outcome,'RECORDED');
  const lateId=randomUUID();assert.equal((await cancel(lateId)).outcome,'REJECTED');assert.equal((await applyCapitalCredit(owner,body(lateId),cd)).ok,false);
  assert.equal((await applyCapitalCredit(owner,{repairId:randomUUID(),scope,confirmation:CREDIT_CONFIRM},cd)).ok,false);assert.equal((await capitalCreditPreview(owner,cd)).ok,false);
  await assert.rejects(pool.query('DELETE FROM private.strata_capital_credit_repair'));await untouched();
 });
 await t.test('no real network or trading',()=>assert.equal(unexpectedNetwork,0));
}finally{await pool.end();}});
