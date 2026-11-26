import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import type {UserScopePort} from '../../routes/userExecutionRouter';
import {deployedGitSha} from './deployedGitSha';
import {withOwnerArmFence,type OwnerArmFence} from './ownerArmContext';
import {armNo,UUID,HASH,requireArm,safeArmReason,beginOwnerArm,readOwnerArmOutcome,
  ownerArmProgress,finishOwnerArm,blockOwnerArm,beginPreparedStart,readCurrentOwnerArm} from './ownerArmStore';
import {readOwnerArmScope,holdForOwnerArm,unchangedArmMoney,OWNER_ARM_CONFIRM,OWNER_START_CONFIRM,type OwnerArmScope} from './ownerArmScope';
import {refreshOwnerCommissioningCash} from './ownerCommissioningCashTransition';
import {durableFeeReauthorizationPreview,reauthorizeDurableFeeRelease,durableFeeReauthorizationOutcome} from './durableFeeReauthorization';
import {parseDurableFeeSource} from './durableFeeConsumers';
import {durableReleaseMatch} from './durableFeeReleaseBinding';
import {HISTORICAL_RISK_ACCEPTANCE} from './historicalOwnerFeeBaseline';
import {publicReleaseAction,REVIEW_PUBLIC_RELEASE,CONFIRM_PUBLIC_RELEASE} from './publicCommissioningRelease';
import {verifyPersonalStartupAuthority} from './personalStartupAuthority';

const isRecord=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const derivedUuid=(input:string)=>{
  const h=createHash('sha256').update(input).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
export function parseOwnerArmBody(body:unknown):{requestId:string;scopeDigest:string}|null {
  if(!isRecord(body)||Object.keys(body).sort().join(',')!=='confirmation,requestId,scopeDigest'||
    body.confirmation!==OWNER_ARM_CONFIRM||!UUID.test(String(body.requestId))||!HASH.test(String(body.scopeDigest)))return null;
  return {requestId:String(body.requestId),scopeDigest:String(body.scopeDigest)};
}

/** Fee consent is renewed only for the exact immutable model reviewed by the
 * owner. No changed PDF, source digest, risk limit or revoked authority can be
 * substituted. A lost acknowledgement is resolved by the same attempt ID. */
async function ensureArmFee(scope:OwnerArmScope,fence:OwnerArmFence) {
  const modelId=parseDurableFeeSource(scope.feeSource);
  if(!modelId)return; // Initial commissioning uses the existing scoped public migration below.
  const bound=await pool.query(`SELECT m.model_id FROM private.strata_durable_owner_fee_model m
    WHERE m.model_id=$1::uuid AND m.owner_user_id=$2::uuid AND m.execution_account_id=$4
      AND m.approved_policy_hash=$5 AND m.official_source_digest=$6 AND ${durableReleaseMatch('$3')}`,
    [modelId,scope.ownerId,scope.releaseSha,scope.accountId,scope.policyHash,scope.feeDigest]);
  if(bound.rows.length===1)return; // Runtime verification still checks publication/revocation/market freshness.
  requireArm(bound.rows.length===0,'owner_arm_fee_binding_ambiguous');
  const authorizationId=derivedUuid(`owner-arm-fee-v1:${fence.requestId}`);
  const previous=await durableFeeReauthorizationOutcome(scope.ownerId,authorizationId,scope.releaseSha);
  if(previous.outcome==='RECORDED')return;
  requireArm(previous.outcome!=='REJECTED','owner_arm_fee_attempt_rejected');
  const preview=await durableFeeReauthorizationPreview(scope.ownerId);
  requireArm(preview.ok&&'modelId' in preview,'reason' in preview?preview.reason:'owner_arm_fee_review_unavailable');
  requireArm(preview.modelId===modelId&&preview.accountId===scope.accountId&&preview.sha===scope.releaseSha&&
    preview.policyHash===scope.policyHash&&preview.sourceDigest===scope.feeDigest,'owner_arm_fee_terms_changed_review_required');
  const result=await reauthorizeDurableFeeRelease(scope.ownerId,{
    authorizationId,accountId:scope.accountId,modelId,originalSha:preview.originalSha,
    expectedSha:scope.releaseSha,policyHash:scope.policyHash,sourceDigest:scope.feeDigest,
    confirmation:preview.confirmation,riskAcceptance:HISTORICAL_RISK_ACCEPTANCE,
  });
  const readback=await durableFeeReauthorizationOutcome(scope.ownerId,authorizationId,scope.releaseSha);
  requireArm(readback.outcome==='RECORDED',result.reason);
}

/** Explicit dependency surface makes orchestration testable without production
 * credentials. The HTTP entrypoint below never accepts or supplies overrides. */
export interface OwnerArmStages {
  progress(stage:string):Promise<void>;
  hold():Promise<void>;
  reconcile():Promise<{ok:boolean;reason:string}>;
  fee():Promise<void>;
  qualify():Promise<{ok:boolean;reason:string}>;
  final():Promise<void>;
}
export async function runOwnerArmStages(steps:OwnerArmStages):Promise<void> {
  await steps.progress('stopping_boundary'); await steps.hold();
  await steps.progress('reconciling'); const cash=await steps.reconcile(); requireArm(cash.ok,cash.reason);
  await steps.progress('fee_authorization'); await steps.fee();
  await steps.progress('qualifying'); const qualified=await steps.qualify(); requireArm(qualified.ok,qualified.reason);
  await steps.progress('final_checks'); await steps.final();
}

export async function prepareOwnerArm(owner:string,body:unknown,port:UserScopePort) {
  const parsed=parseOwnerArmBody(body);
  if(!UUID.test(owner)||!parsed)return armNo('owner_arm_explicit_scoped_consent_required');
  let fence:OwnerArmFence|undefined;
  try {
    // A duplicate after policy migration must read its original durable result,
    // rather than try to reinterpret the original consent against a new hash.
    const prior=await pool.query(`SELECT scope_digest FROM private.strata_owner_arm_attempt
      WHERE request_id=$1::uuid AND owner_user_id=$2::uuid`,[parsed.requestId,owner]);
    if(prior.rows.length) {
      requireArm(prior.rows.length===1&&prior.rows[0].scope_digest===parsed.scopeDigest,'owner_arm_request_scope_changed');
      return readOwnerArmOutcome(owner,parsed.requestId);
    }
    const scope=await readOwnerArmScope(owner);
    requireArm(scope.scopeDigest===parsed.scopeDigest,'owner_arm_review_changed');
    const view=await port.settings(owner);
    requireArm(view.ownerUserId===owner&&view.workerRunning===false,'owner_arm_stop_running_worker_first');
    // Proven stale-worker recovery is deliberately not inferred from an old
    // heartbeat. Its existing signed recovery service is used only when the
    // real process registry can prove this owner is not scheduled.
    const needsLeaseRecovery=view.workerLeaseState==='owned';
    const started=await beginOwnerArm({owner,account:scope.accountId,requestId:parsed.requestId,
      scopeDigest:parsed.scopeDigest,sha:scope.releaseSha,expectedEpoch:scope.controlEpoch});
    if(!started)return readOwnerArmOutcome(owner,parsed.requestId);
    fence=started;
    await withOwnerArmFence(fence,async()=>{
      await runOwnerArmStages({
        progress:stage=>ownerArmProgress(started,stage),
        hold:async()=>{
          if(needsLeaseRecovery){
            requireArm(typeof port.recoverArmLease==='function','owner_arm_worker_recovery_unavailable');
            const recovery=await port.recoverArmLease(owner);requireArm(recovery.ok,recovery.reason);
          }
          await holdForOwnerArm(started,scope);
        },
        reconcile:()=>refreshOwnerCommissioningCash(owner),
        fee:()=>ensureArmFee(scope,started),
        qualify:async()=>{
          requireArm(deployedGitSha()===scope.releaseSha,'owner_arm_release_changed');
          const review=await publicReleaseAction(owner,{expectedOwnerId:owner,confirmation:REVIEW_PUBLIC_RELEASE});
          requireArm(review.ok&&review.review,review.reason);
          const r=review.review;
          requireArm(r.ownerId===owner&&r.accountId===scope.accountId&&r.releaseSha===scope.releaseSha&&
            r.feeDigest===scope.feeDigest&&r.stakeCents===scope.stakeCents&&
            r.limits.capitalLimitCents===scope.limits.capital_limit_cents&&
            r.limits.maxEntryStakeCents===scope.limits.max_entry_stake_cents&&
            r.limits.maxEntryAllInCents===scope.limits.max_entry_all_in_cents&&
            r.limits.maxDailyLossCents===scope.limits.max_daily_loss_cents&&
            r.limits.maxTotalLossCents===scope.limits.max_total_loss_cents&&
            r.limits.maxOpenPositions===scope.limits.max_open_positions&&
            r.limits.maxQuoteAgeMs===scope.limits.max_quote_age_ms&&
            r.limits.maxFeeEvidenceAgeMs===scope.limits.max_fee_evidence_age_ms,
            'owner_arm_changed_financial_terms_require_review');
          const result=await publicReleaseAction(owner,{expectedOwnerId:owner,confirmation:CONFIRM_PUBLIC_RELEASE,scopeDigest:r.scopeDigest});
          return {ok:result.ok&&result.readyToTrade,reason:result.reason};
        },
        final:async()=>{
          const next=await readOwnerArmScope(owner);
          requireArm(unchangedArmMoney(scope,next),'owner_arm_changed_financial_terms_require_review');
          const release=await verifyPersonalStartupAuthority(pool,owner);
          requireArm(release.ok,release.ok?'owner_arm_release_unverified':release.reason);
          await finishOwnerArm(started,{policyHash:next.policyHash,feeDigest:next.feeDigest,fingerprint:next.fingerprint,stakeCents:next.stakeCents});
        },
      });
    });
    return readOwnerArmOutcome(owner,parsed.requestId);
  }catch(error){
    const reason=safeArmReason(error);
    if(reason==='owner_arm_already_preparing')return readCurrentOwnerArm(owner);
    if(fence)await blockOwnerArm(fence,reason).catch(()=>undefined);
    return {...armNo(reason),requestId:parsed.requestId};
  }
}

export async function startPreparedOwner(owner:string,body:unknown,port:UserScopePort) {
  if(!UUID.test(owner)||!isRecord(body)||Object.keys(body).sort().join(',')!=='confirmation,requestId'||
    body.confirmation!==OWNER_START_CONFIRM||!UUID.test(String(body.requestId)))return armNo('owner_start_explicit_prepared_consent_required');
  let fence:OwnerArmFence|undefined;
  try {
    fence=await beginPreparedStart(owner,String(body.requestId),deployedGitSha());
    const activeFence=fence;
    return await withOwnerArmFence(activeFence,async()=>{
      // Reconcile immediately before START rather than making stale cash a
      // disabled browser button. START itself still runs signed full history,
      // risk, current market, release and atomic worker-lease checks.
      const cash=await port.reconcileCash(owner,{confirmation:'RECORD_OWNED_SUBACCOUNT_CASH'});
      requireArm(cash.ok,cash.reason);
      const result=await port.control(owner,'START');
      requireArm(result.ok,result.reason??'owner_start_not_confirmed');
      await pool.query(`UPDATE private.strata_owner_arm_attempt SET state='STARTED',stage='started',
        reason='worker_start_recorded',updated_at=clock_timestamp()
        WHERE request_id=$1::uuid AND owner_user_id=$2::uuid AND state='STARTING'`,[activeFence.requestId,owner]);
      return {...result,version:'OWNER_START_V1' as const,requestId:activeFence.requestId};
    });
  }catch(error){
    const reason=safeArmReason(error);
    if(fence)await blockOwnerArm(fence,reason).catch(()=>undefined);
    // No automatic START retry: a failed transport/write acknowledgement may
    // follow a successful worker schedule. Read actual bot status and outcome.
    return {ok:false as const,version:'OWNER_START_V1' as const,reason,outcomeUnknown:true as const,requestId:String(body.requestId)};
  }
}
