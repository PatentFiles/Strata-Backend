import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {beginOwnerArm,finishOwnerArm,beginPreparedStart,readOwnerArmOutcome,armTransaction,blockOwnerArm} from './ownerArmStore';
import {withOwnerArmFence,assertOwnerArmFence,cancelOwnerArmInTransaction,ownerArmFence,withoutOwnerArmFence} from './ownerArmContext';
import {runOwnerArmStages,parseOwnerArmBody} from './ownerArmPreparation';
import {OWNER_ARM_CONFIRM} from './ownerArmScope';

const ownerA='11111111-1111-4111-8111-111111111111',ownerB='22222222-2222-4222-8222-222222222222';
const sha='a'.repeat(40),policy='b'.repeat(64),fee='c'.repeat(64),key='d'.repeat(64),digest='e'.repeat(64);
const rewrite=(sql:string)=>sql.replaceAll('public.','arm_public.').replaceAll('private.','arm_private.').replaceAll('auth.','arm_auth.');
const db={query:(sql:string,args?:unknown[])=>pool.query(rewrite(sql),args),connect:async()=>{
 const tx=await pool.connect();return {query:(sql:string,args?:unknown[])=>tx.query(rewrite(sql),args),release:(error?:Error)=>tx.release(error)};
}};

test('native owner preparation: two tenants, cancellation, duplicate requests, one-use START, unchanged scope and migration guards',async()=>{
 assert.ok(process.env.V13_DISPOSABLE_DATABASE_URL,'fresh local database required');
 try{
  await pool.query(`CREATE SCHEMA arm_public;CREATE SCHEMA arm_private;CREATE SCHEMA arm_auth;
   DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;END$$;
   CREATE TABLE arm_auth.users(id uuid PRIMARY KEY);
   CREATE TABLE arm_public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid NOT NULL,policy_id text,
    subaccount int DEFAULT 1,exchange_index int DEFAULT 2,execution_enabled boolean DEFAULT true,kill_switch boolean DEFAULT false,
    blocked_reason text,reserved_micros bigint DEFAULT 0,key_fingerprint text,fee_artifact_digest text);
   CREATE TABLE arm_public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,state text,policy_hash text);
   CREATE TABLE arm_public.strata_configured_stake(execution_account_id text PRIMARY KEY,configured_stake_cents int);
   CREATE TABLE arm_private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY,owner_user_id uuid,state text,
    account_kill boolean DEFAULT false,arm_requested boolean DEFAULT false);`);
  await db.query('INSERT INTO auth.users VALUES($1),($2)',[ownerA,ownerB]);
  for(const [owner,id] of [[ownerA,'account-a'],[ownerB,'account-b']]){
   await db.query(`INSERT INTO public.v13_production_account(id,owner_user_id,policy_id,key_fingerprint,fee_artifact_digest)
     VALUES($1,$2,$1,$3,$4)`,[id,owner,key,fee]);
   await db.query("INSERT INTO public.v13_live_money_policy VALUES($1,$1,'APPROVED',$2)",[id,policy]);
   await db.query('INSERT INTO public.strata_configured_stake VALUES($1,500)',[id]);
   await db.query("INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,state) VALUES($1,$2,'released')",[id,owner]);
  }
  const migration=readFileSync('../../supabase/migrations/20261125205247_owner_arm_preparation.sql','utf8');
  await db.query(migration);
  const input={owner:ownerA,account:'account-a',requestId:randomUUID(),scopeDigest:digest,sha,expectedEpoch:'0'};
  const fence=await beginOwnerArm(input,db);assert.ok(fence);
  assert.equal(await beginOwnerArm(input,db),null,'duplicate is readback, never another preparation');
  assert.equal((await readOwnerArmOutcome(ownerB,input.requestId,db)).ok,false,'foreign owner cannot read receipt');
  await assert.rejects(beginOwnerArm({...input,owner:ownerB,account:'account-b'},db),/scope_changed/);
  await assert.rejects(beginOwnerArm({...input,requestId:randomUUID(),expectedEpoch:'1'},db),/already_preparing/);
  await withOwnerArmFence(fence,()=>finishOwnerArm(fence,{policyHash:policy,feeDigest:fee,fingerprint:key,stakeCents:500},db));
  const ready=await readOwnerArmOutcome(ownerA,input.requestId,db);assert.ok(ready.ok&&ready.ready);
  const start=await beginPreparedStart(ownerA,input.requestId,sha,db);
  await withOwnerArmFence(start,()=>armTransaction(db,tx=>assertOwnerArmFence(tx,ownerA)));
  await assert.rejects(beginPreparedStart(ownerA,input.requestId,sha,db),/not_current/,'START receipt consumed once');
  await armTransaction(db,tx=>cancelOwnerArmInTransaction(tx,ownerA));
  await assert.rejects(withOwnerArmFence(start,()=>armTransaction(db,tx=>assertOwnerArmFence(tx,ownerA))),/interrupted/);
  assert.equal((await db.query('SELECT owner_control_epoch FROM public.v13_production_account WHERE id=$1',['account-b'])).rows[0].owner_control_epoch,'0');
  const interrupted=await readOwnerArmOutcome(ownerA,input.requestId,db);assert.ok(interrupted.ok&&interrupted.state==='INTERRUPTED');
  await assert.rejects(beginOwnerArm({...input,requestId:randomUUID(),expectedEpoch:'1'},db),/review_interrupted/,'delayed pre-STOP review cannot revive account');
  const second=await beginOwnerArm({...input,requestId:randomUUID(),expectedEpoch:'2'},db);assert.ok(second);
  await withOwnerArmFence(second,()=>finishOwnerArm(second,{policyHash:policy,feeDigest:fee,fingerprint:key,stakeCents:500},db));
  await db.query("UPDATE public.strata_configured_stake SET configured_stake_cents=1000 WHERE execution_account_id='account-a'");
  const changed=await readOwnerArmOutcome(ownerA,second.requestId,db);assert.ok(changed.ok&&!changed.ready);
  await assert.rejects(beginPreparedStart(ownerA,second.requestId,sha,db),/not_current/);
  await db.query("UPDATE public.strata_configured_stake SET configured_stake_cents=500 WHERE execution_account_id='account-a'");
  const third=await beginOwnerArm({...input,requestId:randomUUID(),expectedEpoch:'3'},db);assert.ok(third);
  await db.query("UPDATE private.strata_owner_arm_attempt SET expires_at=created_at+interval '1 microsecond' WHERE request_id=$1",[third.requestId]);
  const expired=await readOwnerArmOutcome(ownerA,third.requestId,db);assert.ok(expired.ok&&expired.state==='EXPIRED');
  await assert.rejects(beginPreparedStart(ownerA,second.requestId,sha,db),/not_current/);
  await assert.rejects(db.query('DELETE FROM private.strata_owner_arm_attempt WHERE request_id=$1',[input.requestId]),/history retained/);
  await assert.rejects(db.query('UPDATE private.strata_owner_arm_attempt SET owner_user_id=$1 WHERE request_id=$2',[ownerB,input.requestId]),/immutable scope/);
  const privileges=await pool.query("SELECT has_table_privilege('anon','arm_private.strata_owner_arm_attempt','SELECT') AS anon,has_table_privilege('authenticated','arm_private.strata_owner_arm_attempt','INSERT') AS browser");
  assert.deepEqual(privileges.rows[0],{anon:false,browser:false});
  const other=await beginOwnerArm({owner:ownerB,account:'account-b',requestId:randomUUID(),scopeDigest:digest,sha,expectedEpoch:'0'},db);assert.ok(other);
  const order:string[]=[];
  // Hold the account lock across an authority write while STOP waits. Whichever
  // transaction wins, no later write can resurrect the canceled preparation.
  const tx=await db.connect();await tx.query('BEGIN');
  await withOwnerArmFence(other,()=>assertOwnerArmFence(tx,ownerB));
  let canceled=false;
  const stopping=armTransaction(db,async c=>{await cancelOwnerArmInTransaction(c,ownerB);canceled=true;order.push('stop');});
  await new Promise(r=>setTimeout(r,30));assert.equal(canceled,false);
  order.push('authority');await tx.query('COMMIT');tx.release();await stopping;
  assert.deepEqual(order,['authority','stop']);
  await assert.rejects(withOwnerArmFence(other,()=>armTransaction(db,c=>assertOwnerArmFence(c,ownerB))),/interrupted/);
  await blockOwnerArm(other,'owner_arm_interrupted',db);
  await withOwnerArmFence(other,async()=>{
   assert.equal(ownerArmFence()?.ownerId,ownerB);
   await withoutOwnerArmFence(async()=>{await new Promise(r=>setTimeout(r,0));assert.equal(ownerArmFence(),undefined);});
   assert.equal(ownerArmFence()?.ownerId,ownerB);
  });
 }finally{await pool.query('DROP SCHEMA IF EXISTS arm_private CASCADE;DROP SCHEMA IF EXISTS arm_public CASCADE;DROP SCHEMA IF EXISTS arm_auth CASCADE');await pool.end();}
});

test('ARM orchestration is ordered, fail-closed, and has no START or transfer phase',async()=>{
 const sequence:string[]=[];
 await runOwnerArmStages({progress:async s=>{sequence.push(s)},hold:async()=>{},reconcile:async()=>({ok:true,reason:'ok'}),
  fee:async()=>{},qualify:async()=>({ok:true,reason:'ok'}),final:async()=>{sequence.push('ready')}});
 assert.deepEqual(sequence,['stopping_boundary','reconciling','fee_authorization','qualifying','final_checks','ready']);
 let afterFailure=false;
 await assert.rejects(runOwnerArmStages({progress:async()=>{},hold:async()=>{},reconcile:async()=>({ok:false,reason:'signed_cash_mismatch'}),
  fee:async()=>{afterFailure=true},qualify:async()=>({ok:true,reason:'ok'}),final:async()=>{afterFailure=true}}),/signed_cash_mismatch/);
 assert.equal(afterFailure,false);
 const valid={confirmation:OWNER_ARM_CONFIRM,requestId:randomUUID(),scopeDigest:digest};assert.ok(parseOwnerArmBody(valid));
 for(const extra of [{ownerId:ownerA},{accountId:'account-b'},{start:true},{skipReconciliation:true}])assert.equal(parseOwnerArmBody({...valid,...extra}),null);
});
