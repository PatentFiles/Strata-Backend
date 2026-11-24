import {durableReleaseMatch} from './durableFeeReleaseBinding';
/** Isolated server-side candidate. Actor must come from AAL2 middleware;
 * Public production is atomic migration only; no publisher/capture is invoked here. */
import {createHash,randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {verifyOfficialFeePdfBytes} from '../microLiveFeeArtifact';
import {deployedGitSha} from './deployedGitSha';
import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed} from './ownerSelfReviewMode';
import {DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';
const CONFIRM='I_APPROVE_VERSIONED_DURABLE_OFFICIAL_FEE_TERMS_V1';
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type Row=Record<string,unknown>;
type Client={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>;release(error?:Error):void};
type Db={connect():Promise<Client>};
type Deps={db?:Db;sha?:()=>string;scope?:typeof configuredOwnerSelfScope;clock?:()=>number};
const deny=(reason:string)=>({ok:false as const,reason,tradingAuthorized:false as const});
const iso=(x:unknown)=>x instanceof Date?x.toISOString():String(x??'');
const bytesVerified=(r:Row)=>Buffer.isBuffer(r.original_bytes)&&r.original_bytes.length>=100&&r.original_bytes.length<=2_000_000&&
 r.byte_length===r.original_bytes.length&&r.canonical_url==='https://kalshi.com/docs/kalshi-fee-schedule.pdf'&&r.source_kind==='railway_canonical_https_direct'&&
 r.policy_version==='issuer_pdf_55m_signed_api_recheck_v2'&&createHash('sha256').update(r.original_bytes).digest('hex')===r.content_sha256;
export async function enrollDurableOwnerFee(owner:string,raw:unknown,d:Deps={}){
 if(process.env.NODE_ENV!=='test'&&Object.keys(d).length)return deny('production_override_forbidden');
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return deny('durable_fee_feature_disabled');
 if(!UUID.test(owner)||!raw||typeof raw!=='object'||Array.isArray(raw))return deny('explicit_durable_fee_consent_required');
 const b=raw as Row;
 if(Object.keys(b).sort().join(',')!=='accountId,captureId,confirmation,expectedSha,modelId,policyHash'||b.confirmation!==CONFIRM||
 !UUID.test(String(b.modelId))||!/^\d{1,18}$/.test(String(b.captureId))||!HASH.test(String(b.policyHash))||
 !/^[a-f0-9]{40}$/.test(String(b.expectedSha))||b.expectedSha!==(d.sha??deployedGitSha)()||
 !ownerSelfEnrollmentAllowed(owner,String(b.accountId),(d.scope?d.scope():configuredOwnerSelfScope(owner,String(b.expectedSha)))))return deny('durable_fee_scope_or_consent_invalid');
 const c=await(d.db??pool).connect();let commitAttempted=false,committed=false,discard:Error|undefined;
 try{
 await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1500ms'");
 const capture=await c.query(`SELECT c.*,c.effective_date::text AS effective_date_text FROM private.strata_railway_official_fee_capture_v5 c
 JOIN public.v13_production_account a ON a.id=c.execution_account_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE c.capture_id=$1::bigint AND a.id=$2 AND a.owner_user_id=$3::uuid
 AND a.commissioned=true AND a.execution_enabled=false AND a.kill_switch=true AND a.reserved_micros=0
 AND a.subaccount=1 AND a.exchange_index=2 AND a.fee_artifact_digest=c.content_sha256
 AND p.state='APPROVED' AND p.policy_hash=$4 AND p.fee_source_url=$5
 AND p.fee_policy_version=$6 AND p.fee_formula_version='standard-quadratic-0.07-v1'
 AND c.captured_at<=clock_timestamp() AND c.expires_at>clock_timestamp()
 FOR SHARE OF c,a,p`,[b.captureId,b.accountId,owner,b.policyHash,'strata-durable-owner-fee://'+b.modelId,DURABLE_FEE_VERSION]);
 if(capture.rows.length!==1||!bytesVerified(capture.rows[0]))return deny('durable_fee_genuine_source_scope_unverified');
 const source=capture.rows[0],parsed=await verifyOfficialFeePdfBytes(source.original_bytes as Buffer);
 if(!parsed.ok||parsed.digest!==source.content_sha256||parsed.effectiveDate!==String(source.effective_date_text))return deny('durable_fee_strict_terms_unverified');
 await c.query(`INSERT INTO private.strata_durable_owner_fee_model(model_id,owner_user_id,execution_account_id,release_commit_sha,
 approved_policy_hash,source_capture_id,official_source_digest,policy_version,formula_version,effective_date,confirmation,genuine_source_verified)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,[b.modelId,owner,b.accountId,b.expectedSha,b.policyHash,b.captureId,parsed.digest,DURABLE_FEE_VERSION,parsed.formulaVersion,parsed.effectiveDate,CONFIRM]);
 await c.query('INSERT INTO private.strata_durable_owner_fee_state(model_id) VALUES($1)',[b.modelId]);
 // Recheck original capture expiry after parsing and immediately before COMMIT.
 const fresh=await c.query('SELECT 1 FROM private.strata_railway_official_fee_capture_v5 WHERE capture_id=$1 AND expires_at>clock_timestamp()',[b.captureId]);
 if(fresh.rows.length!==1)return deny('durable_fee_capture_expired_during_enrollment');
 commitAttempted=true;await c.query('COMMIT');committed=true;
 return {ok:true as const,modelId:b.modelId,sourceDigest:parsed.digest,tradingAuthorized:false as const,workerStarted:false as const};
 }catch{if(commitAttempted)discard=Error('durable_fee_commit_unknown');return {...deny(commitAttempted?'durable_fee_commit_unknown':'durable_fee_enrollment_refused'),retryAuthorized:false};}
 finally{if(!committed&&!discard)try{await c.query('ROLLBACK')}catch{discard=Error('durable_fee_rollback_unknown')}c.release(discard)}
}
/** Read-only with respect to issuer/capture/cooldown; persists its own audit
 * and latch. The collector remains sole source of new genuine captures. */
export async function inspectDurableFeePublication(modelId:string,d:Pick<Deps,'db'>={}){
 if(process.env.NODE_ENV!=='test'&&Object.keys(d).length)return deny('production_override_forbidden');
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true'||!UUID.test(modelId))return deny('durable_fee_feature_or_identity_invalid');
 const c=await(d.db??pool).connect();let committed=false;
 try{
 await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1500ms'");
 const m=await c.query(`SELECT m.*,s.known_publication_change AS latched_change,original.captured_at AS original_captured_at FROM private.strata_durable_owner_fee_model m
 JOIN private.strata_durable_owner_fee_state s ON s.model_id=m.model_id
 LEFT JOIN private.strata_railway_official_fee_capture_v5 original ON original.capture_id=m.source_capture_id
 WHERE m.model_id=$1 FOR UPDATE OF s`,[modelId]);
 if(m.rows.length!==1)return deny('durable_fee_model_missing');
 const model=m.rows[0];
 // Process ALL as-yet-uninspected captures, including expired evidence. A
 // changed document followed by a revert must still latch. NOT EXISTS rather
 // than a sequence high-watermark also handles out-of-order transaction commit.
 const captures=await c.query(`SELECT capture.* FROM private.strata_railway_official_fee_capture_v5 capture
 WHERE execution_account_id=$1 AND ($2::timestamptz IS NULL OR captured_at>=$2) AND captured_at<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM private.strata_durable_fee_publication_observation o
 WHERE o.model_id=$3 AND o.source_capture_id=capture.capture_id)
 ORDER BY capture_id LIMIT 1001`,[model.execution_account_id,model.original_captured_at,modelId]);
 let changed=false,invalid=captures.rows.length>1000;
 for(const source of captures.rows.slice(0,1000)){
  const valid=bytesVerified(source);
  const rowChanged=valid&&source.content_sha256!==model.official_source_digest;
  changed ||= rowChanged;invalid ||= !valid;
  await c.query(`INSERT INTO private.strata_durable_fee_publication_observation(observation_id,model_id,source_capture_id,source_digest,result)
   VALUES($1,$2,$3,$4,$5)`,[randomUUID(),modelId,source.capture_id,valid?source.content_sha256:null,
    !valid?'invalid':rowChanged?'changed':'unchanged']);
 }
 // A previously inspected fresh matching capture can still explain the most
 // recent status without restamping it or reprocessing its original bytes.
 const current=await c.query(`SELECT 1 FROM private.strata_railway_official_fee_capture_v5 capture
 WHERE execution_account_id=$1 AND expires_at>clock_timestamp() AND captured_at<=clock_timestamp()
 AND content_sha256=$2 AND EXISTS(SELECT 1 FROM private.strata_durable_fee_publication_observation o
 WHERE o.model_id=$3 AND o.source_capture_id=capture.capture_id AND o.result='unchanged') LIMIT 1`,
 [model.execution_account_id,model.official_source_digest,modelId]);
 const kind=invalid?'invalid':changed||model.latched_change===true?'changed':current.rows.length?'unchanged':'unavailable';
 if(kind==='unavailable'||captures.rows.length>1000)
  await c.query(`INSERT INTO private.strata_durable_fee_publication_observation(observation_id,model_id,source_capture_id,source_digest,result)
  VALUES($1,$2,NULL,NULL,$3)`,[randomUUID(),modelId,kind==='unavailable'?'unavailable':'invalid']);
 await c.query(`UPDATE private.strata_durable_owner_fee_state SET known_publication_change=known_publication_change OR $2,
 monitor_state=CASE WHEN known_publication_change OR $2 THEN 'changed' ELSE $3 END WHERE model_id=$1`,[modelId,changed||invalid,kind]);
 await c.query('COMMIT');committed=true;return {ok:true as const,result:kind,tradingAuthorized:false as const};
 }catch{return deny('durable_fee_monitor_unavailable');}
 finally{if(!committed)try{await c.query('ROLLBACK')}catch{}c.release()}
}
/** UNKNOWN enrollment responses are resolved by durable identity readback,
 * never by treating a transport error as permission to issue again. */
export async function durableFeeEnrollmentOutcome(owner:string,modelId:string,sha:string,
 db:{query(sql:string,args:unknown[]):Promise<{rows:Row[]}>}=pool){
 if(!UUID.test(owner)||!UUID.test(modelId)||!/^[a-f0-9]{40}$/.test(sha))return {outcome:'UNKNOWN' as const};
 try{const r=await db.query(`SELECT m.model_id,m.owner_user_id,m.execution_account_id,m.release_commit_sha,m.approved_policy_hash,m.official_source_digest,m.source_kind,m.historical_baseline_id,m.genuine_source_verified,m.effective_date::text AS source_effective_date,s.entry_revoked,s.known_publication_change
 FROM private.strata_durable_owner_fee_model m JOIN private.strata_durable_owner_fee_state s USING(model_id)
 WHERE m.model_id=$1::uuid AND m.owner_user_id=$2::uuid AND m.release_commit_sha=$3`,[modelId,owner,sha]);
 if(r.rows.length!==1)return {outcome:'UNKNOWN' as const};
 return {outcome:'RECORDED' as const,modelId,ownerId:r.rows[0].owner_user_id,accountId:r.rows[0].execution_account_id,sha:r.rows[0].release_commit_sha,policyHash:r.rows[0].approved_policy_hash,sourceDigest:r.rows[0].official_source_digest,
 sourceKind:r.rows[0].source_kind,baselineId:r.rows[0].historical_baseline_id,sourceEffectiveDate:r.rows[0].source_effective_date,sourceAuthenticityVerified:r.rows[0].genuine_source_verified===true,publicationKnownCurrent:false,entryRevoked:r.rows[0].entry_revoked,knownPublicationChange:r.rows[0].known_publication_change,tradingAuthorized:false as const};
 }catch{return {outcome:'UNKNOWN' as const};}
}

export async function durableFeeStatus(owner:string){
 if(!UUID.test(owner))return deny('durable_fee_owner_invalid');
 const sha=deployedGitSha(),configured=configuredOwnerSelfScope(owner,sha);
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return deny('durable_fee_feature_disabled');
 if(!configured||!ownerSelfEnrollmentAllowed(owner,configured.accountId,configured))return deny('durable_fee_scope_not_enrolled');
 try{
 const rows=await pool.query(`SELECT a.id,a.execution_enabled,a.kill_switch,a.policy_id,p.policy_hash,p.fee_policy_version,p.fee_source_url,
 p.state,m.model_id::text,m.source_kind,m.historical_baseline_id,m.genuine_source_verified,m.effective_date::text AS source_effective_date,m.official_source_digest,s.entry_revoked,s.known_publication_change,s.monitor_state
 FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 LEFT JOIN private.strata_durable_owner_fee_model m ON m.execution_account_id=a.id AND m.owner_user_id=a.owner_user_id
 AND ${durableReleaseMatch('$2')} AND m.approved_policy_hash=p.policy_hash
 LEFT JOIN private.strata_durable_owner_fee_state s ON s.model_id=m.model_id
 WHERE a.owner_user_id=$1::uuid AND a.id=$3 AND a.subaccount=1 AND a.exchange_index=2`,[owner,sha,configured.accountId]);
 if(rows.rows.length!==1)return deny('durable_fee_scope_ambiguous');
 const r=rows.rows[0],id=/^strata-durable-owner-fee:\/\/([a-f0-9-]{36})$/.exec(String(r.fee_source_url))?.[1];
 const capture=await pool.query(`SELECT capture_id::text,content_sha256,captured_at,expires_at,effective_date::text
 FROM private.strata_railway_official_fee_capture_v5 WHERE execution_account_id=$1
 AND captured_at<=clock_timestamp() AND expires_at>clock_timestamp() ORDER BY captured_at DESC,capture_id DESC LIMIT 1`,[r.id]);
 const c=capture.rows[0];
 const ready=!!id&&UUID.test(id)&&r.fee_policy_version===DURABLE_FEE_VERSION&&r.state==='APPROVED'&&
 r.execution_enabled===false&&r.kill_switch===true&&!r.model_id&&!!c;
 return {ok:true as const,ownerId:owner,sha,accountId:r.id,policyId:r.policy_id,policyHash:r.policy_hash,policyVersion:r.fee_policy_version,
 sourceDigest:r.official_source_digest??null,sourceEffectiveDate:r.source_effective_date??null,sourceKind:r.source_kind??null,baselineId:r.historical_baseline_id??null,sourceAuthenticityVerified:r.genuine_source_verified===true,sourceUrl:r.fee_source_url,modelId:r.model_id??id??null,entryRevoked:r.entry_revoked??false,knownPublicationChange:r.known_publication_change??false,
 monitorState:r.monitor_state??'never_checked',executionEnabled:r.execution_enabled,killSwitch:r.kill_switch,featureEnabled:true,
 enrollmentReady:false,reason:r.model_id?'durable_model_already_recorded':!id||r.fee_policy_version!==DURABLE_FEE_VERSION?'durable_policy_migration_required':!c?'genuine_current_capture_missing':!ready?'stopped_account_required':'durable_atomic_migration_required',
 candidateCapture:c?{captureId:c.capture_id,digest:c.content_sha256,capturedAt:c.captured_at,expiresAt:c.expires_at,effectiveDate:c.effective_date}:null,
 publicationKnownCurrent:false,tradingAuthorized:false};
 }catch{return deny('durable_fee_status_unavailable');}
}
export async function revokeDurableFeeEntry(owner:string,raw:unknown){
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return deny('durable_fee_feature_disabled');
 if(!UUID.test(owner)||!raw||typeof raw!=='object'||Array.isArray(raw))return deny('durable_fee_revoke_consent_required');
 const b=raw as Row;
 if(Object.keys(b).sort().join(',')!=='confirmation,expectedSha,modelId'||!UUID.test(String(b.modelId))||
 b.expectedSha!==deployedGitSha()||b.confirmation!=='I_REVOKE_DURABLE_FEE_NEW_ENTRIES_V1')return deny('durable_fee_revoke_consent_required');
 const c=await pool.connect();let committed=false;
 try{await c.query('BEGIN');const r=await c.query(`UPDATE private.strata_durable_owner_fee_state s SET entry_revoked=true
 FROM private.strata_durable_owner_fee_model m WHERE m.model_id=s.model_id AND m.owner_user_id=$1::uuid
 AND ${durableReleaseMatch('$2')} AND m.model_id=$3::uuid RETURNING m.model_id`,[owner,b.expectedSha,b.modelId]);
 if(r.rows.length!==1)return deny('durable_fee_revoke_scope_unavailable');
 await c.query('INSERT INTO private.strata_durable_fee_revocation(event_id,model_id,owner_user_id) VALUES($1,$2,$3)',[randomUUID(),b.modelId,owner]);
 await c.query('COMMIT');committed=true;return {ok:true,entryRevoked:true,protectiveFeeProofRevoked:false,tradingAuthorized:false};
 }catch{return deny('durable_fee_revoke_outcome_unavailable');}finally{if(!committed)try{await c.query('ROLLBACK')}catch{}c.release()}
}
