import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import pg from '../../lib/db/node_modules/pg/lib/index.js';
const require=createRequire(import.meta.url);const {enrollDurableOwnerFee,inspectDurableFeePublication,durableFeeEnrollmentOutcome}=require('../../artifacts/api-server/dist/durableFeeLifecycle.cjs');
assert.equal(process.env.DURABLE_TEST_DATABASE_URL,'postgresql://agent@127.0.0.1:55483/durable_fee_disposable');
const pool=new pg.Pool({connectionString:process.env.DURABLE_TEST_DATABASE_URL});
const owner='11111111-1111-4111-8111-111111111111',account='strata-account-aaaaaaaaaaaaaaaaaaaaaaaa',id='33333333-3333-4333-8333-333333333333',sha='a'.repeat(40),hash='b'.repeat(64);
const bytes=readFileSync('attached_assets/0_kalshi-fee-schedule_1790474920034.pdf'),digest=createHash('sha256').update(bytes).digest('hex');
const body={accountId:account,captureId:'1',confirmation:'I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',expectedSha:sha,modelId:id,policyHash:hash};
const deps={db:pool,sha:()=>sha,scope:()=>({ownerId:owner,accountId:account})};
async function reset(){
 await pool.query(`DROP SCHEMA IF EXISTS private CASCADE;DROP SCHEMA IF EXISTS auth CASCADE;
 DROP TABLE IF EXISTS public.v13_production_account,public.v13_live_money_policy CASCADE;
 CREATE SCHEMA private;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text,subaccount integer,exchange_index integer,fee_artifact_digest text,commissioned boolean,execution_enabled boolean,kill_switch boolean,reserved_micros bigint);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,policy_hash text,state text,fee_source_url text,fee_policy_version text,fee_formula_version text);
 CREATE TABLE private.strata_railway_official_fee_capture_v5(capture_id bigint PRIMARY KEY,execution_account_id text,content_sha256 text,effective_date date,canonical_url text,source_kind text,captured_at timestamptz,expires_at timestamptz,original_bytes bytea,byte_length integer,policy_version text);`);
 await pool.query('INSERT INTO auth.users VALUES($1)',[owner]);
 await pool.query("INSERT INTO public.v13_production_account VALUES($1,$2,'policy',1,2,$3,true,false,true,0)",[account,owner,digest]);
 await pool.query("INSERT INTO public.v13_live_money_policy VALUES('policy',$1,$2,'APPROVED',$3,'owner_approved_canonical_terms_v1','standard-quadratic-0.07-v1')",[account,hash,'strata-durable-owner-fee://'+id]);
 await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 VALUES(1,$1,$2,'2026-07-07','https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct',now(),now()+interval '55 minutes',$3,$4,'issuer_pdf_55m_signed_api_recheck_v2')",[account,digest,bytes,bytes.length]);
 await pool.query(readFileSync('docs/durable-fee/schema.sql','utf8'));
}
const count=async()=>Number((await pool.query('SELECT count(*) FROM private.strata_durable_owner_fee_model')).rows[0].count);
const wrapped=(hook)=>({...deps,db:{connect:async()=>{const c=await pool.connect();return{query:(s,a)=>hook(c,s,a),release:e=>c.release(e)}}}});
try{
 await reset();assert.equal((await enrollDurableOwnerFee(owner,body,deps)).ok,true);assert.equal(await count(),1);console.log('PASS real strict PDF enrollment transaction');
 const same=await inspectDurableFeePublication(id,{db:pool});assert.equal(same.ok,true);assert.equal(same.result,'unchanged');
 const changed=Buffer.concat([bytes,Buffer.from('\n')]),newDigest=createHash('sha256').update(changed).digest('hex');
 await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 SELECT 2,execution_account_id,$1,effective_date,canonical_url,source_kind,clock_timestamp(),clock_timestamp()+interval '55 minutes',$2,$3,policy_version FROM private.strata_railway_official_fee_capture_v5 WHERE capture_id=1",[newDigest,changed,changed.length]);
 assert.equal((await inspectDurableFeePublication(id,{db:pool})).result,'changed');
 await pool.query("UPDATE private.strata_railway_official_fee_capture_v5 SET expires_at=clock_timestamp()-interval '1 second'");
 assert.equal((await inspectDurableFeePublication(id,{db:pool})).result,'changed');
 assert.equal((await pool.query('SELECT known_publication_change FROM private.strata_durable_owner_fee_state')).rows[0].known_publication_change,true);
 await assert.rejects(pool.query('DELETE FROM private.strata_durable_fee_publication_observation'),/immutable/);console.log('PASS real monitor same/change/unavailable sticky audit');

 for(const expiredCapture of [false,true]){
 await reset();assert.equal((await enrollDurableOwnerFee(owner,body,deps)).ok,true);
 // Synthetic time advancement for expired-history regression, not current evidence.
 if(expiredCapture)await pool.query("UPDATE private.strata_railway_official_fee_capture_v5 SET captured_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '65 minutes'");
 await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 SELECT 2,execution_account_id,$1,effective_date,canonical_url,source_kind,clock_timestamp()-($4::boolean::int * interval '56 minutes'),clock_timestamp()+CASE WHEN $4 THEN interval '-1 minute' ELSE interval '55 minutes' END,$2,$3,policy_version FROM private.strata_railway_official_fee_capture_v5 WHERE capture_id=1",[newDigest,changed,changed.length,expiredCapture]);
 await pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 SELECT 3,execution_account_id,content_sha256,effective_date,canonical_url,source_kind,clock_timestamp(),clock_timestamp()+interval '55 minutes',original_bytes,byte_length,policy_version FROM private.strata_railway_official_fee_capture_v5 WHERE capture_id=1");
 assert.equal((await inspectDurableFeePublication(id,{db:pool})).result,'changed');
 assert.equal((await pool.query('SELECT known_publication_change FROM private.strata_durable_owner_fee_state')).rows[0].known_publication_change,true);
 assert.equal((await pool.query("SELECT count(*) FROM private.strata_durable_fee_publication_observation WHERE source_capture_id=2 AND result='changed'")).rows[0].count,'1');
 assert.equal((await inspectDurableFeePublication(id,{db:pool})).result,'changed');
 console.log('PASS unseen '+(expiredCapture?'expired ':'')+'change followed by revert is retained');
 }
 await reset();const both=await Promise.all([enrollDurableOwnerFee(owner,body,deps),enrollDurableOwnerFee(owner,body,deps)]);assert.equal(both.filter(x=>x.ok).length,1);assert.equal(await count(),1);console.log('PASS concurrent enrollment exactly one');
 await reset();const failed=await enrollDurableOwnerFee(owner,body,wrapped(async(c,s,a)=>{const r=await c.query(s,a);if(s.startsWith('INSERT INTO private.strata_durable_owner_fee_state'))throw Error('fault');return r}));assert.equal(failed.ok,false);assert.equal(await count(),0);console.log('PASS rollback after model/state insert');
 await reset();const unknown=await enrollDurableOwnerFee(owner,body,wrapped(async(c,s,a)=>{const r=await c.query(s,a);if(s==='COMMIT')throw Error('lost acknowledgement');return r}));assert.equal(unknown.reason,'durable_fee_commit_unknown');assert.equal(unknown.retryAuthorized,false);assert.equal(await count(),1);assert.equal((await durableFeeEnrollmentOutcome(owner,id,sha,pool)).outcome,'RECORDED');console.log('PASS lost COMMIT acknowledgement no retry + actual durable readback');
 await reset();await pool.query("UPDATE private.strata_railway_official_fee_capture_v5 SET expires_at=clock_timestamp()+interval '2 seconds'");const expired=await enrollDurableOwnerFee(owner,body,wrapped(async(c,s,a)=>{if(s==='COMMIT')await new Promise(r=>setTimeout(r,2100));return c.query(s,a)}));assert.equal(expired.ok,false);assert.equal(await count(),0);console.log('PASS deferred enrollment deadline rolls back at COMMIT');
 await reset();await pool.query("UPDATE private.strata_railway_official_fee_capture_v5 SET original_bytes=decode('badbad','hex')");assert.equal((await enrollDurableOwnerFee(owner,body,deps)).ok,false);assert.equal(await count(),0);console.log('PASS corrupted source never enrolls');
 await reset();assert.equal((await enrollDurableOwnerFee(owner,body,deps)).ok,true);await pool.query("UPDATE private.strata_railway_official_fee_capture_v5 SET original_bytes=decode('badbad','hex')");assert.equal((await inspectDurableFeePublication(id,{db:pool})).result,'invalid');assert.equal((await pool.query('SELECT known_publication_change FROM private.strata_durable_owner_fee_state')).rows[0].known_publication_change,true);console.log('PASS corrupted stored provenance latches entries closed');
 await reset();await pool.query('UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false');assert.equal((await enrollDurableOwnerFee(owner,body,deps)).ok,false);console.log('PASS live account enrollment refused');

 await reset();assert.equal((await enrollDurableOwnerFee(owner,body,deps)).ok,true);
 await pool.query(`ALTER TABLE public.v13_production_account ADD COLUMN kalshi_connection_id text,ADD COLUMN key_fingerprint text,ADD COLUMN cash_precision_verified boolean;
 UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false,kalshi_connection_id='connection',key_fingerprint=repeat('d',64),cash_precision_verified=true;
 CREATE TABLE public.live_execution_config(id text,live_execution_enabled boolean,manual_kill_switch boolean);
 INSERT INTO public.live_execution_config VALUES('singleton',true,false);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,financial_account_id text,credential_fingerprint text,state text,account_kill boolean,fencing_token bigint,holder_id text,heartbeat_at timestamptz);
 CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id text,key_fingerprint text,role text,revoked_at timestamptz,verified_at timestamptz,verification_reason text);`);
 await pool.query("INSERT INTO private.kalshi_account_worker_lease VALUES($1,$2,'connection',repeat('d',64),'owned',false,7,'holder',clock_timestamp())",[account,owner]);
 await pool.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,'connection',repeat('d',64),'restricted_execution',NULL,clock_timestamp(),'credential_verified')",[owner]);
 const {createGuardedDurableFeeFetch}=require('../../artifacts/api-server/dist/guardedDurableFeeWire.cjs');
 const {verifyDurableOwnerFee}=require('../../artifacts/api-server/dist/durableOwnerFeePolicy.cjs');
 const market='KXBTC15M-EXACT-TEST',clock=()=>Date.now(),isoOffset=ms=>new Date(Date.now()+ms).toISOString();
 const feed=async url=>{assert.ok(!String(url).includes('.pdf'));const path=String(url).replace('https://external-api.kalshi.com/trade-api/v2','');
 const pages={['/markets/'+market]:{market:{ticker:market,event_ticker:market,status:'open',exchange_index:2,open_time:isoOffset(-60000),close_time:isoOffset(600000),expiration_time:isoOffset(660000),latest_expiration_time:isoOffset(660000),expected_expiration_time:isoOffset(660000)}},
 ['/events/'+market]:{event:{event_ticker:market,series_ticker:'KXBTC15M',fee_type_override:null,fee_multiplier_override:null}},
 '/series/KXBTC15M':{series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:1}},
 '/series/fee_changes?series_ticker=KXBTC15M&show_historical=false':{series_fee_change_arr:[],cursor:''},
 ['/events/fee_changes?event_ticker='+market+'&limit=100']:{event_fee_changes:[],cursor:''}};
 return new Response(JSON.stringify(pages[path]??{}),{status:200,headers:{'content-type':'application/json'}})};
 const client=await pool.connect();let sends=0,enter,finish;
 const entered=new Promise(r=>enter=r),releaseSend=new Promise(r=>finish=r);
 const adapter=transport=>createGuardedDurableFeeFetch(owner,account,'strata-durable-owner-fee://'+id,transport,hash,'d'.repeat(64),7,'holder',digest,{borrowTransaction:()=>client,sha:()=>sha,
 currentStanding:async()=>true,hasHistory:async()=>true,exitReview:async()=>true,
 verifyDurable:(tx,scope,ticker,intent)=>verifyDurableOwnerFee(tx,scope,ticker,intent,{clock,fetcher:feed})});
 const order={ticker:market,subaccount:1,exchange_index:2,reduce_only:false,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,client_order_id:'v13p-'+id,side:'bid',count:'1.00',price:'0.2500'};
 const request=fee=>fee('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{method:'POST',body:JSON.stringify(order)});
 process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';
 try{
 await client.query('BEGIN');
 const send=request(adapter(async()=>{sends++;enter();await releaseSend;return new Response('{}',{status:200})}));
 await entered;let revoked=false;const revoke=pool.query('UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true').then(()=>revoked=true);
 await new Promise(r=>setTimeout(r,100));assert.equal(revoked,false);finish();await send;assert.equal(sends,1);assert.equal(revoked,false);await client.query('COMMIT');await revoke;
 console.log('PASS actual final-account+durable SQL holds revocation until transport and COMMIT');
 await client.query('BEGIN');await assert.rejects(request(adapter(async()=>{sends++;throw Error('must not send')})),/durable_fee_final_fresh_model_unverified/);assert.equal(sends,1);await client.query('ROLLBACK');
 console.log('PASS revoke-before-send blocks actual entry adapter');
 await client.query('BEGIN');order.reduce_only=true;await request(adapter(async()=>{sends++;return new Response('{}',{status:200})}));await client.query('COMMIT');assert.equal(sends,2);
 console.log('PASS entry consent revoked does not block independently reviewed exit fee adapter');
 await client.query('BEGIN');await assert.rejects(request(adapter(async()=>{sends++;throw Error('provider_unknown')})),/provider_unknown/);assert.equal(sends,3);await client.query('ROLLBACK');

 console.log('PASS one transport on unknown outcome, no internal retry');
 // A newly captured differing publication must serialize with held final
 // account/state locks even if the asynchronous inspector has not run.
 await client.query('BEGIN');let captureDone=false,enteredCapture,finishCapture;
 const captureSendEntered=new Promise(r=>enteredCapture=r),captureRelease=new Promise(r=>finishCapture=r);
 const lastSend=request(adapter(async()=>{sends++;enteredCapture();await captureRelease;return new Response('{}',{status:200})}));
 await captureSendEntered;
 const captured=pool.query("INSERT INTO private.strata_railway_official_fee_capture_v5 SELECT 4,execution_account_id,$1,effective_date,canonical_url,source_kind,clock_timestamp(),clock_timestamp()+interval '55 minutes',$2,$3,policy_version FROM private.strata_railway_official_fee_capture_v5 WHERE capture_id=1",[newDigest,changed,changed.length]).then(()=>captureDone=true);
 await new Promise(r=>setTimeout(r,100));assert.equal(captureDone,false);finishCapture();await lastSend;assert.equal(captureDone,false);await client.query('COMMIT');await captured;
 assert.equal((await pool.query('SELECT known_publication_change FROM private.strata_durable_owner_fee_state')).rows[0].known_publication_change,true);
 await client.query('BEGIN');const before=sends;await assert.rejects(request(adapter(async()=>{sends++;return new Response('{}')})),/durable_fee_final_fresh_model_unverified/);assert.equal(sends,before);await client.query('ROLLBACK');
 console.log('PASS actual capture change serializes with wire and blocks subsequent dispatch without monitor');

 }finally{client.release()}
 console.log('PASS 11 lifecycle +5 native wire groups; synthetic provider/technical authorization, real PDF/parser/SQL, no exchange orders');

}finally{await pool.end()}
