import {lockIndependentActivity} from './ownerUnknownRecoveryHeld';
import type {PoolClient} from '@workspace/db';
import type {Account} from '../v13-production/ledger';
import type {RecoveryHoldScope} from './unknownEntryRecoveryHold';
/** Server-created callback only. Never exported through a route or client API.
 * Account lock is owned by the native ledger before this function runs.
 */
export function createUnknownEntryHeldFence(input:RecoveryHoldScope){
 const s=Object.freeze({...input});
 const checkAccount=(a:Account)=>{
  if(a.id!==s.accountId||a.owner_user_id!==s.ownerId||a.key_fingerprint!==s.keyFingerprint||
     a.kill_switch!==false||a.execution_enabled!==true||a.commissioned!==true||
     Number(a.subaccount)!==1||Number(a.exchange_index)!==2)throw Error('held_recovery_account_changed');
 };
 return Object.freeze({
  async lock(tx:PoolClient,a:Account){
   checkAccount(a);
   const lease=await tx.query(`SELECT fencing_token::text FROM private.kalshi_account_worker_lease
    WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND holder_id=$3
     AND fencing_token=$4::bigint AND state='owned' AND account_kill=false AND arm_requested=false
     AND credential_fingerprint=$5 AND financial_account_id=$6::uuid AND provider_connection_id=$7::uuid
     AND vault_secret_id=$8::uuid AND heartbeat_at>clock_timestamp()-interval '5 seconds' FOR UPDATE`,
    [s.accountId,s.ownerId,s.holderId,s.fencingToken,s.keyFingerprint,s.financialAccountId,s.providerConnectionId,s.vaultSecretId]);
   if(lease.rows.length!==1||lease.rows[0].fencing_token!==s.fencingToken)throw Error('held_recovery_fence_changed');
   const metadata=await tx.query(`SELECT p.policy_hash FROM public.v13_production_account a
    JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
    JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=a.kalshi_connection_id
    JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
    JOIN private.provider_connections pc ON pc.id=c.provider_connection_id AND pc.financial_account_id=fa.id
    JOIN public.live_execution_config g ON g.id='singleton'
    WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND p.policy_hash=$3 AND p.state='APPROVED'
     AND c.key_fingerprint=$4 AND c.financial_account_id=$5::uuid AND c.provider_connection_id=$6::uuid
     AND c.vault_secret_id=$7::uuid AND c.role='restricted_execution' AND c.revoked_at IS NULL
     AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
     AND g.live_execution_enabled=true AND g.manual_kill_switch=false
    FOR SHARE OF p,c,fa,pc,g`,[s.accountId,s.ownerId,s.policyHash,s.keyFingerprint,s.financialAccountId,s.providerConnectionId,s.vaultSecretId]);
   if(metadata.rows.length!==1||metadata.rows[0].policy_hash!==s.policyHash)throw Error('held_recovery_metadata_changed');
   await lockIndependentActivity(tx,s.accountId);
   const active=await tx.query(`SELECT
    ((SELECT count(*) FROM private.strata_manual_profit_withdrawals WHERE execution_account_id=$1 AND state IN ('prepared','attempted','pending','uncertain'))+
     (SELECT count(*) FROM private.strata_auto_withdrawal_maintenance WHERE execution_account_id=$1 AND state<>'completed')+
     (SELECT count(*) FROM private.kalshi_owner_topups WHERE execution_account_id=$1 AND state='active')+
     (SELECT count(*) FROM private.kalshi_owner_pilot_transfers WHERE execution_account_id=$1 AND state<>'completed')+
     (SELECT count(*) FROM private.kalshi_owner_shard_allocations WHERE execution_account_id=$1 AND state<>'completed')+
     (SELECT count(*) FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')))::text AS n`,[s.accountId]);
   if(active.rows.length!==1||active.rows[0].n!=='0')throw Error('held_recovery_independent_activity_pending');
  },
  async beforeCommit(tx:PoolClient,a:Account){
   checkAccount(a);
   const fresh=await tx.query(`SELECT fencing_token::text FROM private.kalshi_account_worker_lease
    WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND holder_id=$3 AND fencing_token=$4::bigint
     AND state='owned' AND account_kill=false AND arm_requested=false
     AND heartbeat_at>clock_timestamp()-interval '5 seconds'`,[s.accountId,s.ownerId,s.holderId,s.fencingToken]);
   if(fresh.rows.length!==1||fresh.rows[0].fencing_token!==s.fencingToken)throw Error('held_recovery_final_lease_expired');
  },
 });
}
