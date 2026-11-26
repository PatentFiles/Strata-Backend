import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {DURABLE_FEE_SOURCE_LOCK_SQL,verifyDurableOwnerFeeSource} from './durableOwnerFeePolicy';
assert.match(process.env.V13_DISPOSABLE_DATABASE_URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
after(()=>pool.end());
const owner='11111111-1111-4111-8111-111111111111',model='22222222-2222-4222-8222-222222222222',sha='a'.repeat(40),hash='b'.repeat(64),source='strata-durable-owner-fee://'+model;
test('native source scope requires exact current policy owner source release and preserves all locks',async()=>{
 const a=await pool.connect(),b=await pool.connect();
 try{
 await a.query(`CREATE SCHEMA IF NOT EXISTS private;
 DROP TABLE IF EXISTS public.v13_production_account CASCADE;
 DROP TABLE IF EXISTS public.v13_live_money_policy CASCADE;
 CREATE TABLE private.strata_durable_owner_fee_model(model_id uuid,owner_user_id uuid,execution_account_id text,release_commit_sha text,approved_policy_hash text,official_source_digest text,effective_date date,historical_baseline_id text,policy_version text,formula_version text);
 CREATE TABLE private.strata_durable_owner_fee_state(model_id uuid,known_publication_change boolean,monitor_state text,entry_revoked boolean);
 CREATE TABLE private.strata_durable_historical_baseline(baseline_id text,original_bytes bytea,content_sha256 text);
 CREATE TABLE private.strata_durable_fee_release_authorization(model_id uuid,owner_user_id uuid,execution_account_id text,original_release_sha text,release_commit_sha text,policy_hash text,source_digest text,state text);
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,policy_id text,subaccount int,exchange_index int,fee_artifact_digest text);
 CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text,fee_source_url text,fee_policy_version text,fee_formula_version text);`);
 await a.query("INSERT INTO private.strata_durable_owner_fee_model VALUES($1,$2,'account',$3,$4,'digest','2026-07-07',NULL,'version','formula')",[model,owner,sha,hash]);
 await a.query("INSERT INTO private.strata_durable_owner_fee_state VALUES($1,false,'never_checked',false)",[model]);
 await a.query("INSERT INTO public.v13_production_account VALUES('account',$1,'current',1,2,'digest')",[owner]);
 await a.query("INSERT INTO public.v13_live_money_policy VALUES('current','account',$1,'APPROVED',$2,'version','formula')",[hash,source]);
 const query=(args:unknown[])=>a.query(DURABLE_FEE_SOURCE_LOCK_SQL,args);
 assert.equal((await query([owner,'account',sha,source])).rows.length,1);
 for(const args of [[model,'account',sha,source],[owner,'foreign',sha,source],[owner,'account','f'.repeat(40),source],[owner,'account',sha,source.toUpperCase()],[owner,'account',sha,source+'x']])assert.equal((await query(args)).rows.length,0);
 await a.query("UPDATE public.v13_live_money_policy SET policy_hash='changed'");assert.equal((await query([owner,'account',sha,source])).rows.length,0);
 await a.query('UPDATE public.v13_live_money_policy SET policy_hash=$1',[hash]);
 await a.query('BEGIN');assert.equal((await query([owner,'account',sha,source])).rows.length,1);
 await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='100ms'");
 await assert.rejects(b.query('UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true'),(e:unknown)=>(e as {code:string}).code==='55P03');
 await b.query('ROLLBACK');await a.query('ROLLBACK');
 await b.query('UPDATE private.strata_durable_owner_fee_state SET entry_revoked=true');
 process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';let calls=0;
 const denied=await verifyDurableOwnerFeeSource(a,{owner,account:'account',sha},source,'KXBTC15M-FIXTURE','ENTRY',{fetcher:async()=>{calls++;throw Error('forbidden');}});
 assert.equal(denied.ok,false);assert.equal(denied.reason,'durable_fee_entry_consent_revoked');assert.equal(calls,0);
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
});
