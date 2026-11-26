import {platformFeeUploadEnabled,isUploadedBaselineId,UPLOADED_FEE_PROVENANCE} from "./platformFeeUploadMode";
import {consumeDurablePhaseMetadata,type DurablePhaseMetadata} from './durablePhaseMetadata';
import {durablePrepareMetadataClock,type PrefetchedPublicMetadata} from "./committedPublicMetadata";
import {durableReleaseMatch} from './durableFeeReleaseBinding';
import {HISTORICAL_FEE_VERSION,HISTORICAL_SOURCE_KIND,HISTORICAL_BASELINE_ID,HISTORICAL_BASELINE_SHA256,historicalBaselineEnabled} from './historicalOwnerFeeBaseline';
/** Local candidate; not wired to production. A fee proof is not trading authority. */
import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
import {preparePdfFreeApiFeePolicyReview} from './apiFeePolicyReviewCandidate';
export const DURABLE_FEE_VERSION='owner_approved_canonical_terms_v1';
export const isDurableFeeVersion=(v:unknown)=>v===DURABLE_FEE_VERSION||v===HISTORICAL_FEE_VERSION;
export type DurableModel={owner:string;account:string;sha:string;policyHash:string;digest:string;
 sourceKind?:string;version:string;formula:string;effectiveDate:string;approved:boolean;entryRevoked:boolean;
 manualBaselineCurrent?:boolean;integrityValid:boolean;knownPublicationChange:boolean;monitorState:'unchanged'|'unavailable'|'changed'|'never_checked'};
export type Intent='ENTRY'|'PROTECTIVE_EXIT';
const deny=(reason:string)=>({ok:false as const,reason,feeProofOnly:true as const,tradingAuthorized:false as const});
/** A network error conveys no document content. Once a genuine change is
 * observed, a later stale/same or unavailable observation cannot clear it. */
export function publicationTransition(previous:{knownChange:boolean;monitorState:DurableModel['monitorState']},
 event:{kind:'transport_unavailable'}|{kind:'verified_canonical_digest';digest:string},approvedDigest:string){
 if(event.kind==='transport_unavailable')return {...previous,monitorState:'unavailable' as const};
 if(!/^[a-f0-9]{64}$/.test(event.digest))throw Error('unverified_publication_digest');
 const knownChange=previous.knownChange||event.digest!==approvedDigest;
 return {knownChange,monitorState:knownChange?'changed' as const:'unchanged' as const};
}
export function assessDurableFee(model:DurableModel,scope:{owner:string;account:string;sha:string;policyHash:string},
 intent:Intent,market:{ok:boolean;ticker:string;verifiedAt:number},now:number){
 if(model.owner!==scope.owner||model.account!==scope.account||model.sha!==scope.sha||model.policyHash!==scope.policyHash)
  return deny('durable_fee_scope_mismatch');
 if(!model.integrityValid||!model.approved||!/^([a-f0-9]{64})$/.test(model.digest)||
 !isDurableFeeVersion(model.version)||(model.version===HISTORICAL_FEE_VERSION&&
 !(model.sourceKind===HISTORICAL_SOURCE_KIND&&historicalBaselineEnabled()&&model.digest===HISTORICAL_BASELINE_SHA256||
 model.sourceKind===UPLOADED_FEE_PROVENANCE&&platformFeeUploadEnabled()&&model.manualBaselineCurrent===true))||model.formula!=='standard-quadratic-0.07-v1'||model.effectiveDate!=='2026-07-07')
  return deny('durable_fee_genuine_approved_terms_required');
 // An actual new publication may change a base coefficient not represented
 // in series metadata. Neither entries nor fee-uncapped exits may guess.
 if(model.knownPublicationChange)return deny(intent==='ENTRY'?'durable_fee_new_terms_require_review':'protective_fee_changed_terms_need_verified_bound');
 if(intent==='ENTRY'&&model.entryRevoked)return deny('durable_fee_entry_consent_revoked');
 if(!market.ok||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(market.ticker)||!Number.isSafeInteger(now)||
 !Number.isFinite(market.verifiedAt)||market.verifiedAt>now||now-market.verifiedAt>5000)
  return deny(intent==='ENTRY'?'durable_fee_current_market_unverified':'protective_fee_unavailable_no_verified_bound');
 return {ok:true as const,reason:model.sourceKind===UPLOADED_FEE_PROVENANCE?'admin_uploaded_fee_schedule_and_fresh_market_metadata':model.version===HISTORICAL_FEE_VERSION?'owner_attested_historical_baseline_and_fresh_market_metadata':'approved_durable_terms_and_fresh_market_metadata',sourceDigest:model.digest,
 policyVersion:model.version,sourceKind:model.sourceKind??'FRESH_CANONICAL_CAPTURE',sourceAuthenticityVerified:model.version!==HISTORICAL_FEE_VERSION,
 verifiedAtMs:market.verifiedAt,marketTicker:market.ticker,intent,
 publicationKnownCurrent:false as const,publicationMonitorState:model.monitorState,
 entryConsentRequired:intent==='ENTRY',feeProofOnly:true as const,tradingAuthorized:false as const};
}
/** Existing caller transaction must hold these locks THROUGH final send.
 * No HTTP route exposes a model/intent override. Native integration pending. */
// Hash actual stored bytes on EVERY locked read, not the declared digest. Return only
// the digest to avoid transferring the historical PDF at each execution stage.
export const DURABLE_FEE_LOCK_SQL=`SELECT m.*,$3::text AS authorized_release_sha,m.effective_date::text AS effective_date_text,s.known_publication_change,s.monitor_state,s.entry_revoked,
 p.state AS policy_state,pg_catalog.encode(pg_catalog.sha256(b.original_bytes),'hex') AS historical_actual_digest,b.content_sha256 AS historical_digest FROM private.strata_durable_owner_fee_model m
 LEFT JOIN private.strata_durable_historical_baseline b ON b.baseline_id=m.historical_baseline_id
 JOIN private.strata_durable_owner_fee_state s ON s.model_id=m.model_id
 JOIN public.v13_production_account a ON a.id=m.execution_account_id AND a.owner_user_id=m.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE m.owner_user_id=$1::uuid AND m.execution_account_id=$2 AND ${durableReleaseMatch('$3')}
 AND m.approved_policy_hash=$4 AND p.policy_hash=$4 AND p.state='APPROVED'
 AND p.fee_source_url='strata-durable-owner-fee://'||m.model_id::text
 AND p.fee_policy_version=m.policy_version AND p.fee_formula_version=m.formula_version
 AND a.subaccount=1 AND a.exchange_index=2 AND a.fee_artifact_digest=m.official_source_digest
 FOR SHARE OF m,s,a,p`;
// Both modes retain the exact same joins and lock set. The source mode derives
// policy identity only from the uniquely locked CURRENT account policy/model.
const POLICY_SCOPE_PREDICATE="AND m.approved_policy_hash=$4 AND p.policy_hash=$4 AND p.state='APPROVED'";
if(DURABLE_FEE_LOCK_SQL.split(POLICY_SCOPE_PREDICATE).length!==2)throw Error("durable_fee_scope_sql_shape_invalid");
export const DURABLE_FEE_SOURCE_LOCK_SQL=DURABLE_FEE_LOCK_SQL.replace(POLICY_SCOPE_PREDICATE,
 "AND m.approved_policy_hash=p.policy_hash AND p.fee_source_url=$4 AND p.state='APPROVED'");
type FeeScope={owner:string;account:string;sha:string;policyHash:string};
type FeeDb={query(sql:string,args:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type FeeDeps={fetcher?:typeof fetch;clock?:()=>number;monotonicNow?:()=>number};
type FeePhase={phase:"FINAL_MARKET"|"WIRE_FEE";handle:DurablePhaseMetadata};
type LockedScope={kind:'policy';scope:FeeScope}|{kind:'source';scope:Omit<FeeScope,'policyHash'>;source:string};
export function verifyDurableOwnerFeeSource(tx:FeeDb,scope:Omit<FeeScope,'policyHash'>,source:string,ticker:string,intent:Intent,
 deps:FeeDeps={},prepareMetadata?:PrefetchedPublicMetadata,phaseMetadata?:FeePhase){
 if(!/^strata-durable-owner-fee:\/\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.test(source))return Promise.resolve(deny('durable_source_invalid'));
 return verifyLockedDurableOwnerFee(tx,{kind:'source',scope,source},ticker,intent,deps,prepareMetadata,phaseMetadata);
}
/** No PDF request, time-based publication refresh or 429 retry occurs here.
 * Must remain composed with existing technical/account/lease/order fences. */
export function verifyDurableOwnerFee(tx:FeeDb,scope:FeeScope,ticker:string,intent:Intent,
 deps:FeeDeps={},prepareMetadata?:PrefetchedPublicMetadata,phaseMetadata?:FeePhase){
 return verifyLockedDurableOwnerFee(tx,{kind:'policy',scope},ticker,intent,deps,prepareMetadata,phaseMetadata);
}
async function verifyLockedDurableOwnerFee(tx:FeeDb,locked:LockedScope,ticker:string,intent:Intent,
 deps:FeeDeps,prepareMetadata?:PrefetchedPublicMetadata,phaseMetadata?:FeePhase){
 if(process.env.NODE_ENV!=='test'&&Object.keys(deps).length)return deny('durable_fee_production_override_forbidden');
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return deny('durable_fee_feature_disabled');
 const now=deps.clock??Date.now,monotonic=deps.monotonicNow??(()=>performance.now());
 try{
 const rows=await tx.query(locked.kind==='policy'?DURABLE_FEE_LOCK_SQL:DURABLE_FEE_SOURCE_LOCK_SQL,
 [locked.scope.owner,locked.scope.account,locked.scope.sha,locked.kind==='policy'?locked.scope.policyHash:locked.source]);
 if(rows.rows.length!==1)return deny('durable_fee_unique_locked_model_required');
 const r=rows.rows[0];
 const scope:FeeScope=locked.kind==='policy'?locked.scope:{...locked.scope,policyHash:String(r.approved_policy_hash)};
 if(locked.kind==='source'){
  if(!/^[a-f0-9]{64}$/.test(scope.policyHash))return deny('durable_policy_scope_unverified');
  if(r.known_publication_change===true)return deny(intent==='ENTRY'?'durable_fee_new_terms_require_review':'protective_fee_changed_terms_need_verified_bound');
  if(intent==='ENTRY'&&r.entry_revoked===true)return deny('durable_fee_entry_consent_revoked');
 }
 const historical=r.policy_version===HISTORICAL_FEE_VERSION;
 const manual=historical&&isUploadedBaselineId(r.historical_baseline_id);
 const manualCurrent=manual&&await (await import("./platformUploadedFeeSchedule")).activeUploadedBaselineMatches(tx,r.historical_baseline_id,r.official_source_digest);
 const historicalIntegrity=historical&&r.source_kind===HISTORICAL_SOURCE_KIND&&r.genuine_source_verified===false&&r.source_capture_id===null&&
 (manual?manualCurrent&&r.historical_digest===r.official_source_digest&&r.historical_actual_digest===r.official_source_digest:
 historicalBaselineEnabled()&&r.historical_baseline_id===HISTORICAL_BASELINE_ID&&r.historical_digest===HISTORICAL_BASELINE_SHA256&&r.historical_actual_digest===HISTORICAL_BASELINE_SHA256);
 if(historical&&!historicalIntegrity)return deny('historical_fee_baseline_provenance_unverified');
 // Only distinct process-local exact-scope capabilities may supply public bytes.
 // Model/revocation reads above always run at consumption. Phase capabilities
 // additionally bind an active owning invocation and literal stage; EXIT stays
 // direct. PREPARE bytes cannot satisfy FINAL/WIRE. Failed attempts never retry.
 if((prepareMetadata||phaseMetadata)&&intent!=='ENTRY'||prepareMetadata&&phaseMetadata)return deny('durable_fee_prefetch_scope_invalid');
 const phase=phaseMetadata?consumeDurablePhaseMetadata(phaseMetadata.handle,phaseMetadata.phase,scope,ticker):undefined;
 const prefetched=phase??(prepareMetadata?durablePrepareMetadataClock(prepareMetadata,scope,ticker):undefined);
 const metadata=phase?.metadata??prepareMetadata;
 // Without a capability this probe owns fresh direct GETs.
 // Start the durable age conservatively BEFORE its earliest transport, never
 // at the last response or the generic probe's completion timestamp. Keep the
 // original fetch identity so existing public quota/cancellation rules remain.
 const sourceStartedAt=prefetched?.startedAtMs??now(),sourceStartedMono=monotonic();
 if(!Number.isSafeInteger(sourceStartedAt)||sourceStartedAt<=0||!Number.isFinite(sourceStartedMono)||sourceStartedMono<0)
  return deny('durable_fee_observation_clock_invalid');
 const observation=await probeCurrentKalshiFeeApi(deps.fetcher??globalThis.fetch,now,ticker,metadata?.read,metadata?.capture);
 const candidate=preparePdfFreeApiFeePolicyReview(observation,now());
 const assessedAt=now(),elapsedMono=monotonic()-sourceStartedMono;
 if((prefetched&&!prefetched.sourceFresh())||!Number.isSafeInteger(assessedAt)||assessedAt<sourceStartedAt||assessedAt-sourceStartedAt>5000||
 !Number.isFinite(elapsedMono)||elapsedMono<0||elapsedMono>5000)
  return deny('durable_fee_market_observation_deadline_exceeded');
 const proof=assessDurableFee({owner:String(r.owner_user_id),account:String(r.execution_account_id),sha:String(r.authorized_release_sha??r.release_commit_sha),
 sourceKind:manual?UPLOADED_FEE_PROVENANCE:String(r.source_kind??'FRESH_CANONICAL_CAPTURE'),manualBaselineCurrent:manualCurrent,policyHash:String(r.approved_policy_hash),digest:String(r.official_source_digest),version:String(r.policy_version),formula:String(r.formula_version),
 effectiveDate:String(r.effective_date_text),approved:r.policy_state==='APPROVED',entryRevoked:r.entry_revoked===true,
 integrityValid:historical?historicalIntegrity:r.genuine_source_verified===true&&(!r.source_kind||r.source_kind==='FRESH_CANONICAL_CAPTURE'),knownPublicationChange:r.known_publication_change===true,
 monitorState:r.monitor_state as DurableModel['monitorState']},scope,intent,
 {ok:candidate.ok&&candidate.marketTicker===ticker,ticker,verifiedAt:sourceStartedAt},assessedAt);
 if(!proof.ok)return proof;
 // Process-local capability, never serialized or reconstructed from a receipt.
 // Retains the SAME source clock through signing/fences and final send.
 const sourceFresh=()=>{const wall=now(),mono=monotonic(),elapsed=mono-sourceStartedMono;
  return (!prefetched||prefetched.sourceFresh())&&Number.isSafeInteger(wall)&&wall>=sourceStartedAt&&wall-sourceStartedAt<=5000&&
   Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=5000;};
 return {...proof,sourceFresh};
 }catch{return deny('durable_fee_database_or_market_unavailable');}
}
