/**
 * Owner-only account activation, distinct from fee-source consent, technical
 * review and ARM/START. An independent administrator is NOT needed.
 *
 * The authenticated owner supplies ONLY exact-SHA/policy/qualification scope
 * and explicit consent. Real Kalshi balance/order/fill/position/settlement
 * history is read with the trusted restricted signer; the canonical ledger
 * and immutable owner review are rechecked under financial row locks.
 *
 * This is deliberately narrow: OWNER_SELF_V1 + genuine V3 or explicitly consented durable fees +
 * commissioned, killed, disarmed exact owner account. REVIEWED_API_V2 still
 * follows its historical reviewer path; it is never silently relabeled.
 *
 * No trading worker is started and no order is sent. START remains a later
 * explicit authenticated owner operation after a separate execution grant.
 */
import {createHash,randomUUID} from 'node:crypto';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';
import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed,OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
import {parseV3FeeSource,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from './ownerFeeV3Authority';
import {parseDurableFeeSource,verifyDurableFeeStage} from './durableFeeConsumers';
import {DURABLE_FEE_VERSION,isDurableFeeVersion,verifyDurableOwnerFee} from './durableOwnerFeePolicy';
import {verifyOwnerStandingFee} from './ownerStandingFeeAuthorization';
import {collectFinalReleaseEvidence,finalReleaseScope,finalReleaseHistory,finalReleaseSnapshot,readReleaseOwner} from './inAppProtectiveRelease';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {readUnresolvedIntentMode} from './workerUncertainOrderGate';
import {digest as auditDigest} from '../v13-production/types';

export const OWNER_SELF_ACTIVATION_CONFIRM='I_AUTHORIZE_MY_OWN_SIGNED_KALSHI_ACCOUNT_ACTIVATION_V1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Client=Query&{release(error?:Error):void};
type Db=Query&{connect():Promise<Client>};
type Deps={
 db?:Db;sha?:()=>string;clock?:()=>number;
 verify?:typeof verifyOwnerStandingFee;
 verifyDurableStage?:typeof verifyDurableFeeStage;verifyDurableLocked?:typeof verifyDurableOwnerFee;
 signedEvidence?:typeof collectFinalReleaseEvidence;
 scope?:typeof configuredOwnerSelfScope;
};
const no=(reason:string)=>({ok:false as const,reason,tradingAuthorized:false as const,workerStarted:false as const,ordersSubmitted:false as const});
const fingerprint=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const str=(x:unknown)=>typeof x==='string'?x:'';
const validBody=(raw:unknown):raw is {
 expectedSha:string;accountId:string;policyHash:string;qualificationId:string;
 reviewId:string;confirmation:typeof OWNER_SELF_ACTIVATION_CONFIRM;
}=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const b=raw as Row;
 return Object.keys(b).length===6&&Object.keys(b).every(k=>
  ['expectedSha','accountId','policyHash','qualificationId','reviewId','confirmation'].includes(k))&&
  SHA.test(str(b.expectedSha))&&typeof b.accountId==='string'&&b.accountId.length>0&&
  HASH.test(str(b.policyHash))&&UUID.test(str(b.qualificationId))&&UUID.test(str(b.reviewId))&&
  b.confirmation===OWNER_SELF_ACTIVATION_CONFIRM;
};

/** Readback of a prior COMMIT, including a transaction whose HTTP ACK was
 * lost. Never infer approval from an old SHA or UI cache.
 */
export async function ownerSelfActivationOutcome(owner:string,sha:string,db:Query=pool){
 if(!UUID.test(owner)||!SHA.test(sha))return {outcome:'UNKNOWN' as const};
 try{
  const r=await db.query(`SELECT o.id,o.payload,a.id AS account_id,a.execution_enabled,a.kill_switch,
       l.state,l.account_kill,l.arm_requested
    FROM public.v13_production_observation o
    JOIN public.v13_production_account a ON a.id=o.account_id
    AND a.owner_user_id=$1::uuid
    LEFT JOIN private.kalshi_account_worker_lease l ON l.execution_account_id=a.id
    AND l.owner_user_id=a.owner_user_id
    WHERE o.kind='OWNER_SELF_ACCOUNT_ACTIVATED'
    AND o.payload->>'sha'=$2 AND o.payload->>'ownerId'=$1::text
    ORDER BY o.observed_at DESC LIMIT 2`,[owner,sha]);
  if(r.rows.length!==1)return {outcome:'UNKNOWN' as const};
  const a=r.rows[0]!;
  return {outcome:'RECORDED' as const,
   accountId:str(a.account_id),activationId:str(a.id),sha,
   eligibilityCurrent:a.execution_enabled===true&&a.kill_switch===false&&
    a.state==='released'&&a.account_kill===false&&a.arm_requested===false,
   tradingAuthorized:false as const,workerStarted:false as const,ordersSubmitted:false as const};
 }catch{return {outcome:'UNKNOWN' as const};}
}

/** Validated financial-control transition. The caller must be the signed AAL2
 * owner, obtained from the API's authentication middleware, never the body.
 */
export async function activateOwnerSelfAccount(owner:string,raw:unknown,deps:Deps={}){
 if(!UUID.test(owner)||!validBody(raw))return no('owner_self_explicit_activation_consent_required');
 const sha=(deps.sha??deployedGitSha)();
 if(!SHA.test(sha)||raw.expectedSha!==sha)return no('owner_self_deployed_sha_changed');
 if(!ownerSelfEnrollmentAllowed(owner,raw.accountId,(deps.scope??configuredOwnerSelfScope)()))
  return no('owner_self_account_not_enrolled');
 if(process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED!=='true')
  return no('owner_self_activation_feature_disabled');
 if(process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=='true')
  return no('owner_self_signed_protective_exit_feature_disabled');
 // No test overrides can be supplied by production callers.
 if(process.env.NODE_ENV!=='test'&&
  (deps.verify||deps.verifyDurableStage||deps.verifyDurableLocked||deps.signedEvidence||deps.db||deps.sha||deps.clock||deps.scope))
  return no('owner_self_production_override_forbidden');
 const db=deps.db??pool as unknown as Db,now=deps.clock??Date.now;
 let durableSourceFresh:(()=>boolean)|undefined;
 let tx:Client|null=null,committed=false,commitAttempted=false,discard:Error|undefined;
 try{
  const readback=await ownerSelfActivationOutcome(owner,sha,db);
  if(readback.outcome==='RECORDED')
   return no('owner_self_activation_already_recorded_use_readback');
  const current=await readReleaseOwner(db,owner);
  if(!current.ok)return no(current.reason);
  const account=current.account;
  const source=str(account.fee_source_url),durableModel=parseDurableFeeSource(source);
  const durable=isDurableFeeVersion(account.fee_policy_version)||source.startsWith('strata-durable-owner-fee:');
  const authorityId=durable?durableModel:parseV3FeeSource(source);
  if(account.id!==raw.accountId||account.policy_hash!==raw.policyHash||
   (durable?!isDurableFeeVersion(account.fee_policy_version):account.fee_policy_version!==V3_FEE_POLICY_VERSION)||
   account.fee_formula_version!==V3_FEE_FORMULA_VERSION||
   !authorityId||account.commissioned!==true||
   account.execution_enabled!==false||account.kill_switch!==true||
   account.blocked_reason!==null)return no(durable?'owner_self_commissioned_durable_killed_scope_required':'owner_self_commissioned_v3_killed_scope_required');
  let sourceDigest:string,durableTicker:string|undefined;
  if(durable){
   if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return no('owner_self_durable_fee_feature_disabled');
   const verified=await(deps.verifyDurableStage??verifyDurableFeeStage)(owner,raw.accountId,source,'ENTRY');
   if(!verified.ok||verified.feeProofOnly!==true||verified.tradingAuthorized!==false||
    verified.sourceDigest!==account.fee_artifact_digest||
    !/^KXBTC15M-[A-Za-z0-9-]+$/.test(verified.marketTicker)||
    !Number.isSafeInteger(verified.verifiedAtMs)||now()<verified.verifiedAtMs||now()-verified.verifiedAtMs>5000)
    return no('owner_self_durable_fee_preflight_unverified');
   sourceDigest=verified.sourceDigest;durableTicker=verified.marketTicker;
  }else{
   const verified=await(deps.verify??verifyOwnerStandingFee)(owner,'STEP_11',source);
   if(!verified.ok||verified.identity.sourceAuthorityId!==authorityId||
    verified.identity.sha!==sha||verified.identity.policyHash!==raw.policyHash||
    verified.identity.sourceDigest!==account.fee_artifact_digest)
    return no('owner_self_current_official_fee_authority_unavailable');
   sourceDigest=verified.identity.sourceDigest;
  }
  // The existing preflight enforces complete signed Kalshi pagination, issuer
  // credential binding, cash parity, retained ledger/exits and 5s freshness.
  const evidence=await(deps.signedEvidence??collectFinalReleaseEvidence)(owner,{db:db as never,now});
  if(!evidence||evidence.account!==raw.accountId)
   return no('owner_self_signed_exchange_scope_unverified');
  if(now()-evidence.started>5000||now()<evidence.started)
   return no('owner_self_signed_exchange_evidence_expired');
  tx=await db.connect();await tx.query('BEGIN');
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const guard=await tx.query(`SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.v13_production_observation'::regclass
    AND t.tgname='final_release_signed_deadline' AND t.tgenabled='O'
    AND t.tgdeferrable AND t.tginitdeferred AND NOT p.prosecdef`);
  if(guard.rows.length!==1)return no('owner_self_signed_deadline_migration_missing');
  const locked=await finalReleaseScope(tx,owner,raw.accountId,true);
  if(fingerprint(locked)!==fingerprint(evidence.scope))
   return no('owner_self_account_policy_credential_or_worker_changed');
  const activation=await readReleaseOwner(tx,owner);
  if(!activation.ok||fingerprint(activation.account)!==fingerprint(evidence.activation))
   return no('owner_self_account_authorization_changed');
  const a=activation.account;
  if(a.policy_hash!==raw.policyHash||a.fee_source_url!==source||
   a.fee_artifact_digest!==sourceDigest)
   return no('owner_self_fee_or_approved_policy_changed');
  const history=await finalReleaseHistory(tx,raw.accountId,owner,true);
  if(history.reconciliationDigest!==evidence.history.reconciliationDigest)
   return no('owner_self_retained_financial_history_changed');
  finalReleaseSnapshot(history,evidence.snapshot);
  const local=await tx.query(`SELECT a.* FROM public.v13_production_account a
   WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.commissioned=true
   AND a.execution_enabled=false AND a.kill_switch=true AND a.blocked_reason IS NULL
   AND a.reserved_micros=0 AND a.cash_precision_verified=true
   FOR UPDATE`,[raw.accountId,owner]);
  if(local.rows.length!==1)return no('owner_self_activation_account_state_changed');
  const stake=Number(a.configured_stake_cents),cash=BigInt(str(local.rows[0]!.cash_micros));
  if(!Number.isSafeInteger(stake)||stake<500||stake>2500000||
   stake>Number(a.max_entry_stake_cents)||stake>Number(a.max_entry_all_in_cents)||
   cash<BigInt(stake)*10000n)return no('owner_self_approved_stake_or_cash_unavailable');
  const global=await tx.query(`SELECT 1 FROM public.live_execution_config
    WHERE id='singleton' AND mode='V13_PRODUCTION'
    AND live_execution_enabled=true AND manual_kill_switch=false FOR SHARE`);
  if(global.rows.length!==1)return no('owner_self_global_live_or_kill_not_ready');
  const unresolved=await readUnresolvedIntentMode((sql,args)=>tx!.query(sql,args),raw.accountId);
  if(!unresolved.ok||unresolved.mode!=='entries')
   return no('owner_self_unresolved_exchange_intents');
  const outstanding=await tx.query(`SELECT
    (SELECT count(*)::int FROM public.v13_production_position
      WHERE account_id=$1 AND quantity_hundredths<>0) AS positions,
    (SELECT count(*)::int FROM private.strata_emergency_exit_reservations
      WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) AS exits`,[raw.accountId]);
  if(outstanding.rows.length!==1||outstanding.rows[0]!.positions!==0||
   outstanding.rows[0]!.exits!==0)return no('owner_self_open_position_or_protective_exit_unknown');
  const review=await tx.query(`SELECT r.release_id,q.evidence_digest
    FROM private.strata_standing_execution_reviews r
    JOIN private.strata_protective_release_qualification q
    ON q.qualification_id=r.qualification_id AND q.owner_user_id=r.owner_user_id
    AND q.execution_account_id=r.execution_account_id AND q.release_commit_sha=r.release_commit_sha
    WHERE r.release_id=$1::uuid AND r.owner_user_id=$2::uuid
      AND r.owner_authorizer_id=$2::uuid AND r.execution_account_id=$3
      AND r.release_commit_sha=$4 AND r.policy_hash=$5
      AND r.qualification_id=$6::uuid
      AND r.review_authority='OWNER_SELF_V1' AND r.independent_reviewer_id IS NULL
      AND r.confirmation=$7
      AND r.state='approved' AND r.revoked_at IS NULL AND r.created_at<=now()
      AND q.expires_at>clock_timestamp()+interval '60 seconds'
      AND q.observed_at<=r.created_at AND r.created_at<q.expires_at
    FOR SHARE OF r,q`,[raw.reviewId,owner,raw.accountId,sha,raw.policyHash,
      raw.qualificationId,OWNER_SELF_REVIEW_CONFIRM]);
  if(review.rows.length!==1)return no('owner_self_review_or_signed_proof_not_current');
  if(durable){
   // Hold durable policy/model/state locks in the same activation transaction.
   // A preflight receipt is not sufficient to clear the account KILL.
   const fee=await(deps.verifyDurableLocked??verifyDurableOwnerFee)(tx,
    {owner,account:raw.accountId,sha,policyHash:raw.policyHash},durableTicker!,'ENTRY');
   if(!fee.ok||!fee.sourceFresh()||fee.sourceDigest!==sourceDigest||fee.marketTicker!==durableTicker||
    fee.feeProofOnly!==true||fee.tradingAuthorized!==false||
    !Number.isSafeInteger(fee.verifiedAtMs)||now()<fee.verifiedAtMs||now()-fee.verifiedAtMs>5000)
    return no('owner_self_durable_fee_changed_or_unverified');
   durableSourceFresh=fee.sourceFresh;
  }else{
  const fee=await tx.query(`SELECT g.authority_id
    FROM private.strata_owner_standing_fee_v1 s
    JOIN private.strata_owner_fee_authority_v3 g
      ON g.authority_id=s.source_authority_id
      AND g.owner_user_id=s.owner_user_id
      AND g.execution_account_id=s.execution_account_id
      AND g.release_commit_sha=s.release_commit_sha
      AND g.official_source_digest=s.official_source_digest
    JOIN private.strata_owner_fee_evidence_v3 e ON e.attestation_id=g.attestation_id
      AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id
      AND e.release_commit_sha=g.release_commit_sha
      AND e.source_digest=g.official_source_digest
    WHERE s.source_authority_id=$1::uuid AND s.owner_user_id=$2::uuid
    AND s.execution_account_id=$3 AND s.release_commit_sha=$4
    AND s.fee_policy_version=$5 AND s.formula_version=$6
    AND s.official_source_digest=$7 AND s.approved_policy_hash=$8
    AND s.confirmation='I_AUTHORIZE_MY_OWN_STANDING_OFFICIAL_KALSHI_FEE_MODEL_V1'
    AND s.revoked_at IS NULL AND g.revoked_at IS NULL AND e.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()+interval '120 seconds'
    FOR SHARE OF s,g,e`,[authorityId,owner,raw.accountId,sha,
      V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,sourceDigest,raw.policyHash]);
  if(fee.rows.length!==1)return no('owner_self_fee_authority_changed_or_expiring');
  }
  const grants=await tx.query(`SELECT grant_id,revoked_at
    FROM private.strata_continuous_execution_grants
    WHERE owner_user_id=$1::uuid AND execution_account_id=$2
      AND release_commit_sha=$3 FOR UPDATE`,[owner,raw.accountId,sha]);
  if(grants.rows.length>0)return no('owner_self_existing_standing_grant_requires_reconciliation');
  // Same signed, authoritative ledger proof as the legacy final release.
  const ledger=new ProductionLedger(db as unknown as Pool,raw.accountId);
  await ledger.finalAccountProof(tx as unknown as PoolClient,local.rows[0] as unknown as Account,evidence.snapshot,now());
  await ledger.assertConservation(tx as unknown as PoolClient,local.rows[0] as Account);
  const approvals=await tx.query(`SELECT approval_id::text,revoked_at FROM private.strata_owner_sha_approvals
    WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3
    ORDER BY confirmed_at DESC FOR UPDATE`,[owner,raw.accountId,sha]);
  if(approvals.rows.length>1||approvals.rows.some(r=>r.revoked_at!==null))
   return no('owner_self_prior_sha_revocation_or_ambiguous_approval');
  let approvalId=approvals.rows.length?str(approvals.rows[0]!.approval_id):'';
  if(!approvalId){
   const saved=await tx.query(`INSERT INTO private.strata_owner_sha_approvals
    (owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest)
    VALUES ($1::uuid,$2,$3,$4::uuid,$5) RETURNING approval_id::text`,
    [owner,raw.accountId,sha,raw.qualificationId,review.rows[0]!.evidence_digest]);
   if(saved.rows.length!==1)return no('owner_self_sha_approval_insert_failed');
   approvalId=str(saved.rows[0]!.approval_id);
  }
  const lease=await tx.query(`SELECT state,account_kill,arm_requested,fencing_token::text
    FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1
    AND owner_user_id=$2::uuid FOR UPDATE`,[raw.accountId,owner]);
  if(lease.rows.length!==1||lease.rows[0]!.state!=='killed'||
   lease.rows[0]!.account_kill!==true||lease.rows[0]!.arm_requested!==false)
   return no('owner_self_killed_lease_state_changed');
  // Move only THIS safely terminated lease to released, not owned or armed.
  const w=await tx.query(`UPDATE private.kalshi_account_worker_lease
    SET state='released',account_kill=false,arm_requested=false,
      fencing_token=fencing_token+1,heartbeat_at=clock_timestamp(),released_at=clock_timestamp()
    WHERE execution_account_id=$1 AND owner_user_id=$2::uuid
      AND state='killed' AND account_kill=true AND arm_requested=false
      AND fencing_token=$3::bigint RETURNING fencing_token::text`,
    [raw.accountId,owner,lease.rows[0]!.fencing_token]);
  if(w.rows.length!==1)return no('owner_self_killed_lease_fence_conflict');
  const enabled=await tx.query(`UPDATE public.v13_production_account
    SET execution_enabled=true,kill_switch=false,revision=revision+1
    WHERE id=$1 AND owner_user_id=$2::uuid AND commissioned=true
    AND execution_enabled=false AND kill_switch=true AND blocked_reason IS NULL
    AND reserved_micros=0 RETURNING id`,[raw.accountId,owner]);
  if(enabled.rows.length!==1)return no('owner_self_account_activation_compare_and_set_failed');
  const audit={ownerId:owner,accountId:raw.accountId,sha,
   reviewId:raw.reviewId,qualificationId:raw.qualificationId,approvalId,
   feeAuthorityId:authorityId,feePolicyVersion:account.fee_policy_version,policyHash:raw.policyHash,
   observedAtMs:evidence.started,newWorkerFence:w.rows[0]!.fencing_token,
   note:'Owner-self activation only; ARM/START and execution grant remain separate'};
  const event=async(kind:string,payload:Row)=>{
   await tx!.query(`INSERT INTO public.v13_production_observation
      (id,account_id,kind,payload,digest) VALUES ($1,$2,$3,$4::jsonb,$5)`,
     [randomUUID(),raw.accountId,kind,JSON.stringify(payload),auditDigest(payload)]);
  };
  await event('OWNER_SELF_ACCOUNT_ACTIVATED',audit);
  await event('OWNER_RELEASE_SIGNED_RECHECK',{ownerId:owner,accountId:raw.accountId,
   sha,observedAtMs:evidence.started,qualificationId:raw.qualificationId});
  // DB COMMIT executes the deferred five-second signed-evidence freshness
  // trigger. If it expires, the whole account+lease+approval change rolls back.
  if(durable&&(!durableSourceFresh||!durableSourceFresh()))return no('owner_self_durable_fee_changed_or_unverified');
  commitAttempted=true;await tx.query('COMMIT');committed=true;
  return {ok:true as const,reason:'owner_self_account_activated_worker_released_and_disarmed',
   accountId:raw.accountId,sha,approvalId,
   tradingAuthorized:false as const,workerStarted:false as const,ordersSubmitted:false as const};
 }catch{
  if(commitAttempted){discard=Error('owner_self_activation_commit_unknown');
   return {...no('owner_self_activation_commit_outcome_unknown'),outcomeUnknown:true,retryAuthorized:false};}
  return no('owner_self_activation_unavailable_or_signed_proof_failed');
 }finally{
  if(tx){if(!committed&&!discard)try{await tx.query('ROLLBACK');}
   catch{discard=Error('owner_self_activation_rollback_unknown');}
   tx.release(discard);}
 }
}
