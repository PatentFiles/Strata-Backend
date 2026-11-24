import {resolveOwnerSelfScope} from './ownerSelfServiceEligibility';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';
import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed} from './ownerSelfReviewMode';
import {HISTORICAL_SOURCE_KIND,HISTORICAL_FEE_VERSION,HISTORICAL_BASELINE_ID,HISTORICAL_BASELINE_SHA256,HISTORICAL_RISK_ACCEPTANCE,historicalBaselineEnabled} from './historicalOwnerFeeBaseline';
import {approvedFromRow} from './ownerStakePolicyAmendment';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {loadedMaterial} from './inAppProtectiveRelease';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {v3MigrationFlatHistoryCheck} from './ownerFeeV3Migration';
import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
import {preparePdfFreeApiFeePolicyReview} from './apiFeePolicyReviewCandidate';
export const DURABLE_REAUTH_CONFIRM='I_REAUTHORIZE_MY_EXISTING_HISTORICAL_FEE_MODEL_FOR_THIS_EXACT_RELEASE_V1';
export const DURABLE_REAUTH_CANCEL='I_CANCEL_MY_PENDING_DURABLE_FEE_RELEASE_AUTHORIZATION_V1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;type Q={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};type Client=Q&{release(error?:Error):void};type Db=Q&{connect():Promise<Client>};
type Deps={db?:Db;sha?:()=>string;scope?:typeof configuredOwnerSelfScope;now?:()=>number;load?:typeof loadedMaterial;read?:typeof readOwnedKalshiFeeds;probe?:typeof probeCurrentKalshiFeeApi};
const noAuthority={tradingAuthorized:false as const,workerStarted:false as const,ordersSubmitted:false as const,retryAuthorized:false as const};
const no=(reason:string)=>({ok:false as const,reason,...noAuthority});
const str=(v:unknown)=>typeof v==='string'?v:'';
const enabled=()=>process.env.STRATA_DURABLE_OWNER_FEE_ENABLED==='true'&&historicalBaselineEnabled();
export function validDurableReauthorizationBody(raw:unknown):raw is Row{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;const b=raw as Row;
 return Object.keys(b).sort().join(',')==='accountId,authorizationId,confirmation,expectedSha,modelId,originalSha,policyHash,riskAcceptance,sourceDigest'&&
 UUID.test(str(b.authorizationId))&&UUID.test(str(b.modelId))&&SHA.test(str(b.originalSha))&&SHA.test(str(b.expectedSha))&&b.originalSha!==b.expectedSha&&
 HASH.test(str(b.policyHash))&&HASH.test(str(b.sourceDigest))&&typeof b.accountId==='string'&&b.accountId.length>0&&b.accountId.length<=200&&b.confirmation===DURABLE_REAUTH_CONFIRM&&b.riskAcceptance===HISTORICAL_RISK_ACCEPTANCE;
}
async function scopeRow(db:Q,owner:string,account:string,lock=false){
 const r=await db.query(`SELECT m.*,m.effective_date::text AS effective_date_text,s.entry_revoked,s.known_publication_change,
 b.original_bytes,b.content_sha256 AS baseline_digest,a.revision AS account_revision,a.key_fingerprint,a.kalshi_connection_id,
 a.reconciled_at,a.cash_micros,a.reserved_micros,a.initial_cash_micros,a.policy_id,a.execution_enabled,a.kill_switch,a.blocked_reason,a.commissioned,a.cash_precision_verified,
 a.fee_artifact_digest,to_jsonb(p) AS policy
 FROM private.strata_durable_owner_fee_model m JOIN private.strata_durable_owner_fee_state s USING(model_id)
 JOIN private.strata_durable_historical_baseline b ON b.baseline_id=m.historical_baseline_id
 JOIN public.v13_production_account a ON a.id=m.execution_account_id AND a.owner_user_id=m.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE m.owner_user_id=$1::uuid AND m.execution_account_id=$2 AND a.subaccount=1 AND a.exchange_index=2
 AND p.created_by=$1::text AND p.state='APPROVED' AND p.policy_hash=m.approved_policy_hash
 AND p.fee_source_url='strata-durable-owner-fee://'||m.model_id::text AND p.fee_policy_version=m.policy_version AND p.fee_formula_version=m.formula_version
 ${lock?'FOR UPDATE OF a FOR SHARE OF m,s,p':''}`,[owner,account]);
 if(r.rows.length!==1)return null;const m=r.rows[0],p=approvedFromRow(m.policy as Row);
 if(!p||p.policyHash!==computeV13LiveMoneyPolicyHash(p)||m.source_kind!==HISTORICAL_SOURCE_KIND||m.policy_version!==HISTORICAL_FEE_VERSION||m.genuine_source_verified!==false||m.source_capture_id!==null||
 m.historical_baseline_id!==HISTORICAL_BASELINE_ID||m.baseline_digest!==HISTORICAL_BASELINE_SHA256||m.official_source_digest!==HISTORICAL_BASELINE_SHA256||
 !Buffer.isBuffer(m.original_bytes)||createHash('sha256').update(m.original_bytes).digest('hex')!==HISTORICAL_BASELINE_SHA256||m.formula_version!=='standard-quadratic-0.07-v1'||m.effective_date_text!=='2026-07-07'||
 m.entry_revoked!==false||m.known_publication_change!==false||m.execution_enabled!==false||m.kill_switch!==true||m.blocked_reason!==null||m.commissioned!==true||m.cash_precision_verified!==true||String(m.reserved_micros)!=='0'||m.fee_artifact_digest!==m.official_source_digest)return null;
 const lease=await db.query(`SELECT state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid ${lock?'FOR UPDATE':''}`,[account,owner]);
 if(lease.rows.length!==1||lease.rows[0].state!=='killed'||lease.rows[0].account_kill!==true||lease.rows[0].arm_requested!==false)return null;
 const conflict=await db.query('SELECT 1 FROM private.strata_railway_official_fee_capture_v5 WHERE execution_account_id=$1 AND content_sha256<>$2 LIMIT 1',[account,m.official_source_digest]);if(conflict.rows.length)return null;
 return {m,p};
}
function matches(m:Row,b:Row){return m.model_id===b.modelId&&m.release_commit_sha===b.originalSha&&m.approved_policy_hash===b.policyHash&&m.official_source_digest===b.sourceDigest;}
function tuple(r:Row){return {authorizationId:r.authorization_id,ownerId:r.owner_user_id,accountId:r.execution_account_id,modelId:r.model_id,originalSha:r.original_release_sha,sha:r.release_commit_sha,policyHash:r.policy_hash,sourceDigest:r.source_digest,confirmation:r.confirmation,riskAcceptance:r.risk_acceptance,sourceKind:HISTORICAL_SOURCE_KIND,baselineId:HISTORICAL_BASELINE_ID,effectiveDate:'2026-07-07',sourceAuthenticityVerified:false as const,publicationKnownCurrent:false as const,...noAuthority};}
export async function durableFeeReauthorizationPreview(owner:string,d:Pick<Deps,'db'|'sha'|'scope'>={}){
 if(process.env.NODE_ENV!=='test'&&Object.keys(d).length)return no('production_override_forbidden');
 const sha=(d.sha??deployedGitSha)(),configured=d.scope?d.scope():await resolveOwnerSelfScope(pool,owner,sha);if(!enabled()||!UUID.test(owner)||!configured||!SHA.test(sha)||!ownerSelfEnrollmentAllowed(owner,configured.accountId,configured))return no('durable_reauthorization_scope_unavailable');
 try{const db=d.db??pool,found=await scopeRow(db,owner,configured.accountId);if(!found)return no('durable_reauthorization_historical_stopped_scope_unverified');const {m,p}=found;
 const reconciled=new Date(String(m.reconciled_at)).getTime();if(!Number.isFinite(reconciled)||reconciled>Date.now()+10000||Date.now()-reconciled>900000)return no('durable_reauthorization_fresh_reconciliation_required');
 if(m.release_commit_sha===sha)return no('durable_reauthorization_different_release_required');
 const attempts=await db.query("SELECT authorization_id FROM private.strata_durable_fee_release_authorization WHERE model_id=$1 AND release_commit_sha=$2 AND state IN('PENDING','RECORDED') LIMIT 1",[m.model_id,sha]);if(attempts.rows.length)return no('durable_reauthorization_existing_attempt_requires_readback');
 return {ok:true as const,ownerId:owner,accountId:configured.accountId,sha,modelId:m.model_id,originalSha:m.release_commit_sha,policyHash:p.policyHash,sourceDigest:m.official_source_digest,sourceKind:HISTORICAL_SOURCE_KIND,baselineId:HISTORICAL_BASELINE_ID,effectiveDate:'2026-07-07',sourceAuthenticityVerified:false,publicationKnownCurrent:false,confirmation:DURABLE_REAUTH_CONFIRM,riskAcceptance:HISTORICAL_RISK_ACCEPTANCE,
 limits:{capitalLimitCents:p.capitalLimitCents,maxEntryStakeCents:p.maxEntryStakeCents,maxEntryAllInCents:p.maxEntryAllInCents,maxDailyLossCents:p.maxDailyLossCents,maxTotalLossCents:p.maxTotalLossCents,maxOpenPositions:p.maxOpenPositions},...noAuthority};
 }catch{return no('durable_reauthorization_preview_unavailable');}
}
export async function durableFeeReauthorizationOutcome(owner:string,id:string,sha:string,db:Q=pool){
 const unknown=()=>({outcome:'UNKNOWN' as const,...noAuthority});if(!UUID.test(owner)||!UUID.test(id)||!SHA.test(sha))return unknown();
 try{const r=await db.query('SELECT * FROM private.strata_durable_fee_release_authorization WHERE authorization_id=$1::uuid AND owner_user_id=$2::uuid AND release_commit_sha=$3',[id,owner,sha]);if(r.rows.length!==1)return unknown();const v=r.rows[0];
 if(v.state==='RECORDED')return {outcome:'RECORDED' as const,...tuple(v)};
 if(v.state==='REJECTED')return {outcome:'REJECTED' as const,...tuple(v),reason:v.reason,noCommit:true};return unknown();
 }catch{return unknown();}
}
async function execute(owner:string,b:Row,d:Deps){
 const db=d.db??pool,now=d.now??Date.now;let tx:Client|undefined,done=false,commitAttempted=false,discard:Error|undefined;
 try{
 const found=await scopeRow(db,owner,str(b.accountId));if(!found||!matches(found.m,b))return no('durable_reauthorization_prior_model_changed_or_revoked');
 const m=found.m;const history=await readNeverPostedReleaseHistory(db,str(b.accountId),false,{expiredExitOwnerId:owner});
 const material=await(d.load??loadedMaterial)(db as never,{...m,id:b.accountId,owner_id:owner});if(!material)return no('durable_reauthorization_signer_unavailable');
 const signedMono=performance.now(),start=now(),feeds=await(d.read??readOwnedKalshiFeeds)(material,start);if(!feeds.ok)return no('durable_reauthorization_signed_history_unavailable');
 if(feeds.observedAtMs!==start||now()<start||now()-start>45000)return no('durable_reauthorization_signed_history_stale');
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:str(m.key_fingerprint)},feeds,history.requests);if(!('identity' in snapshot))return no('durable_reauthorization_signed_history_unverified');
 const excluded=new Set(history.neverPosted.map(x=>x.clientOrderId));if(snapshot.orders.some(o=>excluded.has(o.request.clientOrderId))||(excluded.size>0&&feeds.historicalCoverageComplete!==true)||!v3MigrationFlatHistoryCheck(snapshot,history.expectedRequests).ok)return no('durable_reauthorization_history_not_flat_or_complete');
 const marketMono=performance.now(),marketStarted=now(),market=await(d.probe??probeCurrentKalshiFeeApi)();const fee=preparePdfFreeApiFeePolicyReview(market,now());if(!fee.ok||now()<marketStarted||now()-marketStarted>5000)return no('durable_reauthorization_fresh_market_unverified');
 tx=await db.connect();await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='12000ms'");
 const attempt=await tx.query("SELECT authorization_id FROM private.strata_durable_fee_release_authorization WHERE authorization_id=$1 AND owner_user_id=$2 AND state='PENDING' FOR UPDATE",[b.authorizationId,owner]);if(attempt.rows.length!==1)return no('durable_reauthorization_attempt_not_pending');
 const locked=await scopeRow(tx,owner,str(b.accountId),true);if(!locked||!matches(locked.m,b)||String(locked.m.account_revision)!==String(m.account_revision)||locked.m.policy_id!==m.policy_id||locked.m.key_fingerprint!==m.key_fingerprint||locked.m.kalshi_connection_id!==m.kalshi_connection_id)return no('durable_reauthorization_scope_changed');
 const credential=await tx.query("SELECT 1 FROM private.kalshi_connection_credentials WHERE owner_user_id=$1 AND financial_account_id=$2 AND key_fingerprint=$3 AND role='restricted_execution' AND revoked_at IS NULL AND verified_at IS NOT NULL AND verification_reason='credential_verified' FOR SHARE",[owner,m.kalshi_connection_id,m.key_fingerprint]);if(credential.rows.length!==1)return no('durable_reauthorization_signer_changed');
 const lockedHistory=await readNeverPostedReleaseHistory(tx,str(b.accountId),true,{expiredExitOwnerId:owner});if(lockedHistory.historyDigest!==history.historyDigest)return no('durable_reauthorization_history_changed');
 if(String(feeds.cashMicros)!==String(locked.m.cash_micros))return no('durable_reauthorization_signed_cash_mismatch');
 const reconciled=new Date(String(locked.m.reconciled_at)).getTime();if(!Number.isFinite(reconciled)||reconciled>now()+10000||now()-reconciled>900000)return no('durable_reauthorization_fresh_reconciliation_required');
 const exposure=await tx.query(`SELECT
 (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND terminal IS DISTINCT FROM TRUE) intents,
 (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
 (SELECT count(*)::int FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND (state='owned' OR arm_requested IS DISTINCT FROM FALSE)) workers,
 (SELECT count(*)::int FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN('PREPARED','DISPATCHED','UNKNOWN')) exits`,[b.accountId]);
 if(exposure.rows.length!==1||[exposure.rows[0].intents,exposure.rows[0].positions,exposure.rows[0].workers,exposure.rows[0].exits].some(n=>n!==0))return no('durable_reauthorization_open_exposure');
 if(now()<start||now()-start>45000||performance.now()-signedMono>45000||now()<marketStarted||now()-marketStarted>5000||performance.now()-marketMono>5000)return no('durable_reauthorization_evidence_expired');
 const saved=await tx.query("UPDATE private.strata_durable_fee_release_authorization SET state='RECORDED',reason='explicit_owner_exact_build_reauthorization',resolved_at=clock_timestamp(),signed_deadline=$3::timestamptz,market_deadline=$4::timestamptz WHERE authorization_id=$1 AND owner_user_id=$2 AND state='PENDING' RETURNING authorization_id",[b.authorizationId,owner,new Date(start+45000).toISOString(),new Date(marketStarted+5000).toISOString()]);if(saved.rows.length!==1)return no('durable_reauthorization_write_conflict');
 commitAttempted=true;await tx.query('COMMIT');done=true;return {ok:true as const,reason:'durable_fee_exact_release_reauthorized',authorizationId:b.authorizationId,...noAuthority};
 }catch{if(commitAttempted)discard=Error('durable_reauthorization_commit_unknown');return no(commitAttempted?'durable_reauthorization_commit_unknown':'durable_reauthorization_refused');}
 finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK')}catch{discard=Error('durable_reauthorization_rollback_unknown')}tx.release(discard);}}
}
export async function reauthorizeDurableFeeRelease(owner:string,raw:unknown,d:Deps={}){
 if(process.env.NODE_ENV!=='test'&&Object.keys(d).length)return no('production_override_forbidden');
 if(!enabled()||!UUID.test(owner)||!validDurableReauthorizationBody(raw))return no('explicit_durable_reauthorization_required');const b=raw;
 if(b.expectedSha!==(d.sha??deployedGitSha)()||!ownerSelfEnrollmentAllowed(owner,str(b.accountId),(d.scope?d.scope():await resolveOwnerSelfScope(pool,owner,b.expectedSha))))return no('durable_reauthorization_scope_invalid');
 const db=d.db??pool;
 try{const claim=await db.query(`INSERT INTO private.strata_durable_fee_release_authorization(authorization_id,model_id,owner_user_id,execution_account_id,original_release_sha,release_commit_sha,policy_hash,source_digest,confirmation,risk_acceptance)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING authorization_id`,[b.authorizationId,b.modelId,owner,b.accountId,b.originalSha,b.expectedSha,b.policyHash,b.sourceDigest,b.confirmation,b.riskAcceptance]);if(claim.rows.length!==1)return no('durable_reauthorization_existing_attempt_requires_readback');}catch{return no('durable_reauthorization_claim_unknown');}
 const result=await execute(owner,b,d);if(result.ok||result.reason==='durable_reauthorization_commit_unknown')return result;
 // Row lock waits out an uncertain rollback; never declares no commit while a writer can still commit.
 let tx:Client|undefined,done=false,commitAttempted=false,discard:Error|undefined;
 try{tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SELECT authorization_id FROM private.strata_durable_fee_release_authorization WHERE authorization_id=$1 AND owner_user_id=$2 FOR UPDATE",[b.authorizationId,owner]);await tx.query("UPDATE private.strata_durable_fee_release_authorization SET state='REJECTED',reason=$3,resolved_at=clock_timestamp() WHERE authorization_id=$1 AND owner_user_id=$2 AND state='PENDING'",[b.authorizationId,owner,result.reason]);commitAttempted=true;await tx.query('COMMIT');done=true;}catch{if(commitAttempted)discard=Error('reauthorization_finalization_unknown')}finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK')}catch{discard=Error('reauthorization_rollback_unknown')}tx.release(discard);}}
 return result;
}
export async function cancelDurableFeeReauthorization(owner:string,raw:unknown,db:Db=pool){
 const b=raw as Row;if(!UUID.test(owner)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='accountId,authorizationId,confirmation,expectedSha,modelId'||!UUID.test(str(b.authorizationId))||!UUID.test(str(b.modelId))||!SHA.test(str(b.expectedSha))||b.confirmation!==DURABLE_REAUTH_CANCEL)return {outcome:'UNKNOWN' as const,...noAuthority};
 let tx:Client|undefined,done=false,commitAttempted=false,discard:Error|undefined;try{tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms'");const r=await tx.query("SELECT authorization_id FROM private.strata_durable_fee_release_authorization WHERE authorization_id=$1 AND model_id=$2 AND owner_user_id=$3 AND execution_account_id=$4 AND release_commit_sha=$5 FOR UPDATE",[b.authorizationId,b.modelId,owner,b.accountId,b.expectedSha]);if(r.rows.length!==1)return {outcome:'UNKNOWN' as const,...noAuthority};await tx.query("UPDATE private.strata_durable_fee_release_authorization SET state='REJECTED',reason='owner_canceled_pending_reauthorization',resolved_at=clock_timestamp() WHERE authorization_id=$1 AND state='PENDING'",[b.authorizationId]);commitAttempted=true;await tx.query('COMMIT');done=true;}catch{if(commitAttempted)discard=Error('reauthorization_cancel_unknown');return {outcome:'UNKNOWN' as const,...noAuthority};}finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK')}catch{discard=Error('reauthorization_rollback_unknown')}tx.release(discard);}}
 return durableFeeReauthorizationOutcome(owner,str(b.authorizationId),str(b.expectedSha),db);
}
