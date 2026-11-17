import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {verifyDurableOwnerFee}=require('../../artifacts/api-server/dist/durableOwnerFeePolicy.cjs');
import pg from '../../lib/db/node_modules/pg/lib/index.js';
const url=process.env.DURABLE_TEST_DATABASE_URL;assert.equal(url,'postgresql://agent@127.0.0.1:55483/durable_fee_disposable');
const pool=new pg.Pool({connectionString:url});
try{
 await pool.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;CREATE SCHEMA private;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,policy_id text,subaccount integer,exchange_index integer,fee_artifact_digest text);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,policy_hash text,state text,fee_source_url text,fee_policy_version text,fee_formula_version text);
 CREATE TABLE private.strata_railway_official_fee_capture_v5(capture_id bigint PRIMARY KEY,execution_account_id text,content_sha256 text,effective_date date,canonical_url text,source_kind text,captured_at timestamptz,expires_at timestamptz);
 INSERT INTO auth.users VALUES('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
 INSERT INTO public.v13_production_account VALUES('account','11111111-1111-4111-8111-111111111111','policy',1,2,repeat('c',64));
 INSERT INTO public.v13_live_money_policy VALUES('policy','account',repeat('b',64),'APPROVED','strata-durable-owner-fee://33333333-3333-4333-8333-333333333333','owner_approved_canonical_terms_v1','standard-quadratic-0.07-v1');
 INSERT INTO private.strata_railway_official_fee_capture_v5 VALUES(1,'account',repeat('c',64),'2026-07-07','https://kalshi.com/docs/kalshi-fee-schedule.pdf','railway_canonical_https_direct',now(),now()+interval '55 minutes');`);
 const schema=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
 const setup=await pool.connect();try{
  await assert.rejects(setup.query(schema.replace(/COMMIT;\s*$/,"SELECT 1/0; COMMIT;")),/division by zero/);
  await setup.query('ROLLBACK');assert.equal((await setup.query("SELECT to_regclass('private.strata_durable_owner_fee_model') AS t")).rows[0].t,null);
  assert.equal((await setup.query("SELECT count(*) FROM pg_trigger WHERE tgname='durable_capture_change_latch'")).rows[0].count,'0');
  await setup.query(schema);
  await assert.rejects(setup.query(schema),/already exists/);await setup.query('ROLLBACK');
  assert.notEqual((await setup.query("SELECT to_regclass('private.strata_durable_owner_fee_model') AS t")).rows[0].t,null);
 }finally{setup.release()}
 console.log('PASS atomic DDL rollback and duplicate migration fail-closed without partial effects');
 const insert=`INSERT INTO private.strata_durable_owner_fee_model VALUES($1,$2,'account',repeat('a',40),repeat('b',64),1,repeat('c',64),'owner_approved_canonical_terms_v1','standard-quadratic-0.07-v1','2026-07-07','I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',true,now())`;
 const id='33333333-3333-4333-8333-333333333333',owner='11111111-1111-4111-8111-111111111111';
 await assert.rejects(pool.query(insert,[id,'22222222-2222-4222-8222-222222222222']),/exact-owner capture/);console.log('PASS cross-owner capture denied');
 await pool.query(insert,[id,owner]);await pool.query('INSERT INTO private.strata_durable_owner_fee_state(model_id) VALUES($1)',[id]);
 await assert.rejects(pool.query('UPDATE private.strata_durable_owner_fee_model SET official_source_digest=repeat(\'d\',64)'),/immutable/);
 await assert.rejects(pool.query('DELETE FROM private.strata_durable_owner_fee_model'),/immutable/);console.log('PASS immutable source model');

 const {rows:dates}=await pool.query('SELECT effective_date,effective_date::text AS normalized FROM private.strata_durable_owner_fee_model');
 assert.ok(dates[0].effective_date instanceof Date);assert.equal(dates[0].normalized,'2026-07-07');
 const market='KXBTC15M-26OCT15T2200',at=Date.parse('2026-10-15T22:00:00Z');
 const pages={
 ['/markets/'+market]:{market:{ticker:market,event_ticker:market,status:'open',exchange_index:2,open_time:'2026-10-15T21:59:00Z',close_time:'2026-10-15T22:12:00Z',expiration_time:'2026-10-15T22:13:00Z',latest_expiration_time:'2026-10-15T22:13:00Z',expected_expiration_time:'2026-10-15T22:13:00Z'}},
 ['/events/'+market]:{event:{event_ticker:market,series_ticker:'KXBTC15M',fee_type_override:null,fee_multiplier_override:null}},
 '/series/KXBTC15M':{series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:1}},
 '/series/fee_changes?series_ticker=KXBTC15M&show_historical=false':{series_fee_change_arr:[],cursor:''},
 ['/events/fee_changes?event_ticker='+market+'&limit=100']:{event_fee_changes:[],cursor:''}};
 const scope={owner,account:'account',sha:'a'.repeat(40),policyHash:'b'.repeat(64)};
 const deps={clock:()=>at,fetcher:async url=>{assert.ok(String(url).startsWith('https://external-api.kalshi.com/trade-api/v2/'));return new Response(JSON.stringify(pages[String(url).replace('https://external-api.kalshi.com/trade-api/v2','')]??{}),{status:200,headers:{'content-type':'application/json'}})}};
 const tx=await pool.connect();try{await tx.query('BEGIN');const result=await verifyDurableOwnerFee(tx,scope,market,'ENTRY',deps);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.publicationKnownCurrent,false);await tx.query('ROLLBACK')}finally{tx.release()}
 console.log('PASS actual native verifier SELECT/DATE mapping + real market validator (mock HTTP)');
 for(const [column,value] of [['fee_source_url','wrong'],['fee_policy_version','wrong'],['fee_formula_version','wrong']]){
 const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query('UPDATE public.v13_live_money_policy SET '+column+'=$1',[value]);assert.equal((await verifyDurableOwnerFee(tx,scope,market,'ENTRY',deps)).ok,false);await tx.query('ROLLBACK')}finally{tx.release()}}
 console.log('PASS actual native verifier refuses source/version/formula mismatch');
 const a=await pool.connect(),b=await pool.connect();try{

 await a.query('BEGIN');await a.query('SELECT * FROM private.strata_durable_owner_fee_state FOR SHARE');
 let done=false;const change=b.query('UPDATE private.strata_durable_owner_fee_state SET known_publication_change=true').then(()=>done=true);
 await new Promise(r=>setTimeout(r,100));assert.equal(done,false);await a.query('COMMIT');await change;assert.equal(done,true);console.log('PASS concurrent change waits on final-share fence');
 }finally{a.release();b.release()}
 await assert.rejects(pool.query('UPDATE private.strata_durable_owner_fee_state SET known_publication_change=false'),/monotonic/);
 await pool.query('UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true');
 await assert.rejects(pool.query('UPDATE private.strata_durable_owner_fee_state SET entry_revoked=false'),/monotonic/);console.log('PASS sticky change/revocation');
 const monitorTx=await pool.connect();try{await monitorTx.query('BEGIN');await monitorTx.query("UPDATE private.strata_durable_owner_fee_state SET monitor_state='changed'");await monitorTx.query('ROLLBACK');assert.equal((await pool.query('SELECT monitor_state FROM private.strata_durable_owner_fee_state')).rows[0].monitor_state,'never_checked');console.log('PASS monitor rollback');}finally{monitorTx.release()}
 const acl=await pool.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('authenticated',oid,'SELECT') AS exposed FROM pg_class WHERE oid='private.strata_durable_owner_fee_model'::regclass");assert.equal(acl.rows[0].relrowsecurity,true);assert.equal(acl.rows[0].relforcerowsecurity,true);assert.equal(acl.rows[0].exposed,false);console.log('PASS private RLS and client ACL');
 console.log('PASS 9 native groups including actual verifier (synthetic prerequisite schema, not full V3 integration)');
}finally{await pool.end()}
