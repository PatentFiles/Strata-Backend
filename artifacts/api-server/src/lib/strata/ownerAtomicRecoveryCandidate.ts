import {consumeOwnerMachineAuthorityCandidate,assertConsumedMachineAuthorityFresh} from './ownerMachineAuthorityCandidate';
import {recoveryCredentialGuard,type RecoveryProviderIdentity} from './ownerRecoveryCredentialGuardCandidate';
import {ProductionLedger,type Account,HeldReconciliationCommitUncertain} from '../v13-production/ledger';
import type {Snapshot} from '../v13-production/types';
import type {Pool,PoolClient} from '@workspace/db';
import type {JWTVerifyGetKey} from 'jose';
import {createHeldOwnerConsentGuard} from './ownerHeldConsentGuardCandidate';
import {verifySupabaseAccessToken} from './supabaseAuth';
import {readRetainedSnapshotUnderLock} from './ownerHeldRetainedSnapshotCandidate';
import {createRecoveryProviderIdentityReader} from './ownerRecoveryProviderIdentityCandidate';
import {deployedGitSha} from './deployedGitSha';
export type OwnerRecoveryScope=Parameters<typeof createHeldOwnerConsentGuard>[1]&{revision:string;expectedBlockedReason:string};
type Scope=OwnerRecoveryScope;
export type ProductionRecoveryDependencies={db:Pool;supabaseUrl:string;keys:JWTVerifyGetKey;
 /** Server-installed authentic issuer/deployment/role/barrier verifier. Must
  * reject missing, stale or revoked qualification while holding this client. */
 verifyLockedQualification:(tx:PoolClient,scope:Readonly<Scope>,phase:'lock'|'before_release'|'before_commit')=>Promise<void>};
const denied=(status:string)=>({status,released:false,tradingAuthorized:false,armed:false});
/** Production composition. No fixture authority, injected provider transport or
 * HTTP qualification flags. Bootstrap must install the authentic verifier. */
export async function recoverOwnerAtomicallyCandidate(input:unknown,deps?:ProductionRecoveryDependencies){
 if(!deps||typeof deps.verifyLockedQualification!=='function')return denied('production_recovery_qualifications_missing');
 const i=input as Record<string,unknown>;
 if(!i||typeof i!=='object'||Array.isArray(i)||Object.keys(i).length!==3||Object.keys(i).some(k=>!['token','accountId','requestId'].includes(k))||typeof i.token!=='string'||typeof i.accountId!=='string'||!i.accountId||i.accountId.length>200||typeof i.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(i.requestId))return denied('exact_owner_request_required');
 let ownerId:string;try{ownerId=(await verifySupabaseAccessToken(i.token,deps)).subject;}catch{return denied('current_owner_session_required');}
 let tx:PoolClient|undefined,scope:Scope|undefined,discard:Error|undefined;
 try{
  tx=await deps.db.connect();await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='1500ms'");
  // Caller supplies identifiers only. Every authority/consent scope value comes
  // from owner-bound durable records and is checked again under account lock.
  const r=await tx.query(`SELECT a.revision::text,c.release_sha,c.control_sequence::text,c.worker_fence::text,c.lease_consent_epoch::text,
   c.credential_fingerprint,c.policy_hash,c.machine_evidence_digest
   FROM public.v13_production_account a JOIN private.strata_owner_recovery_consent_receipt r ON r.account_id=a.id AND r.owner_id=a.owner_user_id
   JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id
   WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND r.request_id=$3::uuid LIMIT 2`,[i.accountId,ownerId,i.requestId]);
  if(r.rows.length!==1)throw Error('consent_scope_missing');const c=r.rows[0];
  scope={accountId:i.accountId,ownerId,requestId:i.requestId,revision:c.revision,releaseSha:c.release_sha,controlSequence:c.control_sequence,fence:c.worker_fence,epoch:c.lease_consent_epoch,credentialFingerprint:c.credential_fingerprint,policyHash:c.policy_hash,machineEvidenceDigest:c.machine_evidence_digest,expectedBlockedReason:'personal_exchange_history_unreconciled'};
  await tx.query('ROLLBACK');
 }catch{discard=Error('owner_recovery_scope_unavailable');if(tx)try{await tx.query('ROLLBACK');}catch{}return denied('owner_recovery_scope_unavailable');}finally{tx?.release(discard);}
 return runAtomicRecovery({token:i.token,scope:scope!},{...deps,reader:(tx,a)=>readRetainedSnapshotUnderLock(tx,a,ownerId),providerIdentityReader:createRecoveryProviderIdentityReader(scope!),authorityStoreFixture:'machine_store'},deps.verifyLockedQualification);
}
/** Explicit laboratory-only composition of real ledger and consent interfaces.
 * Synthetic authority is never accepted outside exact disposable server identity.
 * No endpoint calls this export. It cannot be enabled for production by a flag.
 */
export async function exerciseAtomicRecoveryInDisposable(input:{token:string;scope:Scope},deps:{db:Pool;supabaseUrl:string;keys:JWTVerifyGetKey;reader:(tx:PoolClient,a:Account)=>Promise<Snapshot>;providerIdentityReader?:(tx:PoolClient)=>Promise<RecoveryProviderIdentity>;authorityStoreFixture?:'machine_store'}){
 return runAtomicRecovery(input,deps);
}
async function runAtomicRecovery(input:Parameters<typeof exerciseAtomicRecoveryInDisposable>[0],deps:Parameters<typeof exerciseAtomicRecoveryInDisposable>[1],qualification?:ProductionRecoveryDependencies['verifyLockedQualification']){
 const s=Object.freeze({...input.scope});
 if(s.releaseSha!==deployedGitSha()||s.expectedBlockedReason!=='personal_exchange_history_unreconciled')return denied('scoped_recovery_release_or_reason_invalid');
 const ownerGuard=await createHeldOwnerConsentGuard(input.token,s,{...deps,enabled:true});
 const credentialGuard=recoveryCredentialGuard(s,deps.providerIdentityReader);
 const ledger=new ProductionLedger(deps.db,s.accountId),deadlineMs=Date.now()+5000;
 try{
 const receipt=await ledger.reconcileHeldReaderCandidate(s.revision,{now:Date.now,deadlineMs,
  lock:async(tx,a)=>{
   if(qualification){
    await qualification(tx,s,'lock');
    if(a.key_fingerprint!==s.credentialFingerprint||a.commissioned!==true)throw Error('commissioned_credential_scope_changed');
    const policy=await tx.query("SELECT policy_hash FROM public.v13_live_money_policy WHERE id=$1 AND execution_account_id=$2 AND created_by=$3 AND state='APPROVED' FOR SHARE",[a.policy_id,s.accountId,s.ownerId]);
    if(policy.rows.length!==1||policy.rows[0].policy_hash!==s.policyHash)throw Error('approved_policy_scope_changed');
   }else{
   const env=await tx.query("SELECT current_database() AS db,inet_server_addr()::text AS address,inet_server_port() AS port");
   if(env.rows.length!==1||env.rows[0].db!=='compatible_disposable'||!['127.0.0.1','127.0.0.1/32'].includes(env.rows[0].address)||env.rows[0].port!==55461)throw Error('synthetic_database_required');
   }
   if(a.id!==s.accountId||a.owner_user_id!==s.ownerId||a.execution_enabled!==false||a.kill_switch!==true||a.blocked_reason!==s.expectedBlockedReason)throw Error('stopped_scoped_account_required');
   await ownerGuard.lock(tx,{id:a.id,owner_user_id:a.owner_user_id});
   const l=await tx.query("SELECT state,account_kill FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE",[s.accountId,s.ownerId]);
   if(l.rows.length!==1||l.rows[0].state!=='killed'||l.rows[0].account_kill!==true)throw Error('killed_owner_lease_required');
   await credentialGuard.lock(tx);
  },
  beforeCommit:async(tx,a)=>{
   await ownerGuard.beforeCommit(tx);
   await credentialGuard.beforeCommit(tx);
   if(qualification)await qualification(tx,s,'before_release');
   // Full real reconciliation ran above under this same account lock. Require
   // flat result and no emergency UNKNOWN independently before release.
   const account=await tx.query('SELECT reserved_micros::text,blocked_reason,execution_enabled,kill_switch FROM v13_production_account WHERE id=$1',[s.accountId]);
   if(account.rows.length!==1||account.rows[0].reserved_micros!=='0'||account.rows[0].blocked_reason!==s.expectedBlockedReason||account.rows[0].execution_enabled!==false||account.rows[0].kill_switch!==true)throw Error('reconciled_account_not_releasable');
   const i=await tx.query("SELECT id FROM v13_production_intent WHERE account_id=$1 AND (terminal IS DISTINCT FROM true OR state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros IS NULL OR reserved_micros<>0) LIMIT 1",[s.accountId]);
   const p=await tx.query('SELECT id FROM v13_production_position WHERE account_id=$1 AND (quantity_hundredths IS NULL OR quantity_hundredths<>0) LIMIT 1',[s.accountId]);
   const e=await tx.query("SELECT reservation_id FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND (state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN')) LIMIT 1",[s.accountId]);
   if(i.rows.length||p.rows.length||e.rows.length)throw Error('exposure_or_outcome_unresolved');
   if(deps.authorityStoreFixture==='machine_store'){await consumeOwnerMachineAuthorityCandidate(tx,s);}else{
   const authority=await tx.query(`UPDATE private.synthetic_atomic_recovery_authority SET consumed_at=clock_timestamp()
    WHERE request_id=$1::uuid AND owner_id=$2::uuid AND account_id=$3 AND revision=$4::bigint
     AND release_sha=$5 AND machine_digest=$6 AND consumed_at IS NULL AND expires_at>clock_timestamp()
    RETURNING request_id`,[s.requestId,s.ownerId,s.accountId,s.revision,s.releaseSha,s.machineEvidenceDigest]);
   if(authority.rows.length!==1)throw Error('synthetic_scoped_authority_missing');
   }
   const l=await tx.query("UPDATE private.kalshi_account_worker_lease SET state='released',account_kill=false,arm_requested=false,fencing_token=fencing_token+1,released_at=clock_timestamp() WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND state='killed' AND account_kill=true AND arm_requested=false AND fencing_token=$3::bigint AND consent_epoch=$4::bigint RETURNING fencing_token::text",[s.accountId,s.ownerId,s.fence,s.epoch]);
   if(l.rows.length!==1)throw Error('owner_lease_changed');
   // Reconciliation already incremented revision. Do not issue a second revision.
   const changed=await tx.query('UPDATE v13_production_account SET kill_switch=false,blocked_reason=NULL WHERE id=$1 AND owner_user_id=$2::uuid AND execution_enabled=false AND kill_switch=true AND blocked_reason=$3 RETURNING id',[s.accountId,s.ownerId,s.expectedBlockedReason]);
   if(changed.rows.length!==1)throw Error('owner_account_changed');
   await tx.query('INSERT INTO private.strata_owner_recovery_release_receipt(request_id,account_id,owner_id,release_sha,authority_digest) VALUES($1::uuid,$2,$3::uuid,$4,$5)',[s.requestId,s.accountId,s.ownerId,s.releaseSha,s.machineEvidenceDigest]);
   await ownerGuard.beforeCommit(tx);
   await credentialGuard.beforeCommit(tx);
   if(qualification)await qualification(tx,s,'before_commit');
   if(deps.authorityStoreFixture==='machine_store'){await assertConsumedMachineAuthorityFresh(tx,s.requestId);}else{
   const fresh=await tx.query('SELECT expires_at>clock_timestamp() AS fresh FROM private.synthetic_atomic_recovery_authority WHERE request_id=$1::uuid',[s.requestId]);if(fresh.rows[0]?.fresh!==true)throw Error('synthetic_authority_expired');
   }
  }
 },deps.reader,true);
 return {...denied('released_disarmed'),released:true,reconciliationReceiptId:receipt.receiptId};
 }catch(e){if(e instanceof HeldReconciliationCommitUncertain)return {...denied('outcome_unknown'),released:null,readbackRequired:true,retryAuthorized:false};return denied(e instanceof Error?e.message:'atomic_recovery_refused');}
}
