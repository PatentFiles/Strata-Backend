import {orderedOwnerReads} from './economicRecoveryReadBatch';
import {AsyncLocalStorage} from 'node:async_hooks';

/** Server-only context. A browser cannot create or override this fence. The
 * coordinator derives it from the authenticated owner and a durable attempt.
 * Existing fee, release and worker checks remain authoritative; this adds the
 * missing STOP/KILL cancellation boundary across their separate transactions. */
export type OwnerArmFence = Readonly<{
  ownerId: string;
  accountId: string;
  requestId: string;
  epoch: string;
  sha: string;
  phase: 'PREPARING' | 'STARTING';
}>;
export type ArmQuery = {
  query(sql: string, values?: unknown[]): Promise<{rows: Record<string, unknown>[]}>;
};
const context = new AsyncLocalStorage<OwnerArmFence>();
export const ownerArmFence = () => context.getStore();
export const withoutOwnerArmFence = <T>(work:()=>T):T => context.exit(work);
export const withOwnerArmFence = <T>(fence: OwnerArmFence, work: () => Promise<T>): Promise<T> =>
  context.run(Object.freeze({...fence}), work);

/** Call only inside the caller's write transaction. Lock account before the
 * attempt, matching begin/cancel/finish lock order. STOP increments the epoch;
 * even a delayed request on another API process then fails before committing.
 * No context means the existing independently-authorized path is unchanged. */
export async function assertOwnerArmFence(db: ArmQuery, owner: string, batch = false): Promise<void> {
  const fence = context.getStore();
  if (!fence) return;
  if (fence.ownerId !== owner) throw Error('owner_arm_scope_changed');
  const reads = await orderedOwnerReads(db,batch,[[`SELECT owner_control_epoch::text AS epoch
    FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,
    [fence.accountId, owner]], [`SELECT request_id FROM private.strata_owner_arm_attempt r
    WHERE request_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3
      AND control_epoch=$4::bigint AND release_commit_sha=$5 AND state=$6
      AND expires_at>clock_timestamp()
      AND ($6<>'STARTING' OR EXISTS(
        SELECT 1 FROM public.v13_production_account a
        JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
        JOIN public.strata_configured_stake s ON s.execution_account_id=a.id
        WHERE a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
          AND a.key_fingerprint=r.final_key_fingerprint AND a.fee_artifact_digest=r.final_fee_digest
          AND p.policy_hash=r.final_policy_hash AND p.state='APPROVED'
          AND s.configured_stake_cents=r.final_stake_cents AND a.execution_enabled=true
          AND a.kill_switch=false AND a.blocked_reason IS NULL)) FOR SHARE`,
    [fence.requestId, owner, fence.accountId, fence.epoch, fence.sha, fence.phase]]]);
  const account = await reads(0);
  if (account.rows.length !== 1 || account.rows[0].epoch !== fence.epoch)
    throw Error('owner_arm_interrupted');
  const attempt = await reads(1);
  if (attempt.rows.length !== 1) throw Error('owner_arm_expired_or_interrupted');
}

/** Runs inside the SAME account-first transaction as STOP/DISARM/KILL.
 * Its failure aborts that safety-state transaction; no successful stop response
 * can leave a still-valid in-flight preparation behind. */
export async function cancelOwnerArmInTransaction(db:ArmQuery,owner:string):Promise<void>{
  await db.query(`UPDATE public.v13_production_account SET owner_control_epoch=owner_control_epoch+1
    WHERE owner_user_id=$1::uuid`,[owner]);
}
