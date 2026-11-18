import {readFileSync} from 'node:fs';
import {claimThroughOwnerBarrier,readOwnerBarrierOutcome} from './ownerAdmissionBarrierCandidate';
import assert from 'node:assert/strict';
import {pool as db} from '@workspace/db';
import {INSERT_LEASE_SQL,ARM_LEASE_SQL,ACQUIRE_LEASE_SQL,HOLD_LEASE_SQL,RELEASE_LEASE_SQL} from './accountScopedExecution';
import {releaseFailedStartLease} from './failedStartLeaseCleanup';
import {lockStopAccount,readStopExposure} from './stopExposure';
import {disarmWorkerLease} from './personalExecutionSupervisor';
const url=process.env.DATABASE_URL;if(url!=='postgresql://agent@127.0.0.1:55458/compatible_disposable')throw Error('disposable_only');
const owner='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',now=new Date().toISOString();
async function wait(pid:number){for(let i=0;i<100;i++){if((await db.query('SELECT cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n>0)return;await new Promise(r=>setTimeout(r,10));}throw Error('blocking_not_verified');}
(async()=>{try{
await db.query(`CREATE SCHEMA private;
CREATE TABLE v13_production_account(id text PRIMARY KEY,owner_user_id uuid);
CREATE TABLE v13_production_position(account_id text,quantity_hundredths bigint);
CREATE TABLE v13_production_intent(account_id text,exchange_order_id text,terminal boolean,state text,reserved_micros bigint);
CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text PRIMARY KEY,owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,holder_id text,fencing_token bigint,state text,heartbeat_at timestamptz,released_at timestamptz,account_kill boolean,arm_requested boolean,credential_fingerprint text,vault_secret_id uuid);`);
await db.query('INSERT INTO v13_production_account VALUES($1,$2)',['a',owner]);
await db.query(INSERT_LEASE_SQL,['a',owner,id,id,'old',1,'released',now,now,false,false,'fp',id]);
const acquire=async(c:any,holder:string)=>{await c.query(ARM_LEASE_SQL,['a',owner,'fp',id,now,id,id]);return c.query(ACQUIRE_LEASE_SQL,['a',holder,now,'fp',id,id,id,owner,now]);};
const a=await db.connect(),b=await db.connect();try{
await a.query('BEGIN');await a.query('SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE',['a']);assert.equal((await acquire(a,'first')).rows[0].fencing_token,'2');
const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
const stop=disarmWorkerLease({query:db.query.bind(db),connect:async()=>b} as any,owner,'a','STOP',now);await wait(pid);await a.query('COMMIT');assert.deepEqual(await stop,{entriesBlocked:true,managingExposure:false});
console.log('PASS actual supervisor STOP waits for adapter account lock then releases acquired lease');
}finally{await a.query('ROLLBACK');a.release();/* actual supervisor releases b */}
assert.equal((await acquire(db,'replacement')).rows[0].fencing_token,'4');
const before=(await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows;
assert.equal((await releaseFailedStartLease(db,{executionAccountId:'a',ownerUserId:owner,holderId:'first',fencingToken:2,now})).rows.length,0);
assert.deepEqual((await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows,before);
console.log('PASS actual delayed failed-start cleanup cannot release replacement holder/fence');
await db.query("INSERT INTO v13_production_position VALUES('a',1)");assert.deepEqual(await disarmWorkerLease(db,owner,'a','STOP',now),{entriesBlocked:true,managingExposure:true});const held=(await db.query('SELECT state,arm_requested FROM private.kalshi_account_worker_lease')).rows[0];assert.deepEqual(held,{state:'owned',arm_requested:false});
console.log('PASS actual STOP preserves owned protective manager with exposure while disarming entries');

// Isolated canonical control adapter, NOT production supervisor wiring.
await db.query('CREATE TABLE private.offline_control_head(account_id text PRIMARY KEY,sequence bigint,stopped boolean); INSERT INTO private.offline_control_head VALUES($$a$$,1,false)');
const controlledAcquire=async(expected:string,holder:string)=>{const c=await db.connect();try{
 await c.query('BEGIN');await c.query('SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE',['a']);
 const h=(await c.query('SELECT sequence::text sequence,stopped FROM private.offline_control_head WHERE account_id=$1 FOR UPDATE',['a'])).rows[0];
 if(h.sequence!==expected||h.stopped){await c.query('ROLLBACK');return 'superseded';}
 const acquired=await acquire(c,holder);if(acquired.rows.length!==1){await c.query('ROLLBACK');return 'lease_refused';}
 await c.query('COMMIT');return 'acquired';
 }finally{await c.query('ROLLBACK');c.release();}};
// Inject durable STOP head update on SAME transaction before real STOP COMMIT.
const stopWithHead={query:db.query.bind(db),connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
 if(sql==='COMMIT'){const h=await c.query("UPDATE private.offline_control_head SET sequence=sequence+1,stopped=true WHERE account_id='a' RETURNING account_id");if(h.rows.length!==1)throw Error('control_head_missing');}return c.query(sql,args);
 }};}};
await db.query('DELETE FROM v13_production_position');const captured='1';
assert.deepEqual(await disarmWorkerLease(stopWithHead as any,owner,'a','STOP',now),{entriesBlocked:true,managingExposure:false});
const stoppedLease=(await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows;
assert.equal(await controlledAcquire(captured,'stale'),'superseded');assert.deepEqual((await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows,stoppedLease);
assert.equal(await controlledAcquire('2','same-stop'),'superseded');
console.log('PASS actual STOP with adapter sequence update rejects old admission and stopped-current sequence without lease mutation');
// Fixture represents a NEW explicit owner admission after STOP, not an automatic
// STOP clear, MFA proof, or production authorization. No orders are possible here.
await db.query("UPDATE private.offline_control_head SET sequence=sequence+1,stopped=false WHERE account_id='a'");
assert.equal(await controlledAcquire('2','stale-after-new-command'),'superseded');
assert.equal(await controlledAcquire('3','fresh-command'),'acquired');
console.log('PASS separate synthetic new-owner-command sequence permits fresh admission; older sequence still refused');

let killPidResolve:(pid:number)=>void=()=>{};const killPid=new Promise<number>(resolve=>{killPidResolve=resolve;});
const killWithHead={query:async(sql:string,args?:unknown[])=>{
 if(!sql.includes('account-worker:kill'))throw Error('unexpected_adapter_query');
 const c=await db.connect();try{
  await c.query('BEGIN');killPidResolve((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  const account=(await c.query('SELECT id FROM v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[args![0],args![1]])).rows;
  if(account.length!==1){await c.query('ROLLBACK');return {rows:[]};}
  const head=await c.query('SELECT account_id FROM private.offline_control_head WHERE account_id=$1 FOR UPDATE',[args![0]]);if(head.rows.length!==1)throw Error('control_head_missing');
  const result=await c.query(sql,args);if(result.rows.length>1)throw Error('lease_ambiguous');{const h=await c.query('UPDATE private.offline_control_head SET sequence=sequence+1,stopped=true WHERE account_id=$1 RETURNING account_id',[args![0]]);if(h.rows.length!==1)throw Error('control_head_missing');}
  await c.query('COMMIT');return result;
 }finally{await c.query('ROLLBACK');c.release();}
}};
const blocker=await db.connect();try{
 await blocker.query('BEGIN');await blocker.query("SELECT id FROM v13_production_account WHERE id='a' FOR UPDATE");
 const kill=disarmWorkerLease(killWithHead,owner,'a','KILL',now);await wait(await killPid);await blocker.query('COMMIT');
 assert.deepEqual(await kill,{entriesBlocked:true,managingExposure:false});
 const killedLease=(await db.query('SELECT state,account_kill,arm_requested FROM private.kalshi_account_worker_lease')).rows[0];assert.deepEqual(killedLease,{state:'killed',account_kill:true,arm_requested:false});
 assert.equal(await controlledAcquire('3','stale-before-kill'),'superseded');
 const head=(await db.query('SELECT sequence::text sequence,stopped FROM private.offline_control_head')).rows;assert.deepEqual(head,[{sequence:'4',stopped:true}]);
 assert.deepEqual(await disarmWorkerLease(killWithHead,id,'a','KILL',now),{entriesBlocked:false,managingExposure:false});assert.deepEqual((await db.query('SELECT sequence::text sequence,stopped FROM private.offline_control_head')).rows,head);
 console.log('PASS actual KILL via adapter blocks on account lock, atomically fences head/lease, rejects stale admission and foreign owner');
}finally{await blocker.query('ROLLBACK');blocker.release();}

// Proposed STOP-intent adapter: no-op lease transitions still leave a tombstone.
const durableStop=async(fail=false)=>{const c=await db.connect();try{
 await c.query('BEGIN');await lockStopAccount(c,owner,'a');
 const head=await c.query("SELECT account_id FROM private.offline_control_head WHERE account_id='a' FOR UPDATE");if(head.rows.length!==1)throw Error('control_head_missing');
 const exposure=await readStopExposure(c,'a');
 const lease=(await c.query("SELECT state,owner_user_id::text owner,fencing_token::text fence,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id='a' FOR UPDATE")).rows;
 if(lease.length>1)throw Error('lease_ambiguous');
 if(lease.length){const w=lease[0];if(w.owner!==owner||! /^[1-9][0-9]*$/.test(w.fence)||typeof w.account_kill!=='boolean'||typeof w.arm_requested!=='boolean'||(w.state==='released'&&(w.account_kill||w.arm_requested))||(w.state==='killed'&&(!w.account_kill||w.arm_requested)))throw Error('lease_identity_or_terminal_state_invalid');}
 if(exposure&&(lease.length!==1||lease[0].state!=='owned'))throw Error('exposure_manager_unverified');
 if(lease[0]?.state==='owned'){
  const r=await c.query(exposure?HOLD_LEASE_SQL:RELEASE_LEASE_SQL,['a',owner,now]);if(r.rows.length!==1)throw Error('lease_transition_failed');
 }else if(lease.length&& !['released','killed'].includes(lease[0].state))throw Error('lease_state_unknown');
 if(fail)throw Error('injected_head_failure');
 const bumped=await c.query("UPDATE private.offline_control_head SET sequence=sequence+1,stopped=true WHERE account_id='a' RETURNING sequence");if(bumped.rows.length!==1)throw Error('control_head_missing');
 await c.query('COMMIT');return 'stopped';
 }catch(e){await c.query('ROLLBACK');return (e as Error).message;}finally{c.release();}};
await db.query("UPDATE private.kalshi_account_worker_lease SET state='released',account_kill=false,arm_requested=false");
let seq=Number((await db.query('SELECT sequence FROM private.offline_control_head')).rows[0].sequence);
assert.equal(await durableStop(),'stopped');assert.equal(Number((await db.query('SELECT sequence FROM private.offline_control_head')).rows[0].sequence),++seq);
await db.query('DELETE FROM private.kalshi_account_worker_lease');assert.equal(await durableStop(),'stopped');seq++;assert.equal(await durableStop(),'stopped');seq++;
assert.equal(await controlledAcquire(String(seq-1),'stale-no-lease'),'superseded');assert.equal((await db.query('SELECT count(*)::int n FROM private.kalshi_account_worker_lease')).rows[0].n,0);
console.log('PASS proposed STOP adapter writes tombstone for released, absent and repeated STOP; stale admission refuses');
await db.query(INSERT_LEASE_SQL,['a',owner,id,id,'rollback',10,'owned',now,now,false,true,'fp',id]);
const snapshot=async()=>({lease:(await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows,head:(await db.query('SELECT * FROM private.offline_control_head')).rows});
let beforeError=await snapshot();assert.equal(await durableStop(true),'injected_head_failure');assert.deepEqual(await snapshot(),beforeError);
await db.query('DELETE FROM private.offline_control_head');beforeError=await snapshot();assert.equal(await durableStop(),'control_head_missing');assert.deepEqual(await snapshot(),beforeError);
console.log('PASS proposed STOP adapter injected error/missing head rolls back without partial lease mutation');

await db.query("INSERT INTO private.offline_control_head VALUES('a',20,false); DELETE FROM private.kalshi_account_worker_lease");
assert.deepEqual(await disarmWorkerLease(killWithHead,owner,'a','KILL',now),{entriesBlocked:false,managingExposure:false});
assert.deepEqual((await db.query('SELECT sequence::text sequence,stopped FROM private.offline_control_head')).rows,[{sequence:'21',stopped:true}]);assert.equal(await controlledAcquire('20','pre-kill-no-lease'),'superseded');
console.log('PASS proposed KILL adapter persists tombstone without lease; legacy response does not falsely claim a killed worker');
await db.query(INSERT_LEASE_SQL,['a',owner,id,id,'bad-terminal',10,'released',now,now,false,false,'fp',id]);
for(const change of ["account_kill=true","arm_requested=true","fencing_token=0",`owner_user_id='${id}'`]){
 await db.query("UPDATE private.kalshi_account_worker_lease SET account_kill=false,arm_requested=false,fencing_token=10,owner_user_id=$1::uuid",[owner]);await db.query('UPDATE private.kalshi_account_worker_lease SET '+change);
 const frozen=await snapshot();assert.equal(await durableStop(),'lease_identity_or_terminal_state_invalid');assert.deepEqual(await snapshot(),frozen);
}
console.log('PASS proposed STOP adapter rejects malformed terminal kill/arm/fence/owner without mutation');

await db.query(`ALTER TABLE v13_production_account ADD COLUMN commissioned boolean DEFAULTtrue,ADD COLUMN execution_enabled boolean DEFAULTtrue,ADD COLUMN kill_switch boolean DEFAULTfalse,ADD COLUMN key_fingerprint text DEFAULT 'fp',ADD COLUMN blocked_reason text,ADD COLUMN policy_id text DEFAULT 'p',ADD COLUMN kalshi_connection_id uuid;
CREATE TABLE public.financial_accounts(id uuid,user_id uuid,provider text);CREATE TABLE private.provider_connections(id uuid,financial_account_id uuid);CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text,created_by text);CREATE TABLE private.kalshi_connection_credentials(owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,vault_secret_id uuid,role text,revoked_at timestamptz,verified_at timestamptz,key_fingerprint text);
CREATE TABLE private.strata_owner_control_heads(execution_account_id text,owner_user_id uuid,sequence bigint,stopped boolean);
CREATE TABLE private.strata_owner_consent_heads(execution_account_id text,owner_user_id uuid,generation bigint);`.replace(/DEFAULTtrue/g,'DEFAULT true').replace(/DEFAULTfalse/g,'DEFAULT false'));
await db.query('INSERT INTO private.strata_owner_control_heads VALUES($1,$2,30,false);',['a',owner]);await db.query('INSERT INTO private.strata_owner_consent_heads VALUES($1,$2,3)',['a',owner]);
await db.query("UPDATE private.kalshi_account_worker_lease SET owner_user_id=$1,state='released',fencing_token=50,account_kill=false,arm_requested=false",[owner]);
await db.query('UPDATE v13_production_account SET kalshi_connection_id=$1',[id]);await db.query('INSERT INTO public.financial_accounts VALUES($1,$2,$3)',[id,owner,'kalshi']);await db.query('INSERT INTO private.provider_connections VALUES($1,$1)',[id]);await db.query("INSERT INTO public.v13_live_money_policy VALUES('p','a','hash','APPROVED','11111111-1111-4111-8111-111111111111')");await db.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$2,$2,'restricted_execution',NULL,now(),'fp')",[owner,id]);
process.env.RAILWAY_GIT_COMMIT_SHA='a'.repeat(40);
await db.query(readFileSync('__STRATA_PROTECTED_FIXTURES__/admission-outcome-schema.sql','utf8'));
const input={releaseSha:'a'.repeat(40),policyHash:'hash',expectedFence:'50',challengeId:'challenge',evidenceId:'evidence',requestId:'request',ownerId:owner,accountId:'a',controlSequence:'30',consentGeneration:'3',holderId:'module',fingerprint:'fp',secretId:id,providerId:id,financialId:id,now,staleBefore:now};
assert.equal((await claimThroughOwnerBarrier({connect:async()=>{throw Error('must_not_connect');}},input)).reason,'owner_barrier_candidate_disabled');
assert.equal((await claimThroughOwnerBarrier(db,input,{enabled:true})).reason,'owner_barrier_proof_verifier_missing');
assert.equal((await claimThroughOwnerBarrier(db,{...input,consentGeneration:'2'},{enabled:true,verifyLocked:async()=>({ok:false})})).reason,'owner_barrier_consent_superseded');
const preClaim=(await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows;
assert.equal((await claimThroughOwnerBarrier(db,input,{enabled:true,verifyLocked:async()=>({ok:false})})).reason,'owner_barrier_fresh_scoped_proof_required');assert.deepEqual((await db.query('SELECT * FROM private.kalshi_account_worker_lease')).rows,preClaim);
for(const field of ['secretId','providerId','financialId','policyHash'] as const){const r=await claimThroughOwnerBarrier(db,{...input,[field]:field==='policyHash'?'wrong':owner},{enabled:true,verifyLocked:async()=>{throw Error('must_not_verify_bad_scope');}});assert.equal(r.reason,'owner_barrier_canonical_scope_mismatch');}
assert.equal((await claimThroughOwnerBarrier(db,{...input,expectedFence:'49'},{enabled:true,verifyLocked:async()=>({ok:false})})).reason,'owner_barrier_lease_scope_mismatch');
for(const field of ['releaseSha','challengeId','evidenceId','requestId','secretId'] as const){const r=await claimThroughOwnerBarrier(db,input,{enabled:true,verifyLocked:async()=>({ok:true,...input,[field]:'mismatch',validUntil:Date.now()+1000,consumedInTransaction:true})});assert.equal(r.reason,'owner_barrier_fresh_scoped_proof_required');}
for(const sql of ["UPDATE v13_production_account SET commissioned=false","UPDATE public.v13_live_money_policy SET state='REVOKED'",`UPDATE public.v13_live_money_policy SET created_by='${id}'`]){await db.query(sql);const r=await claimThroughOwnerBarrier(db,input,{enabled:true,verifyLocked:async()=>{throw Error('invalid_authority_reached_verifier');}});assert.equal(r.ok,false);await db.query("UPDATE v13_production_account SET commissioned=true; UPDATE public.v13_live_money_policy SET state='APPROVED',created_by='11111111-1111-4111-8111-111111111111'");}
assert.equal((await claimThroughOwnerBarrier(db,{...input,releaseSha:'b'.repeat(40)},{enabled:true,verifyLocked:async()=>({ok:false})})).reason,'owner_barrier_runtime_sha_mismatch');
await db.query(`INSERT INTO private.strata_owner_admission_evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,30,3,50,clock_timestamp()+interval '5 minutes',NULL)`,[input.evidenceId,input.challengeId,owner,'a',input.releaseSha,input.policyHash,input.fingerprint,id,id,id]);
let lostAckDiscard:Error|undefined;const lostAckDb={connect:async()=>{const c=await db.connect();return {release:(e?:Error)=>{lostAckDiscard=e;c.release(e);},query:async(sql:string,args?:unknown[])=>{const r=await c.query(sql,args);if(sql==='COMMIT')throw Error('synthetic_lost_commit_ack');return r;}};}};
const claimed=await claimThroughOwnerBarrier(lostAckDb,{...input,now:'untrusted-invalid-time',staleBefore:'untrusted-invalid-time'},{enabled:true,verifyLocked:async()=>({ok:true,...input,validUntil:Date.now()+1000,consumedInTransaction:true})});assert.equal(claimed.ok,false);assert.equal('uncertain'in claimed&&claimed.uncertain,true);assert.equal((await readOwnerBarrierOutcome(db,input)).status,'COMMITTED_HISTORICAL');assert.equal((await readOwnerBarrierOutcome(db,{...input,evidenceId:'wrong'})).status,'SCOPE_CONFLICT');assert.equal((await readOwnerBarrierOutcome(db,{...input,ownerId:id})).status,'NOT_OBSERVED');assert.equal((await db.query('SELECT count(*)::int n FROM private.strata_owner_admission_outcomes')).rows[0].n,1);

assert.equal(lostAckDiscard?.message,'owner_barrier_commit_outcome_unknown');
await db.query("UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=false");
const second={...input,evidenceId:'evidence2',requestId:'request2',expectedFence:'51'};
await db.query(`INSERT INTO private.strata_owner_admission_evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,30,3,51,clock_timestamp()+interval '5 minutes',NULL)`,[second.evidenceId,second.challengeId,owner,'a',second.releaseSha,second.policyHash,second.fingerprint,id,id,id]);
let beforeAckDiscard:Error|undefined;const beforeAckDb={connect:async()=>{const c=await db.connect();return {release:(e?:Error)=>{beforeAckDiscard=e;c.release(e);},query:async(sql:string,args?:unknown[])=>{if(sql==='COMMIT')throw Error('synthetic_before_commit_transport_loss');return c.query(sql,args);}};}};
const missing=await claimThroughOwnerBarrier(beforeAckDb,second,{enabled:true,verifyLocked:async()=>({ok:true,...second,validUntil:Date.now()+1000})});assert.equal(missing.ok,false);assert.equal('uncertain'in missing&&missing.uncertain,true);const absent=await readOwnerBarrierOutcome(db,second);assert.equal(absent.status,'NOT_OBSERVED');assert.equal(absent.retryAuthorized,false);assert.equal((await db.query('SELECT count(*)::int n FROM private.strata_owner_admission_outcomes')).rows[0].n,1);assert.equal((await db.query('SELECT fencing_token::text f FROM private.kalshi_account_worker_lease')).rows[0].f,'51');
assert.equal(beforeAckDiscard?.message,'owner_barrier_commit_outcome_unknown');
console.log('PASS durable outcome distinguishes committed lost-ack from absent rollback without authorizing retry or current trading');

const expiring={...second,evidenceId:'expiring-evidence',requestId:'expiring-request'};
await db.query(`INSERT INTO private.strata_owner_admission_evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,30,3,51,clock_timestamp()+interval '400 milliseconds',NULL)`,[expiring.evidenceId,expiring.challengeId,owner,'a',expiring.releaseSha,expiring.policyHash,expiring.fingerprint,id,id,id]);
const delayedDb={connect:async()=>{const c=await db.connect();return {release:(e?:Error)=>c.release(e),query:async(sql:string,args?:unknown[])=>{const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO private.strata_owner_admission_outcomes'))await c.query('SELECT pg_sleep(0.5)');return r;}};}};
const expired=await claimThroughOwnerBarrier(delayedDb,expiring,{enabled:true,verifyLocked:async()=>({ok:true,...expiring,validUntil:Date.now()+5000})});assert.equal(expired.ok,false);assert.equal(expired.reason,'owner_barrier_evidence_or_proof_expired_before_commit');assert.equal((await readOwnerBarrierOutcome(db,expiring)).status,'NOT_OBSERVED');assert.equal((await db.query('SELECT fencing_token::text f FROM private.kalshi_account_worker_lease')).rows[0].f,'51');
console.log('PASS schema-faithful text creator and DB evidence expiration after receipt insertion cause atomic rollback despite longer verifier deadline');
let discarded:Error|undefined;const broken={connect:async()=>({query:async(sql:string)=>{if(sql==='ROLLBACK')throw Error('rollback_transport_lost');return {rows:[]};},release:(e?:Error)=>{discarded=e;}})};
assert.equal((await claimThroughOwnerBarrier(broken,input,{enabled:true,verifyLocked:async()=>({ok:false})})).reason,'owner_barrier_account_not_ready');assert.equal(discarded?.message,'rollback_transport_lost');
console.log('PASS repo candidate module disabled/missing-verifier/stale-generation/proof-denial gates; synthetic verified claim uses real lease SQL without trading authority');
}finally{await db.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
