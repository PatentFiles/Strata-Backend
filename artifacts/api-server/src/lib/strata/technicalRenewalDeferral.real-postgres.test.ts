import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool as isolatedPool} from '@workspace/db';
import {resolve} from 'node:path';
import {checkContinuousBootstrap,checkContinuousEligibility,renewContinuousTechnicalLease,hasContinuousGrantHistory} from './continuousExecutionAuthorization';

// New isolated real-PG cluster only, credential-stripped disposable runner. Schema reset is local fixture setup.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;assert.ok(url&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url)&&url===process.env.DATABASE_URL,'explicit isolated local cluster only');
const owner='11111111-1111-4111-8111-111111111111';
const reviewer='22222222-2222-4222-8222-222222222222';
const grant='33333333-3333-4333-8333-333333333333';
const release='44444444-4444-4444-8444-444444444444';
const sha='a'.repeat(40),policy='b'.repeat(64);
test('standing grant SQL fails closed across revocation, restart, scope drift and expiry',async(t)=>{
 const pool=isolatedPool;
 const pg={query:(sql:string,args?:unknown[])=>pool.query(sql,args),exec:(sql:string)=>pool.query(sql),close:()=>pool.end()};
 const db=pool;
 await pg.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
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
  await pg.exec(readFileSync(resolve('../../docs/reviews/maintenance-hardening-20261028.sql'),'utf8'));
  const guard=(await pg.query("SELECT proconfig FROM pg_proc WHERE proname='strata_continuous_grant_guard'")).rows[0] as {proconfig:string[]};
  assert.ok(guard.proconfig.some(x=>x==='search_path=\"\"'));

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
  await t.test('source-priority reuse is scoped, strictly >20s, and never extends expiry or generation',async()=>{
   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '60 seconds'");
   const before=(await pg.query('SELECT observed_at,expires_at,generation FROM private.strata_continuous_execution_technical_lease')).rows;
   let reads=0;const ro={query:async(sql:string,args?:unknown[])=>{reads++;return pg.query(sql,args)},connect:async()=>{throw Error('no_rotation_allowed')}};
   const reused=await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:ro});assert.equal(reused.ok,true);assert.equal('earlyRotationDeferred' in reused&&reused.earlyRotationDeferred,true);assert.equal(reads,1);
   assert.deepEqual((await pg.query('SELECT observed_at,expires_at,generation FROM private.strata_continuous_execution_technical_lease')).rows,before);
   let rotationQueries=0;const counted={query:async(sql:string,args?:unknown[])=>{rotationQueries++;return pool.query(sql,args)},connect:async()=>{const c=await pool.connect();return{query:async(sql:string,args?:unknown[])=>{rotationQueries++;return c.query(sql,args)},release:()=>c.release()}}};
   assert.equal((await renewContinuousTechnicalLease(proof(),{db:counted})).ok,true);assert.equal(rotationQueries,11,'ordinary due rotation still performs all11 direct queries; scoped source reuse used1');
   console.log('TECHNICAL_RENEWAL_QUERY_PROOF',JSON.stringify({sourceReuseQueries:1,ordinaryDueRotationQueries:rotationQueries,productionMillisecondsProven:false}));

   assert.equal(await checkContinuousEligibility(db,owner,sha),true);
   for(const seconds of [20,0,-1]){await pg.exec(`UPDATE private.strata_continuous_execution_technical_lease SET observed_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()+interval '${seconds} seconds'`);assert.equal((await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:ro})).ok,false);}
   for(const seconds of [120,21]){await pg.exec(`UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '${seconds} seconds'`);const boundary=await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:ro});assert.equal(boundary.ok,true);assert.equal('earlyRotationDeferred' in boundary&&boundary.earlyRotationDeferred,true);}

   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET observed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '121 seconds'");const fresh=await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:ro});assert.equal(fresh.ok,true);assert.equal('earlyRotationDeferred' in fresh&&fresh.earlyRotationDeferred,false);
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
  });
  await t.test('delayed preliminary response cannot reuse stale signed proof or snapshot-time lease margin',async()=>{
   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '60 seconds'");
   const p=proof();let n=0;const delayed={query:(sql:string,args?:unknown[])=>pg.query(sql,args),connect:async()=>{throw Error('unexpectedrenewal')}};
   assert.equal((await renewContinuousTechnicalLease({...p,allowEarlyRotationDeferral:true},{db:delayed,now:()=>n++===0?p.observedAtMs+100:p.observedAtMs+15001})).ok,false);
   assert.equal((await renewContinuousTechnicalLease({...proof(),observedAtMs:Date.now()+10000,allowEarlyRotationDeferral:true},{db:delayed})).ok,false);
   // An old caller transaction's now() must not make an already-expired real
   // clock margin reusable. DB query explicitly checks clock_timestamp().
   const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_sleep(0.05)');await c.query("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=now()+interval '20.025 seconds'");const clocks=(await c.query("SELECT expires_at>now()+interval '20 seconds' AS old_clock_passes,expires_at>clock_timestamp()+interval '20 seconds' AS wall_clock_passes FROM private.strata_continuous_execution_technical_lease")).rows[0];assert.deepEqual(clocks,{old_clock_passes:true,wall_clock_passes:false});const out=await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:{query:(sql:string,args?:unknown[])=>c.query(sql,args),connect:async()=>{throw Error('no_reuse')}}});assert.equal(out.ok,false);await c.query('ROLLBACK');}finally{c.release();}
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
  });
  await t.test('locked120s current-proof decision uses fresh database clock after acquisition delay',async()=>{
   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '60 seconds'");
   const generation=(await pg.query('SELECT generation FROM private.strata_continuous_execution_technical_lease')).rows[0].generation;
   const delayed={query:async(sql:string,args?:unknown[])=>{const result=await pg.query(sql,args);assert.equal(result.rows.length,0);await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '120.025 seconds'");await pg.exec('SELECT pg_sleep(0.05)');return result;},connect:()=>pool.connect()};
   const result=await renewContinuousTechnicalLease(proof(),{db:delayed});assert.equal(result.ok,true);assert.equal(result.reason,'standing_short_technical_lease_renewed');assert.equal(BigInt((await pg.query('SELECT generation FROM private.strata_continuous_execution_technical_lease')).rows[0].generation),BigInt(generation)+1n);
  });
  await t.test('reuse is not authority across STOP, KILL, fence, cash, private exit or owner approval change',async()=>{
   for(const [change,restore] of [
    ['UPDATE private.kalshi_account_worker_lease SET arm_requested=false','UPDATE private.kalshi_account_worker_lease SET arm_requested=true'],
    ['UPDATE public.v13_production_account SET kill_switch=true','UPDATE public.v13_production_account SET kill_switch=false'],
    ['UPDATE private.kalshi_account_worker_lease SET fencing_token=8','UPDATE private.kalshi_account_worker_lease SET fencing_token=7'],
    ["UPDATE private.strata_owner_sha_approvals SET revoked_at=now()","UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL"],
   ]){await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '60 seconds'");assert.equal((await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db})).ok,true);await pg.exec(change);assert.equal(await checkContinuousEligibility(db,owner,sha),false);await pg.exec(restore);}
   const ro={query:(sql:string,args?:unknown[])=>pg.query(sql,args),connect:async()=>{throw Error('no_renewal')}};
   for(const drift of [{cashMicros:'1'},{fencingToken:'8'},{policyHash:'c'.repeat(64)},{accountId:'other'}])assert.equal((await renewContinuousTechnicalLease({...proof(),...drift,allowEarlyRotationDeferral:true},{db:ro})).ok,false);
   await pg.exec("INSERT INTO private.strata_emergency_exit_reservations VALUES('acct','UNKNOWN')");assert.equal((await renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:ro})).ok,false);await pg.exec('DELETE FROM private.strata_emergency_exit_reservations');
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
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
  await t.test('concurrent renewal after preliminary snapshot cannot be overwritten by deferred reuse',async()=>{
   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '60 seconds'");
   let read!:()=>void,releaseRead!:()=>void;const readDone=new Promise<void>(r=>read=r),hold=new Promise<void>(r=>releaseRead=r);
   const blocked={query:async(sql:string,args?:unknown[])=>{const result=await pg.query(sql,args);read();await hold;return result;},connect:async()=>{throw Error('unexpectedrotation')}};
   const reused=renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:blocked});await readDone;
   await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET observed_at=now(),expires_at=now()+interval '5 minutes',generation=generation+1");
   const renewed=(await pg.query('SELECT observed_at,expires_at,generation FROM private.strata_continuous_execution_technical_lease')).rows;releaseRead();assert.equal((await reused).ok,true);assert.deepEqual((await pg.query('SELECT observed_at,expires_at,generation FROM private.strata_continuous_execution_technical_lease')).rows,renewed);
   const normal=await renewContinuousTechnicalLease(proof(),{db});assert.equal(normal.ok,true);assert.equal('earlyRotationDeferred' in normal&&normal.earlyRotationDeferred,false);
  });
  await t.test('STOP, KILL, fence and revocation between preliminary read and return cannot authorize final entry',async()=>{
   for(const [change,restore] of [
    ['UPDATE private.kalshi_account_worker_lease SET arm_requested=false','UPDATE private.kalshi_account_worker_lease SET arm_requested=true'],
    ['UPDATE public.v13_production_account SET kill_switch=true','UPDATE public.v13_production_account SET kill_switch=false'],
    ['UPDATE private.kalshi_account_worker_lease SET fencing_token=8','UPDATE private.kalshi_account_worker_lease SET fencing_token=7'],
    ['UPDATE private.strata_owner_sha_approvals SET revoked_at=now()','UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL'],
   ]){
    await pg.exec("UPDATE private.strata_continuous_execution_technical_lease SET expires_at=clock_timestamp()+interval '60 seconds'");
    let read!:()=>void,releaseRead!:()=>void;const readDone=new Promise<void>(r=>read=r),hold=new Promise<void>(r=>releaseRead=r);
    const blocked={query:async(sql:string,args?:unknown[])=>{const result=await pg.query(sql,args);read();await hold;return result;},connect:async()=>{throw Error('unexpectedrotation')}};
    const reused=renewContinuousTechnicalLease({...proof(),allowEarlyRotationDeferral:true},{db:blocked});await readDone;await pg.exec(change);releaseRead();assert.equal((await reused).ok,true,'preliminary snapshot is not authority');assert.equal(await checkContinuousEligibility(db,owner,sha),false);await pg.exec(restore);
   }
   assert.equal((await renewContinuousTechnicalLease(proof(),{db})).ok,true);
  });
  await t.test('final shared authorization locks still serialize concurrent owner approval revocation',async()=>{
   const final=await pool.connect(),writer=await pool.connect();try{
    await final.query('BEGIN');assert.equal(await checkContinuousEligibility(final,owner,sha),true);
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");await assert.rejects(writer.query('UPDATE private.strata_owner_sha_approvals SET revoked_at=now()'),(e:any)=>e.code==='55P03');await writer.query('ROLLBACK');await final.query('COMMIT');
    await writer.query('UPDATE private.strata_owner_sha_approvals SET revoked_at=now()');assert.equal(await checkContinuousEligibility(db,owner,sha),false);await writer.query('UPDATE private.strata_owner_sha_approvals SET revoked_at=NULL');
   }finally{await final.query('ROLLBACK');await writer.query('ROLLBACK');final.release();writer.release();}
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
