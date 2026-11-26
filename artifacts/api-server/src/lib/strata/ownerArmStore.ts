import {pool} from '@workspace/db';
import {assertOwnerArmFence, type ArmQuery, type OwnerArmFence} from './ownerArmContext';

export type ArmClient = ArmQuery & {release(error?: Error): void};
export type ArmDatabase = ArmQuery & {connect(): Promise<ArmClient>};
export const ARM_PREPARATION_MS = 180_000;
export const ARM_READY_MS = 15 * 60_000;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const HASH = /^[a-f0-9]{64}$/;
export const noTrading = {ordersSubmitted: false as const, workerStarted: false as const, transferAttempted: false as const};
export const armNo = (reason: string) => ({ok: false as const, version: 'OWNER_ARM_V1' as const, reason, ...noTrading});
export const safeArmReason = (error: unknown) => error instanceof Error && /^[a-z][a-z0-9_]{2,110}$/.test(error.message)
  ? error.message : 'owner_arm_outcome_unconfirmed';
export function requireArm(value: unknown, reason: string): asserts value {
  if (!value) throw Error(reason);
}

/** No transaction may report success after an ambiguous commit. Destroy that
 * connection rather than returning its unknown transaction to the pool. */
export async function armTransaction<T>(db: ArmDatabase, work: (tx: ArmClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  let committed = false, commitSent = false, discard: Error | undefined;
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='1500ms'");
    await tx.query("SET LOCAL statement_timeout='12000ms'");
    const value = await work(tx);
    commitSent = true;
    await tx.query('COMMIT');
    committed = true;
    return value;
  } catch (error) {
    if (commitSent) discard = Error('owner_arm_commit_unknown');
    throw error;
  } finally {
    if (!committed && !discard) try { await tx.query('ROLLBACK'); } catch { discard = Error('owner_arm_rollback_unknown'); }
    tx.release(discard);
  }
}

export async function ownerArmSchemaReady(db: ArmQuery = pool): Promise<boolean> {
  try {
    const found = await db.query(`SELECT to_regclass('private.strata_owner_arm_attempt') IS NOT NULL
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='v13_production_account' AND column_name='owner_control_epoch') AS ready`);
    return found.rows.length === 1 && found.rows[0].ready === true;
  } catch { return false; }
}

export async function readOwnerArmOutcome(owner: string, requestId: string, db: ArmQuery = pool) {
  if (!UUID.test(owner) || !UUID.test(requestId)) return armNo('owner_arm_request_invalid');
  try {
    const found = await db.query(`SELECT r.request_id::text,r.state,r.stage,r.reason,r.expires_at,
      r.release_commit_sha,r.final_policy_hash,r.final_fee_digest,r.final_stake_cents,st.configured_stake_cents,
      r.control_epoch=a.owner_control_epoch AS current_epoch,
      a.execution_enabled,a.kill_switch,a.blocked_reason,
      p.policy_hash,p.state AS policy_state,a.fee_artifact_digest,
      a.key_fingerprint=r.final_key_fingerprint AS current_key,
      w.state AS lease_state,w.account_kill,w.arm_requested
      FROM private.strata_owner_arm_attempt r
      JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
      JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
      JOIN public.strata_configured_stake st ON st.execution_account_id=a.id
      LEFT JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
      WHERE r.request_id=$1::uuid AND r.owner_user_id=$2::uuid`, [requestId, owner]);
    if (found.rows.length !== 1) return armNo('owner_arm_outcome_unavailable');
    const row = found.rows[0];
    let state = String(row.state), reason = String(row.reason);
    if (row.current_epoch !== true) { state = 'INTERRUPTED'; reason = 'owner_arm_interrupted_by_later_control'; }
    else if (['PREPARING','READY','STARTING'].includes(state) && Date.parse(String(row.expires_at)) <= Date.now()) {
      state = 'EXPIRED'; reason = 'owner_arm_preparation_expired';
    }
    const ready = state === 'READY' && row.execution_enabled === true && row.kill_switch === false &&
      row.blocked_reason === null && row.policy_state === 'APPROVED' && row.current_key === true &&
      row.final_policy_hash === row.policy_hash && row.final_fee_digest === row.fee_artifact_digest &&
      row.final_stake_cents === row.configured_stake_cents &&
      row.lease_state === 'released' && row.account_kill === false && row.arm_requested === false;
    if (state === 'READY' && !ready) { state = 'BLOCKED'; reason = 'owner_arm_account_changed'; }
    // STARTED is a recorded command outcome, not a claim that a worker is
    // still running. The dashboard reads its independent live worker status.
    return {ok: true as const, version: 'OWNER_ARM_V1' as const, requestId,
      state, stage: String(row.stage), reason, ready, releaseSha: String(row.release_commit_sha),
      expiresAt: new Date(String(row.expires_at)).toISOString()};
  } catch { return armNo('owner_arm_outcome_unavailable'); }
}

/** Request identity is caller-generated but authority is not. A duplicate ID
 * reads the same outcome, never repeats qualification or creates another grant.
 * Incrementing the account epoch fences older requests across tabs/processes. */
export async function beginOwnerArm(input: {
  owner: string; account: string; requestId: string; scopeDigest: string; sha: string; expectedEpoch:string;
}, db: ArmDatabase = pool): Promise<OwnerArmFence | null> {
  return armTransaction(db, async tx => {
    const account = await tx.query(`SELECT id,owner_control_epoch::text AS epoch
      FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE`, [input.account,input.owner]);
    requireArm(account.rows.length === 1, 'owner_arm_account_unavailable');
    const existing = await tx.query(`SELECT owner_user_id::text,scope_digest FROM private.strata_owner_arm_attempt
      WHERE request_id=$1::uuid`, [input.requestId]);
    if (existing.rows.length) {
      requireArm(existing.rows.length === 1 && existing.rows[0].owner_user_id === input.owner &&
        existing.rows[0].scope_digest === input.scopeDigest, 'owner_arm_request_scope_changed');
      return null;
    }
    requireArm(account.rows[0].epoch===input.expectedEpoch,'owner_arm_review_interrupted');
    const active = await tx.query(`SELECT request_id FROM private.strata_owner_arm_attempt
      WHERE execution_account_id=$1 AND state IN ('PREPARING','STARTING')
        AND expires_at>clock_timestamp() AND control_epoch=$2::bigint`, [input.account,account.rows[0].epoch]);
    requireArm(active.rows.length === 0, 'owner_arm_already_preparing');
    await tx.query(`UPDATE private.strata_owner_arm_attempt SET state='BLOCKED',stage='interrupted',
      reason='owner_arm_preparation_expired',updated_at=clock_timestamp()
      WHERE execution_account_id=$1 AND state IN ('PREPARING','STARTING')`, [input.account]);
    const next = await tx.query(`UPDATE public.v13_production_account SET owner_control_epoch=owner_control_epoch+1
      WHERE id=$1 AND owner_user_id=$2::uuid RETURNING owner_control_epoch::text AS epoch`, [input.account,input.owner]);
    requireArm(next.rows.length === 1, 'owner_arm_account_unavailable');
    const epoch = String(next.rows[0].epoch);
    await tx.query(`INSERT INTO private.strata_owner_arm_attempt
      (request_id,owner_user_id,execution_account_id,control_epoch,scope_digest,release_commit_sha,state,stage,reason,expires_at)
      VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5,$6,'PREPARING','account','owner_arm_preparing',
        clock_timestamp()+($7::int*interval '1 millisecond'))`,
      [input.requestId,input.owner,input.account,epoch,input.scopeDigest,input.sha,ARM_PREPARATION_MS]);
    return {ownerId:input.owner,accountId:input.account,requestId:input.requestId,epoch,sha:input.sha,phase:'PREPARING'};
  });
}

export async function ownerArmProgress(fence: OwnerArmFence, stage: string, db: ArmDatabase = pool) {
  return armTransaction(db, async tx => {
    await assertOwnerArmFence(tx,fence.ownerId);
    await tx.query(`UPDATE private.strata_owner_arm_attempt SET stage=$3,updated_at=clock_timestamp()
      WHERE request_id=$1::uuid AND owner_user_id=$2::uuid AND state='PREPARING'`, [fence.requestId,fence.ownerId,stage]);
  });
}

export async function blockOwnerArm(fence: OwnerArmFence, reason: string, db: ArmQuery = pool) {
  // This can only close an existing attempt. It cannot authorize or restart.
  await db.query(`UPDATE private.strata_owner_arm_attempt SET state='BLOCKED',reason=$3,updated_at=clock_timestamp()
    WHERE request_id=$1::uuid AND owner_user_id=$2::uuid AND state IN ('PREPARING','STARTING')`,
    [fence.requestId,fence.ownerId,reason]);
}

export async function finishOwnerArm(fence: OwnerArmFence, expected: {policyHash:string;feeDigest:string;fingerprint:string;stakeCents:number}, db: ArmDatabase = pool) {
  return armTransaction(db, async tx => {
    await assertOwnerArmFence(tx,fence.ownerId);
    const current = await tx.query(`SELECT a.id FROM public.v13_production_account a
      JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
      JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
      WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND p.policy_hash=$3 AND p.state='APPROVED'
        AND a.fee_artifact_digest=$4 AND a.key_fingerprint=$5 AND a.execution_enabled=true
        AND a.kill_switch=false AND a.blocked_reason IS NULL AND a.reserved_micros=0
        AND EXISTS(SELECT 1 FROM public.strata_configured_stake st WHERE st.execution_account_id=a.id AND st.configured_stake_cents=$6)
        AND w.state='released' AND w.account_kill=false AND w.arm_requested=false
      FOR SHARE OF p,w`, [fence.accountId,fence.ownerId,expected.policyHash,expected.feeDigest,expected.fingerprint,expected.stakeCents]);
    requireArm(current.rows.length === 1, 'owner_arm_final_readback_failed');
    await tx.query(`UPDATE private.strata_owner_arm_attempt SET state='READY',stage='ready',
      reason='account_armed_ready_for_start',final_policy_hash=$3,final_fee_digest=$4,final_key_fingerprint=$5,final_stake_cents=$6,
      expires_at=clock_timestamp()+($7::int*interval '1 millisecond'),updated_at=clock_timestamp()
      WHERE request_id=$1::uuid AND owner_user_id=$2::uuid AND state='PREPARING'`,
      [fence.requestId,fence.ownerId,expected.policyHash,expected.feeDigest,expected.fingerprint,expected.stakeCents,ARM_READY_MS]);
  });
}

export async function beginPreparedStart(owner: string, requestId: string, sha: string, db: ArmDatabase = pool): Promise<OwnerArmFence> {
  requireArm(UUID.test(requestId), 'owner_arm_required');
  return armTransaction(db, async tx => {
    const a = await tx.query(`SELECT id,owner_control_epoch::text AS epoch FROM public.v13_production_account
      WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE`, [owner]);
    requireArm(a.rows.length === 1, 'owner_arm_account_unavailable');
    const r = await tx.query(`UPDATE private.strata_owner_arm_attempt r SET state='STARTING',stage='start_checks',
      reason='owner_start_verifying',expires_at=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
      FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id
      WHERE r.request_id=$1::uuid AND r.owner_user_id=$2::uuid AND r.execution_account_id=a.id
        AND a.owner_user_id=r.owner_user_id AND a.id=$3 AND a.owner_control_epoch=r.control_epoch
        AND r.release_commit_sha=$4 AND r.state='READY' AND r.expires_at>clock_timestamp()
        AND r.final_policy_hash=p.policy_hash AND p.state='APPROVED'
        AND r.final_fee_digest=a.fee_artifact_digest AND r.final_key_fingerprint=a.key_fingerprint
        AND EXISTS(SELECT 1 FROM public.strata_configured_stake st WHERE st.execution_account_id=a.id AND st.configured_stake_cents=r.final_stake_cents)
        AND a.execution_enabled=true AND a.kill_switch=false AND a.blocked_reason IS NULL
      RETURNING r.control_epoch::text AS epoch`, [requestId,owner,a.rows[0].id,sha]);
    requireArm(r.rows.length === 1, 'owner_arm_not_current_or_start_already_requested');
    return {ownerId:owner,accountId:String(a.rows[0].id),requestId,epoch:String(r.rows[0].epoch),sha,phase:'STARTING'};
  });
}

/** Latest server record for this owner. Reloading a page never resubmits a
 * command, and another tab can discover the same in-progress preparation. */
export async function readCurrentOwnerArm(owner:string,db:ArmQuery=pool) {
  if(!UUID.test(owner))return armNo('owner_arm_owner_unverified');
  try {
    const row=await db.query(`SELECT r.request_id::text FROM private.strata_owner_arm_attempt r
      JOIN public.v13_production_account a ON a.id=r.execution_account_id AND a.owner_user_id=r.owner_user_id
      WHERE r.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
      ORDER BY r.created_at DESC LIMIT 1`,[owner]);
    if(row.rows.length===0)return armNo('owner_arm_not_prepared');
    return readOwnerArmOutcome(owner,String(row.rows[0].request_id),db);
  }catch{return armNo('owner_arm_outcome_unavailable');}
}
