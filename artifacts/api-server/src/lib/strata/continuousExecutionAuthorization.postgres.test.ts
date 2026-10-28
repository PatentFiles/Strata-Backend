import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {checkContinuousBootstrap,checkContinuousEligibility,renewContinuousTechnicalLease,hasContinuousGrantHistory} from './continuousExecutionAuthorization';

// Embedded disposable PostgreSQL only. Never uses a connected DATABASE_URL.
const {PGlite}=createRequire(resolve('package.json'))('@electric-sql/pglite');
const owner='11111111-1111-4111-8111-111111111111';
const reviewer='22222222-2222-4222-8222-222222222222';
const grant='33333333-3333-4333-8333-333333333333';
const release='44444444-4444-4444-8444-444444444444';
const sha='a'.repeat(40),policy='b'.repeat(64);
test('standing grant SQL fails closed across revocation, restart, scope drift and expiry',async(t)=>{
 const pg=new PGlite();
 const db={query:(sql:string,args?:unknown[])=>pg.query(sql,args),
   connect:async()=>({query:(sql:string,args?:unknown[])=>pg.query(sql,args),release(){}})};
 try{
  await pg.exec(`
   CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
   CREATE SCHEMA auth; CREATE SCHEMA private;
   CREATE TABLE auth.users(id uuid PRIMARY KEY);
   CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,
    policy_id text,commissioned boolean,execution_enabled boolean,kill_switch boolean,
    blocked_reason text,cash_micros bigint);
   CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text);
   CREATE TABLE private.strata_owner_sha_approvals(owner_user_id uuid,execution_account_id text,
    release_commit_sha text,revoked_at timestamptz);
   CREATE TABLE private.strata_protective_exit_release(release_id uuid PRIMARY KEY,
    release_commit_sha text,state text,revoked_at timestamptz,created_at timestamptz,
    expires_at timestamptz,independent_reviewer_id uuid);
   CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,
    state text,arm_requested boolean,account_kill boolean,fencing_token bigint,heartbeat_at timestamptz);
   CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
   CREATE FUNCTION private.strata_protective_approval_audit_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
   INSERT INTO auth.users VALUES('${owner}'),('${reviewer}');
   INSERT INTO public.v13_production_account VALUES('acct','${owner}','p',true,true,false,NULL,25000000);
   INSERT INTO public.v13_live_money_policy VALUES('p','acct','${policy}','APPROVED');
   INSERT INTO private.strata_owner_sha_approvals VALUES('${owner}','acct','${sha}',NULL);
   INSERT INTO private.strata_protective_exit_release VALUES('${release}','${sha}','approved',NULL,
    now()-interval '1 minute',now()+interval '2 hours','${reviewer}');
   INSERT INTO private.kalshi_account_worker_lease VALUES('acct','${owner}','owned',true,false,7,now());
  `);
  await pg.exec(readFileSync(resolve('../../lib/db/drizzle/0043_strata_continuous_execution_grants.sql'),'utf8'));
  await pg.query(`INSERT INTO private.strata_standing_execution_reviews
   (release_id,owner_user_id,execution_account_id,release_commit_sha,policy_hash,independent_reviewer_id,
   qualification_id,evidence_digest,review_url,review_note,confirmation)
   VALUES($1,$2,'acct',$3,$4,$5,$1,$4,'https://github.com/PatentFiles/Strata-Backend/pull/246',repeat('review ',30),
   'I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1')`,
   [release,owner,sha,policy,reviewer]);
  await pg.query(`INSERT INTO private.strata_continuous_execution_grants
    (grant_id,owner_user_id,execution_account_id,release_commit_sha,policy_hash,reviewed_release_id,
     independent_reviewer_id,owner_confirmation) VALUES($1,$2,'acct',$3,$4,$5,$6,
     'I_AUTHORIZE_REVOCABLE_CONTINUOUS_EXECUTION_FOR_MY_REVIEWED_EXACT_SHA_V1')`,
    [grant,owner,sha,policy,release,reviewer]);
  const proof=()=>({ownerId:owner,accountId:'acct',releaseSha:sha,policyHash:policy,
    observedAtMs:Date.now()-100,cashMicros:'25000000',fencingToken:'7',authenticated:true,
    complete:true,unexplainedCashActivity:false,providerEvidence:{source:'isolated_fixture'}});
  await t.test('bootstrap never substitutes for signed technical evidence',async()=>{
   assert.equal(await checkContinuousBootstrap(db,owner,sha),true);
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
   assert.equal(await checkContinuousEligibility(db,owner,sha),true);
  });
  await t.test('current lease reuses one database read without opening a renewal transaction',async()=>{
   let reads=0;
   const readOnly={query:async(sql:string,args?:unknown[])=>{reads++;return pg.query(sql,args)},
     connect:async()=>{throw new Error('unexpected renewal transaction')}};
   assert.equal((await renewContinuousTechnicalLease(proof(),{db:readOnly})).ok,true);
   assert.equal(reads,1);
   for(const change of [{cashMicros:'1'},{fencingToken:'8'},{policyHash:'c'.repeat(64)},
       {accountId:'foreign'},{authenticated:false},{complete:false},{unexplainedCashActivity:true}]){
    assert.equal((await renewContinuousTechnicalLease({...proof(),...change},{db:readOnly})).ok,false);
   }
   await pg.exec("INSERT INTO private.strata_emergency_exit_reservations VALUES('acct','UNKNOWN')");
   assert.equal((await renewContinuousTechnicalLease(proof(),{db:readOnly})).ok,false);
   await pg.exec('DELETE FROM private.strata_emergency_exit_reservations');
   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=now()+interval '60 seconds'");
   assert.equal((await renewContinuousTechnicalLease(proof(),{db:readOnly})).ok,false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true,'approaching expiry still runs full signed renewal');
  });
  for(const [label,hold,restore] of [
   ['owner approval revoked',"UPDATE private.strata_owner_sha_approvals SET revoked_at=now()","UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL"],
   ['policy changed',"UPDATE public.v13_live_money_policy SET policy_hash=repeat('c',64)",`UPDATE public.v13_live_money_policy SET policy_hash='${policy}'`],
   ['account killed',"UPDATE public.v13_production_account SET kill_switch=true","UPDATE public.v13_production_account SET kill_switch=false"],
  ])await t.test(label,async()=>{
   await pg.exec(hold);
   assert.equal(await checkContinuousBootstrap(db,owner,sha),false);
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
   await pg.exec(restore);
  });
  await t.test('finite legacy review expiry does not expire a separately signed standing review',async()=>{
   await pg.exec("UPDATE private.strata_protective_exit_release SET expires_at=now()-interval '1 day'");
   assert.equal(await checkContinuousBootstrap(db,owner,sha),true);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
  });
  await t.test('wrong owner and changed SHA cannot borrow a grant',async()=>{
   for(const [who,version] of [[reviewer,sha],[owner,'c'.repeat(40)]]){
    assert.equal(await checkContinuousBootstrap(db,who,version),false);
    assert.equal(await checkContinuousEligibility(db,who,version),false);
   }
  });
  await t.test('worker restart invalidates old generation until new signed proof',async()=>{
   await pg.exec('UPDATE private.kalshi_account_worker_lease SET fencing_token=8');
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
   assert.equal((await renewContinuousTechnicalLease({...proof(),fencingToken:'8'},{db})).ok,true);
   assert.equal(await checkContinuousEligibility(db,owner,sha),true);
   await pg.exec('UPDATE private.kalshi_account_worker_lease SET fencing_token=7');
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
  });
  await t.test('STOP and stale heartbeat cannot retain entry eligibility',async()=>{
   await pg.exec('UPDATE private.kalshi_account_worker_lease SET arm_requested=false');
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
   await pg.exec("UPDATE private.kalshi_account_worker_lease SET arm_requested=true,heartbeat_at=now()-interval '1 minute'");
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
   await pg.exec('UPDATE private.kalshi_account_worker_lease SET heartbeat_at=now()');
  });
  await t.test('cash mismatch and unresolved exits cannot renew',async()=>{
   assert.equal((await renewContinuousTechnicalLease({...proof(),cashMicros:'1'},{db})).ok,false);
   await pg.exec("INSERT INTO private.strata_emergency_exit_reservations VALUES('acct','UNKNOWN')");
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
   await pg.exec('DELETE FROM private.strata_emergency_exit_reservations');
  });
  await t.test('grant scope and audit records cannot be rewritten',async()=>{
   await assert.rejects(pg.exec("UPDATE private.strata_continuous_execution_grants SET policy_hash=repeat('c',64)"));
   await assert.rejects(pg.exec('DELETE FROM private.strata_continuous_execution_grants'));
   await assert.rejects(pg.exec('DELETE FROM private.strata_continuous_execution_audit'));
   await assert.rejects(pg.exec('UPDATE private.strata_continuous_execution_grants SET revoked_at=now()'));
  });
  await t.test('standing review scope is immutable and explicit revocation blocks entries',async()=>{
   await assert.rejects(pg.exec("UPDATE private.strata_standing_execution_reviews SET policy_hash=repeat('c',64)"));
   await pg.exec("UPDATE private.strata_standing_execution_reviews SET revoked_at=now(),revocation_reason='reviewer_revoked'");
   assert.equal(await checkContinuousBootstrap(db,owner,sha),false);
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
  });
  await t.test('owner revocation is irreversible and blocks every permission path',async()=>{
   await pg.exec("UPDATE private.strata_continuous_execution_grants SET revoked_at=now(),revocation_reason='owner_revoked'");
   assert.equal(await hasContinuousGrantHistory(db,owner,sha),true,'revocation retains standing mode; no legacy fallback');
   assert.equal(await checkContinuousBootstrap(db,owner,sha),false);
   assert.equal(await checkContinuousEligibility(db,owner,sha),false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,false);
   await assert.rejects(pg.exec('UPDATE private.strata_continuous_execution_grants SET revoked_at=NULL,revocation_reason=NULL'));
  });
 }finally{await pg.close()}
});
