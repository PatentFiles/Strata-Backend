import {platformFeeUploadEnabled} from './platformFeeUploadMode';
import {isDurableFeeVersion} from './durableOwnerFeePolicy';
import {parseV3FeeSource} from './ownerFeeV3Authority';
import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';
import {INSERT_PUBLIC_STOPPED_LEASE_SQL,publicSelfServiceReleaseQualified,readOwnedSelfServiceScope} from './ownerSelfServiceEligibility';
import {ownerArmSchemaReady,armNo,requireArm,safeArmReason,UUID,HASH,type ArmDatabase} from './ownerArmStore';
import {assertOwnerArmFence,type OwnerArmFence} from './ownerArmContext';
import {armTransaction} from './ownerArmStore';

export const OWNER_ARM_CONFIRM = 'PREPARE_AND_ARM_MY_SAVED_ACCOUNT_V1';
export const OWNER_START_CONFIRM = 'START_MY_PREPARED_ACCOUNT_V1';
const riskNames = ['capital_limit_cents','max_entry_stake_cents','max_entry_all_in_cents',
  'max_daily_loss_cents','max_total_loss_cents','max_open_positions','max_quote_age_ms','max_fee_evidence_age_ms'] as const;
export type OwnerArmScope = {
  ownerId:string;accountId:string;releaseSha:string;policyId:string;policyHash:string;policyVersion:number;
  controlEpoch:string;initialLeaseRequired:boolean;stakeCents:number;feeDigest:string;feeSource:string;feeVersion:string;fingerprint:string;minimumExitMicros:number;
  limits:Record<typeof riskNames[number],number>;scopeDigest:string;
};
export function armScopeDigest(scope: Omit<OwnerArmScope,'scopeDigest'>): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

/** This is an owner-scope review, not a fee verification, an exchange proof or
 * a trading permit. Fresh evidence is deliberately collected by the explicit
 * ARM action, rather than requiring the user to refresh it in another page. */
export async function readOwnerArmScope(owner:string):Promise<OwnerArmScope> {
  requireArm(UUID.test(owner),'owner_arm_owner_unverified');
  requireArm(await ownerArmSchemaReady(),'owner_arm_platform_upgrade_required');
  const sha=deployedGitSha();
  requireArm(publicSelfServiceReleaseQualified(sha),'public_self_service_release_not_qualified');
  const a=await readOwnedSelfServiceScope(pool,owner,sha);
  requireArm(a?.commissioned,'owner_arm_complete_wallet_setup');
  requireArm(!a.blocked,'owner_arm_financial_hold_requires_review');
  requireArm(a.cashConserved,'owner_arm_cash_conservation_unverified');
  requireArm(a.reservedMicros==='0','owner_arm_reserved_funds_require_reconciliation');
  const r=await pool.query(`SELECT a.owner_control_epoch::text AS control_epoch,a.policy_id,a.minimum_exit_micros,a.fee_artifact_digest,
    p.version,p.policy_hash,p.fee_source_url,p.fee_policy_version,
    p.capital_limit_cents,p.max_entry_stake_cents,p.max_entry_all_in_cents,
    p.max_daily_loss_cents,p.max_total_loss_cents,p.max_open_positions,p.max_quote_age_ms,p.max_fee_evidence_age_ms,
    w.state AS worker_state,w.arm_requested,w.account_kill
    FROM public.v13_production_account a JOIN public.v13_live_money_policy p
      ON p.id=a.policy_id AND p.execution_account_id=a.id
    LEFT JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
    WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND p.state='APPROVED'
      AND p.created_by=$1::text AND p.approved_by=$1::text`,[owner,a.accountId]);
  requireArm(r.rows.length===1,'owner_arm_account_scope_unverified');
  const p=r.rows[0]!;
  requireArm(p.arm_requested!==true,'owner_arm_stop_running_worker_first');
  const initialLeaseRequired=p.worker_state===null&&a.killSwitchOn&&!a.executionEnabled;
  requireArm(initialLeaseRequired||['released','killed','owned'].includes(String(p.worker_state)),'owner_arm_worker_state_unverified');
  const limits=Object.fromEntries(riskNames.map(k=>[k,Number(p[k])])) as OwnerArmScope['limits'];
  requireArm(Object.values(limits).every(n=>Number.isSafeInteger(n)&&n>0),'owner_arm_risk_limits_unverified');
  requireArm(Number(p.minimum_exit_micros)===10000,'owner_arm_exit_policy_requires_review');
  requireArm(HASH.test(String(p.fee_artifact_digest))&&p.policy_hash===a.policyHash,'owner_arm_fee_or_policy_unverified');
  const core={ownerId:owner,accountId:a.accountId,releaseSha:sha,policyId:String(p.policy_id),
    policyHash:a.policyHash,policyVersion:Number(p.version),controlEpoch:String(p.control_epoch),initialLeaseRequired,stakeCents:a.stakeCents,
    feeDigest:String(p.fee_artifact_digest),feeSource:String(p.fee_source_url),
    feeVersion:String(p.fee_policy_version),fingerprint:a.keyFingerprint,minimumExitMicros:10000,limits};
  return {...core,scopeDigest:armScopeDigest(core)};
}

export async function reviewOwnerArm(owner:string) {
  try {
    const scope=await readOwnerArmScope(owner);
    return {ok:true as const,version:'OWNER_ARM_REVIEW_V1' as const,
      review:{ownerId:owner,scopeDigest:scope.scopeDigest,releaseSha:scope.releaseSha,
        stakeCents:scope.stakeCents,capitalLimitCents:scope.limits.capital_limit_cents,
        maxEntryAllInCents:scope.limits.max_entry_all_in_cents,
        maxDailyLossCents:scope.limits.max_daily_loss_cents,maxTotalLossCents:scope.limits.max_total_loss_cents,
        maxOpenPositions:scope.limits.max_open_positions,feeDigest:scope.feeDigest,
        historicalFeeTerms:scope.feeVersion==='owner_attested_historical_terms_v1'||
          (platformFeeUploadEnabled()&&!isDurableFeeVersion(scope.feeVersion)&&!parseV3FeeSource(scope.feeSource)),
        confirmation:OWNER_ARM_CONFIRM},
      ordersSubmitted:false as const,workerStarted:false as const,transferAttempted:false as const};
  } catch(error) {return armNo(safeArmReason(error));}
}

export function unchangedArmMoney(a:OwnerArmScope,b:OwnerArmScope):boolean {
  return a.ownerId===b.ownerId&&a.accountId===b.accountId&&a.releaseSha===b.releaseSha&&
    a.fingerprint===b.fingerprint&&a.stakeCents===b.stakeCents&&a.feeDigest===b.feeDigest&&
    a.minimumExitMicros===b.minimumExitMicros&&riskNames.every(k=>a.limits[k]===b.limits[k]);
}

/** Establish a held, disarmed preparation boundary without an emergency KILL
 * click. Only a stopped/terminal, locally flat account is eligible. The epoch
 * and snapshot checks prevent staging a new or changed account. Full signed
 * exchange history is still required after this local admission. */
export async function holdForOwnerArm(fence:OwnerArmFence,scope:OwnerArmScope,db:ArmDatabase=pool) {
  return armTransaction(db,async tx=>{
    await assertOwnerArmFence(tx,fence.ownerId);
    const gate=await tx.query(`SELECT live_execution_enabled,manual_kill_switch
      FROM public.live_execution_config FOR SHARE`);
    requireArm(gate.rows.length===1&&gate.rows[0].live_execution_enabled===true&&
      gate.rows[0].manual_kill_switch===false,'owner_arm_platform_trading_disabled');
    if(scope.initialLeaseRequired){
      // A brand-new account needs a KILLED lease before the signed cash
      // recorder can verify it. This creates no trading authority and may use
      // an aged setup cash record: the next stage must obtain fresh signed
      // history. Requiring fresh cash here would create a circular dependency.
      // Reuse the restrictive existing INSERT: no prior intent/event/position,
      // exact owner, pair, verified restricted key, and both gates CLOSED.
      const initial=await readOwnedSelfServiceScope(tx,scope.ownerId,scope.releaseSha);
      requireArm(initial?.commissioned&&!initial.executionEnabled&&initial.killSwitchOn&&
        !initial.blocked&&initial.cashConserved&&initial.reservedMicros==='0'&&
        initial.accountId===scope.accountId&&initial.keyFingerprint===scope.fingerprint,
        'owner_arm_initial_worker_lease_unverified');
      const created=await tx.query(INSERT_PUBLIC_STOPPED_LEASE_SQL,[scope.ownerId,scope.accountId,scope.fingerprint]);
      requireArm(created.rows.length===1,'owner_arm_initial_worker_lease_unverified');
    }
    const worker=await tx.query(`SELECT state,arm_requested,account_kill FROM private.kalshi_account_worker_lease
      WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[scope.accountId,scope.ownerId]);
    requireArm(worker.rows.length===1&&worker.rows[0].arm_requested===false&&
      ((worker.rows[0].state==='released'&&worker.rows[0].account_kill===false)||
       (worker.rows[0].state==='killed'&&worker.rows[0].account_kill===true)),'owner_arm_worker_not_safely_stopped');
    const exposure=await tx.query(`SELECT
      EXISTS(SELECT 1 FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) AS positions,
      EXISTS(SELECT 1 FROM public.v13_production_intent WHERE account_id=$1
        AND (terminal IS DISTINCT FROM TRUE OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)) AS intents,
      EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1
        AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) AS exits`,[scope.accountId]);
    requireArm(exposure.rows.length===1&&exposure.rows[0].positions===false&&exposure.rows[0].intents===false&&
      exposure.rows[0].exits===false,'owner_arm_open_or_uncertain_exposure');
    const maintenance=await tx.query(`SELECT
      EXISTS(SELECT 1 FROM private.strata_manual_profit_withdrawals WHERE execution_account_id=$1
        AND state IN ('prepared','attempted','pending','uncertain')) AS withdrawal,
      EXISTS(SELECT 1 FROM private.strata_auto_withdrawal_maintenance WHERE execution_account_id=$1
        AND state<>'completed') AS maintenance`,[scope.accountId]);
    requireArm(maintenance.rows.length===1&&maintenance.rows[0].withdrawal===false&&
      maintenance.rows[0].maintenance===false,'owner_arm_funds_operation_in_progress');
    const held=await tx.query(`UPDATE public.v13_production_account a
      SET execution_enabled=false,kill_switch=true,revision=revision+1
      WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.commissioned=true AND a.blocked_reason IS NULL
        AND a.reserved_micros=0 AND a.key_fingerprint=$3 AND a.policy_id=$4
        AND a.fee_artifact_digest=$5
        AND EXISTS(SELECT 1 FROM public.v13_live_money_policy p WHERE p.id=a.policy_id AND p.policy_hash=$6 AND p.state='APPROVED')
      RETURNING id`,[scope.accountId,scope.ownerId,scope.fingerprint,scope.policyId,scope.feeDigest,scope.policyHash]);
    requireArm(held.rows.length===1,'owner_arm_account_scope_changed');
  });
}
