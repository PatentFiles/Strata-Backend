/** Isolated, default-off atomic durable migration. No ARM, START or orders.
 * Preserves approved limits. Original V2/V3 consent is never relabeled. */
import {createHash,randomUUID} from 'node:crypto';import {pool} from '@workspace/db';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';import {digest as auditDigest} from '../v13-production/types';
import {approvedFromRow} from './ownerStakePolicyAmendment';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import type {Identity,Request} from '../v13-production/types';import {loadedMaterial} from './inAppProtectiveRelease';
import {v3MigrationFlatHistoryCheck} from './ownerFeeV3Migration';import {verifyOfficialFeePdfBytes} from '../microLiveFeeArtifact';
import {DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';import {deployedGitSha} from './deployedGitSha';
import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed} from './ownerSelfReviewMode';
export const DURABLE_MIGRATION_CONFIRM='I_APPROVE_ATOMIC_MIGRATION_TO_DURABLE_OFFICIAL_FEE_TERMS_V1';
export const DURABLE_PUBLICATION_RISK_ACCEPTANCE='I_ACCEPT_PUBLICATION_FRESHNESS_MAY_BE_UNKNOWN_AND_UNBOUNDED_FEE_EXITS_MAY_BLOCK_V1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const POLICY_ID=/^[a-zA-Z0-9_:.\-]{8,160}$/;
type Row=Record<string,unknown>;type Q={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Db={connect():Promise<Q&{release(error?:Error):void}>};
type Inputs={db?:Db;load?:typeof loadedMaterial;read?:typeof readOwnedKalshiFeeds;now?:()=>number;sha?:()=>string;scope?:typeof configuredOwnerSelfScope};
const fail=(reason:string)=>({ok:false as const,reason,policyMigrated:false as const,tradingAuthorized:false as const});
type Result=ReturnType<typeof fail>|{ok:true;reason:string;policyMigrated:true;tradingAuthorized:false;newPolicyId:string;newVersion:number;modelId:string;newPolicyHash:string}|(ReturnType<typeof fail>&{retryAuthorized:false});
const txt=(x:unknown)=>typeof x==='string'?x:'';
const safeTime=(x:unknown)=>{const n=Date.parse(String(x??''));return Number.isFinite(n)?n:NaN;};
async function readDurableMigrationCapture(db:Q,owner:string,account:string,capture:string){
 const r=await db.query(`SELECT c.*,c.effective_date::text AS effective_date_text
 FROM private.strata_railway_official_fee_capture_v5 c JOIN public.v13_production_account a ON a.id=c.execution_account_id
 WHERE c.capture_id=$1::bigint AND c.execution_account_id=$2 AND a.owner_user_id=$3::uuid
 AND c.captured_at<=clock_timestamp() AND c.expires_at>clock_timestamp()+interval '45 seconds' FOR SHARE OF c`,[capture,account,owner]);
 if(r.rows.length!==1)return null;const v=r.rows[0];
 if(!Buffer.isBuffer(v.original_bytes)||v.original_bytes.length<100||v.original_bytes.length>2_000_000||v.byte_length!==v.original_bytes.length||
 v.canonical_url!=='https://kalshi.com/docs/kalshi-fee-schedule.pdf'||v.source_kind!=='railway_canonical_https_direct'||
 v.policy_version!=='issuer_pdf_55m_signed_api_recheck_v2'||createHash('sha256').update(v.original_bytes).digest('hex')!==v.content_sha256)return null;
 const parsed=await verifyOfficialFeePdfBytes(v.original_bytes);
 return parsed.ok&&parsed.digest===v.content_sha256&&parsed.effectiveDate===v.effective_date_text?parsed:null;
}
/** Explicit owner mutation. Transaction fences account, policies, fee grant and in-flight orders. */
async function executeClaimedDurableFeeMigration(ownerId:string,raw:unknown,deps:Inputs={}):Promise<Result>{
 if(process.env.NODE_ENV!=='test'&&Object.keys(deps).length)return fail('production_override_forbidden');
 const b=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Row:{};
 const keys='accountId,captureId,confirmation,expectedPolicyHash,expectedPolicyId,expectedPolicyVersion,expectedSha,modelId,riskAcceptance';
 if(Object.keys(b).sort().join(',')!==keys||!UUID.test(ownerId)||b.confirmation!==DURABLE_MIGRATION_CONFIRM||
 b.riskAcceptance!==DURABLE_PUBLICATION_RISK_ACCEPTANCE||!POLICY_ID.test(txt(b.expectedPolicyId))||!SHA.test(txt(b.expectedPolicyHash))||
 !Number.isSafeInteger(b.expectedPolicyVersion)||Number(b.expectedPolicyVersion)<1||!UUID.test(txt(b.modelId))||
 !/^\d{1,18}$/.test(String(b.captureId))||!/^[a-f0-9]{40}$/.test(txt(b.expectedSha))||
 b.expectedSha!==(deps.sha??deployedGitSha)()||!ownerSelfEnrollmentAllowed(ownerId,txt(b.accountId),(deps.scope??configuredOwnerSelfScope)()))
 return fail('explicit_durable_migration_scope_consent_required');
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return fail('durable_fee_feature_disabled');
 const db=deps.db??pool;
 // Signed provider reads are intentionally OUTSIDE the serializable write
 // transaction. After the I/O completes, lock and re-check account revision,
 // credentials, policy ID, worker fence, cash and grant before any mutation.
 let tx:Awaited<ReturnType<Db["connect"]>>|null=null,done=false,commitAttempted=false,discard:Error|undefined;
 let pre:Row={};let requests:Request[]=[];let captureDigest="";
 let credentials:Awaited<ReturnType<typeof loadedMaterial>>=null;
 let feedStarted=0;
 let feeds:Awaited<ReturnType<typeof readOwnedKalshiFeeds>>={ok:false,reason:"unverified"};
 try {
   const preTx=await db.connect();
   try{
     const rows=await preTx.query("SELECT * FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2",[ownerId]);
     if(rows.rows.length!==1)return fail("owned_account_not_unique");
     pre=rows.rows[0]!;
     if(pre.commissioned!==true||pre.cash_precision_verified!==true)
       return fail("account_commissioning_unverified");
     if(pre.kill_switch!==true||pre.execution_enabled!==false)
       return fail("stop_and_disarm_before_fee_migration");
     if(txt(pre.id)!==b.accountId||txt(pre.policy_id)!==b.expectedPolicyId)
       return fail("policy_concurrency_conflict");
     if(pre.blocked_reason!=null)return fail('unresolved_account_risk_freeze');
     const source=await readDurableMigrationCapture(preTx,ownerId,txt(b.accountId),String(b.captureId));
     if(!source)return fail('durable_migration_genuine_capture_unverified');
     captureDigest=source.digest;
     credentials=await (deps.load??loadedMaterial)(preTx as never,{...pre,owner_id:ownerId});
     if(!credentials)return fail("restricted_signer_unavailable");
     const intentRows=await preTx.query("SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id",[pre.id]);
     requests=[];
     for(const row of intentRows.rows){
       const request=typeof row.request==="string"?JSON.parse(row.request):row.request;
       if(!request||typeof request!=="object"||Array.isArray(request))
         return fail("financial_intent_unreadable");
       requests.push(request as Request);
     }
   }finally{preTx.release();}
   // Release the DB connection BEFORE awaiting any external Kalshi requests.
   // Never monopolize pool capacity while an exchange call stalls or retries.
   if(!credentials)return fail("restricted_signer_unavailable");
   feedStarted=(deps.now??Date.now)();
   feeds=await (deps.read??readOwnedKalshiFeeds)(credentials,feedStarted);
 }catch{return fail("authenticated_exchange_preflight_unavailable");}
 finally{credentials=null;}
 if(!feeds.ok)return fail(feeds.reason);
 const feedAge=(deps.now??Date.now)()-feedStarted;
 if(feeds.observedAtMs!==feedStarted||feedAge<0||feedAge>45_000)
   return fail("authenticated_exchange_preflight_stale");
 const identity:Identity={subaccount:1,exchangeIndex:2,keyFingerprint:txt(pre.key_fingerprint)};
 const mapped=personalAccountSnapshot(identity,feeds,requests);
 if(!("identity" in mapped))return fail(mapped.reason);
 const flat=v3MigrationFlatHistoryCheck(mapped,requests);
 if(!flat.ok)return fail(flat.reason);
 try{
  tx=await db.connect();
  await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const attempt=await tx.query(`SELECT model_id FROM private.strata_durable_fee_migration_attempt
   WHERE model_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3 AND release_commit_sha=$4
   AND body_hash=$5 AND state='PENDING' FOR UPDATE`,[b.modelId,ownerId,b.accountId,b.expectedSha,migrationBodyHash(b)]);
  if(attempt.rows.length!==1)return fail('durable_migration_attempt_not_pending');
  const accounts=await tx.query(`SELECT * FROM public.v13_production_account
   WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE`,[ownerId]);
  if(accounts.rows.length!==1)return fail("owned_account_not_unique");
  const a=accounts.rows[0]!,id=txt(a.id);
  if(a.commissioned!==true||a.cash_precision_verified!==true)return fail("account_commissioning_unverified");
  if(a.kill_switch!==true||a.execution_enabled!==false)return fail("stop_and_disarm_before_fee_migration");
  if(a.blocked_reason!=null)return fail('unresolved_account_risk_freeze');
  if(!id||id!==txt(pre.id)||String(a.revision)!==String(pre.revision)||
     txt(a.key_fingerprint)!==txt(pre.key_fingerprint)||
     txt(a.kalshi_connection_id)!==txt(pre.kalshi_connection_id)||
     txt(a.policy_id)!==b.expectedPolicyId)return fail("policy_concurrency_conflict");
  // A revoked/replaced signer must not remain authorized merely because the
  // account revision stayed unchanged while signed flatness was read.
  const credential=await tx.query(`SELECT key_fingerprint FROM private.kalshi_connection_credentials
   WHERE owner_user_id=$1::uuid AND financial_account_id=$2 AND key_fingerprint=$3
   AND role='restricted_execution' AND revoked_at IS NULL AND verified_at IS NOT NULL
   AND verification_reason='credential_verified' FOR SHARE`,[ownerId,a.kalshi_connection_id,a.key_fingerprint]);
  if(credential.rows.length!==1)return fail('migration_credential_changed_or_revoked');
  const reconciled=safeTime(a.reconciled_at),now=(deps.now??Date.now)();
  if(!Number.isFinite(reconciled)||reconciled>now+10_000||now-reconciled>15*60_000)
   return fail("fresh_cash_reconciliation_required");
  const funds=BigInt(String(a.cash_micros)),reserved=BigInt(String(a.reserved_micros));
  if(funds<0n||reserved!==0n||String(feeds.cashMicros)!==String(a.cash_micros))return fail("cash_or_reservations_unverified");
  // The account revision fences policy/cash changes. A separate re-read
  // fingerprints the financial intent history so newly inserted terminal
  // events cannot escape because they did not bump the account revision.
  const lockedHistory=await tx.query(
    "SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id",[id]);
  const stableHistory=(rows:Row[])=>JSON.stringify(rows.map(row=>
    typeof row.request==="string"?JSON.parse(row.request):row.request));
  if(stableHistory(lockedHistory.rows)!==JSON.stringify(requests))
    return fail("financial_history_changed_during_migration");
  const exposure=await tx.query(`SELECT
   (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND terminal IS DISTINCT FROM TRUE) intents,
   (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
   (SELECT count(*)::int FROM private.kalshi_account_worker_lease
      WHERE execution_account_id=$1 AND (state='owned' OR arm_requested IS DISTINCT FROM FALSE)) workers,
   (SELECT count(*)::int FROM private.strata_emergency_exit_reservations
      WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits`,[id]);
  const ex=exposure.rows[0];
  if(exposure.rows.length!==1||[ex?.intents,ex?.positions,ex?.workers,ex?.exits].some(n=>n!==0))
   return fail("orders_positions_workers_or_exits_not_proven_empty");
  if((deps.now??Date.now)()-feedStarted>45_000)
   return fail("authenticated_exchange_preflight_stale");
  const rs=await tx.query(`SELECT * FROM public.v13_live_money_policy
   WHERE id=$1 AND execution_account_id=$2 AND created_by=$3
    AND state='APPROVED' FOR UPDATE`,[a.policy_id,id,ownerId]);
  const old=rs.rows.length===1?approvedFromRow(rs.rows[0]!):null;
  if(!old||old.policyHash!==computeV13LiveMoneyPolicyHash(old)||
     old.policyHash!==b.expectedPolicyHash||old.version!==b.expectedPolicyVersion)
   return fail("approved_policy_hash_or_version_changed");
  if(old.feePolicyVersion===DURABLE_FEE_VERSION)return fail('already_using_durable_fee_policy');
  const source=await readDurableMigrationCapture(tx,ownerId,id,String(b.captureId));
  if(!source||source.digest!==captureDigest)return fail('durable_migration_capture_changed_or_expired');
  // Copy all approved limits exactly. This migration changes fee authority,
  // never stake, budget, strategy, depth, order style or loss permissions.
  const limits=old;
  const leases=await tx.query(`SELECT state,arm_requested,account_kill
     FROM private.kalshi_account_worker_lease
     WHERE execution_account_id=$1 AND owner_user_id=$2::uuid
     FOR UPDATE`,[id,ownerId]);
  if(leases.rows.length>1)return fail("worker_lease_ambiguous");
  if(leases.rows.length===1){
    const lease=leases.rows[0]!;
    if(lease.arm_requested!==false||
      !((lease.state==="killed"&&lease.account_kill===true)||
        (lease.state==="released"&&lease.account_kill===false)))
      return fail("owner_worker_not_safely_disarmed");
  }
  // Activation intentionally never resurrects a revoked approval at the
  // same release SHA. Refuse BEFORE mutation instead of installing a policy
  // that this build can never activate. A fresh release needs fresh review.
  const currentShaApprovals=await tx.query(`SELECT release_commit_sha FROM private.strata_owner_sha_approvals
   WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3 FOR UPDATE`,[ownerId,id,b.expectedSha]);
  if(currentShaApprovals.rows.length!==0)return fail('durable_migration_fresh_release_sha_required');
  const versions=await tx.query(`SELECT COALESCE(MAX(version),0)::int last_version
    FROM public.v13_live_money_policy WHERE execution_account_id=$1`,[id]);
  const nextVersion=Number(versions.rows[0]?.last_version)+1;
  if(!Number.isSafeInteger(nextVersion)||nextVersion<=old.version)return fail("policy_version_unverified");
  const policyId=randomUUID(),at=new Date();
  const next={...old,id:policyId,version:nextVersion,supersedesPolicyId:old.id,
   capitalLimitCents:limits.capitalLimitCents,
   maxEntryStakeCents:limits.maxEntryStakeCents,
   maxEntryAllInCents:limits.maxEntryAllInCents,
   maxDailyLossCents:limits.maxDailyLossCents,
   maxTotalLossCents:limits.maxTotalLossCents,
   maxQuoteAgeMs:limits.maxQuoteAgeMs,
   maxFeeEvidenceAgeMs:limits.maxFeeEvidenceAgeMs,
   feePolicyVersion:DURABLE_FEE_VERSION,feeSourceUrl:"strata-durable-owner-fee://"+b.modelId,
   feeFormulaVersion:source.formulaVersion,approvedBy:ownerId,approvedAt:at};
  next.policyHash=computeV13LiveMoneyPolicyHash(next);
  const revoked=await tx.query(`UPDATE public.v13_live_money_policy SET state='REVOKED'
    WHERE id=$1 AND execution_account_id=$2 AND policy_hash=$3 AND state='APPROVED'
    RETURNING id`,[old.id,id,old.policyHash]);
  if(revoked.rows.length!==1)return fail("policy_revision_conflict");
  const inserted=await tx.query(`INSERT INTO public.v13_live_money_policy
   (id,version,supersedes_policy_id,state,execution_account_id,created_by,
    strategy_version,strategy_parameter_set_id,strategy_parameter_hash,entry_policy_version,
    champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,
    capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_open_positions,
    max_daily_loss_cents,max_total_loss_cents,max_quote_age_ms,max_fee_evidence_age_ms,
    fee_policy_version,fee_source_url,fee_formula_version,require_full_depth,
    entry_time_in_force,entry_limit_source,policy_hash,approved_by,approved_at)
   SELECT $1,$2,p.id,'APPROVED',p.execution_account_id,p.created_by,
     p.strategy_version,p.strategy_parameter_set_id,p.strategy_parameter_hash,p.entry_policy_version,
     p.champion_selection_review_id,p.champion_selection_evidence_hash,p.champion_selected_by,p.champion_selected_at,
     $11::int,$12::int,$13::int,p.max_open_positions,
     $14::int,$15::int,$16::int,$17::int,
     $3,$4,$5,p.require_full_depth,p.entry_time_in_force,p.entry_limit_source,$6,$7,$8
   FROM public.v13_live_money_policy p WHERE p.id=$9 AND p.state='REVOKED'
    AND p.execution_account_id=$10 RETURNING id`,[
   policyId,nextVersion,next.feePolicyVersion,next.feeSourceUrl,next.feeFormulaVersion,
   next.policyHash,ownerId,at.toISOString(),old.id,id,
   limits.capitalLimitCents,limits.maxEntryStakeCents,limits.maxEntryAllInCents,
   limits.maxDailyLossCents,limits.maxTotalLossCents,
   limits.maxQuoteAgeMs,limits.maxFeeEvidenceAgeMs]);
  if(inserted.rows.length!==1)return fail("replacement_policy_insert_failed");
  const commissioningDigest=createHash("sha256").update(JSON.stringify({
    accountId:id,fingerprint:txt(a.key_fingerprint),fee:source.digest,policyId
  })).digest("hex");
  const linked=await tx.query(`UPDATE public.v13_production_account
    SET policy_id=$1,fee_artifact_digest=$2,commissioning_digest=$3,revision=revision+1
    WHERE id=$4 AND owner_user_id=$5::uuid AND policy_id=$6
      AND kill_switch=true AND execution_enabled=false AND commissioned=true AND blocked_reason IS NULL
    RETURNING id`,[policyId,source.digest,commissioningDigest,id,ownerId,old.id]);
  if(linked.rows.length!==1)return fail("account_policy_switch_conflict");
  await tx.query(`UPDATE private.strata_owner_sha_approvals
    SET revoked_at=now() WHERE owner_user_id=$1::uuid
      AND execution_account_id=$2 AND revoked_at IS NULL`,[ownerId,id]);
  await tx.query(`INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,
   approved_policy_hash,source_capture_id,official_source_digest,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1',true)`,
   [b.modelId,ownerId,id,b.expectedSha,next.policyHash,b.captureId,source.digest,DURABLE_FEE_VERSION,source.formulaVersion,source.effectiveDate]);
  await tx.query('INSERT INTO private.strata_durable_owner_fee_state(model_id) VALUES($1)',[b.modelId]);
  const event={accountId:id,ownerId,oldPolicyId:old.id,newPolicyId:policyId,
   oldPolicyHash:old.policyHash,newPolicyHash:next.policyHash,feeDigest:source.digest,
   modelId:b.modelId,captureId:b.captureId,releaseSha:b.expectedSha,confirmation:DURABLE_MIGRATION_CONFIRM,
   riskAcceptance:DURABLE_PUBLICATION_RISK_ACCEPTANCE,limitsPreserved:true,staleActivationRequiresFreshRequest:true};
  await tx.query(`INSERT INTO private.strata_durable_fee_migration
   (model_id,owner_user_id,execution_account_id,release_commit_sha,prior_policy_id,prior_policy_hash,new_policy_id,new_policy_hash,source_digest,confirmation,risk_acceptance)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
   [b.modelId,ownerId,id,b.expectedSha,old.id,old.policyHash,policyId,next.policyHash,source.digest,DURABLE_MIGRATION_CONFIRM,DURABLE_PUBLICATION_RISK_ACCEPTANCE]);
  await tx.query(`INSERT INTO public.v13_production_observation (id,account_id,kind,payload,digest)
   VALUES($1,$2,'OWNER_DURABLE_FEE_POLICY_MIGRATION',$3::jsonb,$4)`,[randomUUID(),id,JSON.stringify(event),auditDigest(event)]);
  // Deferred model trigger rechecks source expiry/change at COMMIT.
  commitAttempted=true;
  await tx.query("COMMIT");done=true;
  return {ok:true,reason:"durable_fee_policy_migrated_requires_new_activation_request_and_sha_release",
   policyMigrated:true,tradingAuthorized:false,newPolicyId:policyId,newVersion:nextVersion,modelId:txt(b.modelId),newPolicyHash:next.policyHash};
 }catch{if(commitAttempted)discard=Error('durable_migration_commit_unknown');
 return {...fail(commitAttempted?'durable_migration_commit_unknown':'durable_migration_transaction_failed'),retryAuthorized:false};}
 finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK')}catch{discard=Error('durable_migration_rollback_unknown')}tx.release(discard);}}
}
/** Readback is audit only, never activation or authority to retry UNKNOWN. */
export async function durableMigrationOutcome(owner:string,modelId:string,sha:string,db:Q=pool){
 if(!UUID.test(owner)||!UUID.test(modelId)||!/^[a-f0-9]{40}$/.test(sha))return {outcome:'UNKNOWN' as const,tradingAuthorized:false};
 try{const r=await db.query(`SELECT x.* FROM private.strata_durable_fee_migration x
 JOIN private.strata_durable_owner_fee_model m ON m.model_id=x.model_id AND m.owner_user_id=x.owner_user_id
 AND m.execution_account_id=x.execution_account_id AND m.release_commit_sha=x.release_commit_sha
 AND m.approved_policy_hash=x.new_policy_hash AND m.official_source_digest=x.source_digest
 WHERE x.owner_user_id=$1::uuid AND x.model_id=$2::uuid AND x.release_commit_sha=$3`,[owner,modelId,sha]);
 if(r.rows.length!==1){
 const rejected=await db.query(`SELECT * FROM private.strata_durable_fee_migration_attempt
 WHERE owner_user_id=$1::uuid AND model_id=$2::uuid AND release_commit_sha=$3 AND state='REJECTED'`,[owner,modelId,sha]);
 if(rejected.rows.length!==1)return {outcome:'UNKNOWN' as const,tradingAuthorized:false};
 const a=rejected.rows[0],b=a.request as Row;
 return {outcome:'REJECTED' as const,ownerId:owner,modelId,sha,accountId:a.execution_account_id,
 priorPolicyId:b.expectedPolicyId,priorPolicyHash:b.expectedPolicyHash,priorPolicyVersion:b.expectedPolicyVersion,
 captureId:String(b.captureId),confirmation:b.confirmation,riskAcceptance:b.riskAcceptance,
 reason:a.reason,noCommit:true,sameModelRetryAllowed:false,tradingAuthorized:false};
 }const v=r.rows[0];
 return {outcome:'RECORDED' as const,ownerId:owner,modelId,sha,accountId:v.execution_account_id,
 priorPolicyId:v.prior_policy_id,priorPolicyHash:v.prior_policy_hash,newPolicyId:v.new_policy_id,policyHash:v.new_policy_hash,
 sourceDigest:v.source_digest,confirmation:v.confirmation,riskAcceptance:v.risk_acceptance,tradingAuthorized:false};
 }catch{return {outcome:'UNKNOWN' as const,tradingAuthorized:false};}
}
/** Non-mutating preview. Confirmation still performs signed history + locked CAS. */
export async function previewDurableFeeMigration(owner:string){
 const scope=configuredOwnerSelfScope(),sha=deployedGitSha();
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true'||!UUID.test(owner)||!scope||
 !ownerSelfEnrollmentAllowed(owner,scope.accountId,scope)||!/^[a-f0-9]{40}$/.test(sha))return fail('durable_migration_scope_or_feature_unavailable');
 try{const r=await pool.query(`SELECT p.*,a.id AS account_id,a.execution_enabled,a.kill_switch,a.blocked_reason,a.commissioned
 FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.subaccount=1 AND a.exchange_index=2 AND p.created_by=$1::text AND p.state='APPROVED'`,[owner,scope.accountId]);
 if(r.rows.length!==1)return fail('durable_migration_policy_scope_unavailable');const v=r.rows[0],old=approvedFromRow(v);
 if(!old||old.policyHash!==computeV13LiveMoneyPolicyHash(old))return fail('durable_migration_previous_policy_unverified');
 if(old.feePolicyVersion===DURABLE_FEE_VERSION)return fail('already_using_durable_fee_policy');
 const priorApproval=await pool.query('SELECT 1 FROM private.strata_owner_sha_approvals WHERE owner_user_id=$1::uuid AND execution_account_id=$2 AND release_commit_sha=$3 LIMIT 1',[owner,scope.accountId,sha]);
 if(priorApproval.rows.length)return fail('durable_migration_fresh_release_sha_required');
 if(v.execution_enabled!==false||v.kill_switch!==true||v.blocked_reason!=null||v.commissioned!==true)return fail('stopped_unblocked_commissioned_account_required');
 const c=await pool.query(`SELECT capture_id::text,content_sha256,captured_at,expires_at,effective_date::text FROM private.strata_railway_official_fee_capture_v5
 WHERE execution_account_id=$1 AND captured_at<=clock_timestamp() AND expires_at>clock_timestamp()+interval '45 seconds'
 ORDER BY captured_at DESC,capture_id DESC LIMIT 1`,[scope.accountId]);
 const capture=c.rows[0];if(!capture)return fail('genuine_current_capture_missing');
 return {ok:true as const,ownerId:owner,accountId:scope.accountId,sha,expectedPolicyId:old.id,expectedPolicyHash:old.policyHash,expectedPolicyVersion:old.version,
 candidateCapture:{captureId:capture.capture_id,digest:capture.content_sha256,capturedAt:capture.captured_at,expiresAt:capture.expires_at,effectiveDate:capture.effective_date},
 limits:{capitalLimitCents:old.capitalLimitCents,maxEntryStakeCents:old.maxEntryStakeCents,maxEntryAllInCents:old.maxEntryAllInCents,maxDailyLossCents:old.maxDailyLossCents,maxTotalLossCents:old.maxTotalLossCents,maxOpenPositions:old.maxOpenPositions},
 confirmation:DURABLE_MIGRATION_CONFIRM,riskAcceptance:DURABLE_PUBLICATION_RISK_ACCEPTANCE,publicationKnownCurrent:false,tradingAuthorized:false,policyMigrated:false};
 }catch{return fail('durable_migration_preview_unavailable');}
}

function migrationBodyHash(b:Row){return createHash('sha256').update(JSON.stringify(Object.keys(b).sort().map(k=>[k,b[k]]))).digest('hex');}
/** A public attempt ID can execute only once. A durable REJECTED receipt can
 * authorize a freshly reviewed NEW attempt, never replay of this model ID. */
export async function migrateOwnedDurableFeePolicy(owner:string,raw:unknown,deps:Inputs={}):Promise<Result>{
 if(process.env.NODE_ENV!=='test'&&Object.keys(deps).length)return fail('production_override_forbidden');
 const b=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Row:{};
 if(Object.keys(b).sort().join(',')!=='accountId,captureId,confirmation,expectedPolicyHash,expectedPolicyId,expectedPolicyVersion,expectedSha,modelId,riskAcceptance')return fail('durable_migration_attempt_body_invalid');
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true'||!UUID.test(owner)||!UUID.test(txt(b.modelId))||
 !/^[a-f0-9]{40}$/.test(txt(b.expectedSha))||b.expectedSha!==(deps.sha??deployedGitSha)()||
 !ownerSelfEnrollmentAllowed(owner,txt(b.accountId),(deps.scope??configuredOwnerSelfScope)()))return fail('durable_migration_attempt_scope_unavailable');
 const db=deps.db??pool;let claim:Awaited<ReturnType<Db['connect']>>|null=null;
 try{claim=await db.connect();const c=await claim.query(`INSERT INTO private.strata_durable_fee_migration_attempt
 (model_id,owner_user_id,execution_account_id,release_commit_sha,body_hash,request)
 VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(model_id) DO NOTHING RETURNING model_id`,
 [b.modelId,owner,b.accountId,b.expectedSha,migrationBodyHash(b),JSON.stringify(b)]);
 if(c.rows.length!==1)return {...fail('durable_migration_attempt_already_exists'),retryAuthorized:false};
 }catch{return {...fail('durable_migration_attempt_claim_unknown'),retryAuthorized:false};}finally{claim?.release();}
 const result=await executeClaimedDurableFeeMigration(owner,raw,deps);
 if(result.ok||result.reason==='durable_migration_commit_unknown')return result;
 // If rollback was uncertain this lock waits for its transaction to end. An
 // UNKNOWN lock/connection outcome never produces a false no-commit receipt.
 let c:Awaited<ReturnType<Db['connect']>>|null=null,done=false;
 try{c=await db.connect();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1500ms'");
 const a=await c.query(`SELECT model_id FROM private.strata_durable_fee_migration_attempt
 WHERE model_id=$1::uuid AND owner_user_id=$2::uuid AND body_hash=$3 AND state='PENDING' FOR UPDATE`,[b.modelId,owner,migrationBodyHash(b)]);
 if(a.rows.length!==1)return result;
 const model=await c.query('SELECT model_id FROM private.strata_durable_owner_fee_model WHERE model_id=$1::uuid',[b.modelId]);
 if(model.rows.length)return {...fail('durable_migration_outcome_requires_readback'),retryAuthorized:false};
 await c.query(`UPDATE private.strata_durable_fee_migration_attempt SET state='REJECTED',reason=$2,resolved_at=clock_timestamp()
 WHERE model_id=$1::uuid AND state='PENDING'`,[b.modelId,result.reason]);
 await c.query('COMMIT');done=true;
 }catch{/* leave UNKNOWN if durable rejection was not confirmed */}
 finally{if(c){if(!done)try{await c.query('ROLLBACK')}catch{}c.release();}}
 return result;
}

export const DURABLE_PENDING_CANCEL_CONFIRM='I_CANCEL_MY_PENDING_DURABLE_FEE_MIGRATION_ATTEMPT_V1';
/** Explicit cancellation, not a claim that a process died. The original writer
 * must lock this same row and prove PENDING before any financial-state write.
 * Thus delayed read-only preflight work cannot execute after cancellation. */
export async function cancelPendingDurableMigration(owner:string,raw:unknown,deps:Pick<Inputs,'db'|'scope'>={}){
 const unknown=(reason:string)=>({outcome:'UNKNOWN' as const,reason,tradingAuthorized:false,sameModelRetryAllowed:false});
 if(process.env.NODE_ENV!=='test'&&Object.keys(deps).length)return unknown('production_override_forbidden');
 const b=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Row:{};
 if(Object.keys(b).sort().join(',')!=='accountId,confirmation,expectedSha,modelId'||
 b.confirmation!==DURABLE_PENDING_CANCEL_CONFIRM||!UUID.test(owner)||!UUID.test(txt(b.modelId))||
 !/^[a-f0-9]{40}$/.test(txt(b.expectedSha))||!ownerSelfEnrollmentAllowed(owner,txt(b.accountId),(deps.scope??configuredOwnerSelfScope)()))
 return unknown('explicit_pending_migration_cancellation_required');
 let c:Awaited<ReturnType<Db['connect']>>|null=null,done=false,commitAttempted=false,discard:Error|undefined;
 try{c=await(deps.db??pool).connect();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1500ms'");await c.query("SET LOCAL statement_timeout='4000ms'");
 const attempt=await c.query(`SELECT state FROM private.strata_durable_fee_migration_attempt
 WHERE model_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3 AND release_commit_sha=$4 FOR UPDATE`,[b.modelId,owner,b.accountId,b.expectedSha]);
 if(attempt.rows.length!==1)return unknown('pending_migration_identity_unverified');
 // A successful or previously rejected migration returns historical evidence.
 // Never convert a committed model into a no-commit claim.
 const model=await c.query('SELECT model_id FROM private.strata_durable_owner_fee_model WHERE model_id=$1::uuid',[b.modelId]);
 if(model.rows.length||attempt.rows[0].state!=='PENDING')return await durableMigrationOutcome(owner,txt(b.modelId),txt(b.expectedSha),c);
 const event={modelId:b.modelId,ownerId:owner,accountId:b.accountId,sha:b.expectedSha,
 confirmation:DURABLE_PENDING_CANCEL_CONFIRM,reason:'owner_cancelled_pending_migration_before_commit',sameModelRetryAllowed:false};
 await c.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
 VALUES($1,$2,'OWNER_DURABLE_FEE_PENDING_CANCELLED',$3::jsonb,$4)`,[randomUUID(),b.accountId,JSON.stringify(event),auditDigest(event)]);
 await c.query(`UPDATE private.strata_durable_fee_migration_attempt
 SET state='REJECTED',reason='owner_cancelled_pending_migration_before_commit',resolved_at=clock_timestamp()
 WHERE model_id=$1::uuid AND state='PENDING'`,[b.modelId]);
 commitAttempted=true;await c.query('COMMIT');done=true;
 return await durableMigrationOutcome(owner,txt(b.modelId),txt(b.expectedSha),c);
 }catch{if(commitAttempted)discard=Error('pending_migration_cancellation_commit_unknown');return unknown(commitAttempted?'pending_migration_cancellation_commit_unknown':'pending_migration_cancellation_unconfirmed');}
 finally{if(c){if(!done&&!discard)try{await c.query('ROLLBACK')}catch{discard=Error('pending_migration_cancellation_rollback_unknown')}c.release(discard);}}
}
