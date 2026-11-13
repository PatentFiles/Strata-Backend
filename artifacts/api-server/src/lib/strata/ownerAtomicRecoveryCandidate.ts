import {consumeOwnerMachineAuthorityCandidate,assertConsumedMachineAuthorityFresh} from './ownerMachineAuthorityCandidate';
import {recoveryCredentialGuard,type RecoveryProviderIdentity} from './ownerRecoveryCredentialGuardCandidate';
import {ProductionLedger,type Account,HeldReconciliationCommitUncertain} from '../v13-production/ledger';
import type {Snapshot} from '../v13-production/types';
import type {Pool,PoolClient} from '@workspace/db';
import type {JWTVerifyGetKey} from 'jose';
import {createHeldOwnerConsentGuard} from './ownerHeldConsentGuardCandidate';
import {deployedGitSha} from './deployedGitSha';
type Scope=Parameters<typeof createHeldOwnerConsentGuard>[1]&{revision:string;expectedBlockedReason:string};
const denied=(status:string)=>({status,released:false,tradingAuthorized:false,armed:false});
/** Not mounted. No real issuer/writer qualification exists, so no DB connection. */
export async function recoverOwnerAtomicallyCandidate(_input:unknown){return denied('production_recovery_qualifications_missing');}
/** Explicit laboratory-only composition of real ledger and consent interfaces.
 * Synthetic authority is never accepted outside exact disposable server identity.
 * No endpoint calls this export. It cannot be enabled for production by a flag.
 */
export async function exerciseAtomicRecoveryInDisposable(input:{token:string;scope:Scope},deps:{db:Pool;supabaseUrl:string;keys:JWTVerifyGetKey;reader:(tx:PoolClient,a:Account)=>Promise<Snapshot>;providerIdentityReader?:(tx:PoolClient)=>Promise<RecoveryProviderIdentity>;authorityStoreFixture?:'machine_store'}){
 const s=Object.freeze({...input.scope});
 if(s.releaseSha!==deployedGitSha()||s.expectedBlockedReason!=='personal_exchange_history_unreconciled')return denied('scoped_recovery_release_or_reason_invalid');
 const ownerGuard=await createHeldOwnerConsentGuard(input.token,s,{...deps,enabled:true});
 const credentialGuard=recoveryCredentialGuard(s,deps.providerIdentityReader);
 const ledger=new ProductionLedger(deps.db,s.accountId),deadlineMs=Date.now()+5000;
 try{
 const receipt=await ledger.reconcileHeldReaderCandidate(s.revision,{now:Date.now,deadlineMs,
  lock:async(tx,a)=>{
   const env=await tx.query("SELECT current_database() AS db,inet_server_addr()::text AS address,inet_server_port() AS port");
   if(env.rows.length!==1||env.rows[0].db!=='compatible_disposable'||!['127.0.0.1','127.0.0.1/32'].includes(env.rows[0].address)||env.rows[0].port!==55461)throw Error('synthetic_database_required');
   if(a.id!==s.accountId||a.owner_user_id!==s.ownerId||a.execution_enabled!==false||a.kill_switch!==true||a.blocked_reason!==s.expectedBlockedReason)throw Error('stopped_scoped_account_required');
   await ownerGuard.lock(tx,{id:a.id,owner_user_id:a.owner_user_id});
   const l=await tx.query("SELECT state,account_kill FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE",[s.accountId,s.ownerId]);
   if(l.rows.length!==1||l.rows[0].state!=='killed'||l.rows[0].account_kill!==true)throw Error('killed_owner_lease_required');
   await credentialGuard.lock(tx);
  },
  beforeCommit:async(tx,a)=>{
   await ownerGuard.beforeCommit(tx);
   await credentialGuard.beforeCommit(tx);
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
   if(deps.authorityStoreFixture==='machine_store'){await assertConsumedMachineAuthorityFresh(tx,s.requestId);}else{
   const fresh=await tx.query('SELECT expires_at>clock_timestamp() AS fresh FROM private.synthetic_atomic_recovery_authority WHERE request_id=$1::uuid',[s.requestId]);if(fresh.rows[0]?.fresh!==true)throw Error('synthetic_authority_expired');
   }
  }
 },deps.reader,true);
 return {...denied('released_disarmed'),released:true,reconciliationReceiptId:receipt.receiptId};
 }catch(e){if(e instanceof HeldReconciliationCommitUncertain)return {...denied('outcome_unknown'),released:null,readbackRequired:true,retryAuthorized:false};return denied(e instanceof Error?e.message:'atomic_recovery_refused');}
}
