/** Local candidate; not wired to production. A fee proof is not trading authority. */
import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
import {preparePdfFreeApiFeePolicyReview} from './apiFeePolicyReviewCandidate';
export const DURABLE_FEE_VERSION='owner_approved_canonical_terms_v1';
export type DurableModel={owner:string;account:string;sha:string;policyHash:string;digest:string;
 version:string;formula:string;effectiveDate:string;approved:boolean;entryRevoked:boolean;
 integrityValid:boolean;knownPublicationChange:boolean;monitorState:'unchanged'|'unavailable'|'changed'|'never_checked'};
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
 model.version!==DURABLE_FEE_VERSION||model.formula!=='standard-quadratic-0.07-v1'||model.effectiveDate!=='2026-07-07')
  return deny('durable_fee_genuine_approved_terms_required');
 // An actual new publication may change a base coefficient not represented
 // in series metadata. Neither entries nor fee-uncapped exits may guess.
 if(model.knownPublicationChange)return deny(intent==='ENTRY'?'durable_fee_new_terms_require_review':'protective_fee_changed_terms_need_verified_bound');
 if(intent==='ENTRY'&&model.entryRevoked)return deny('durable_fee_entry_consent_revoked');
 if(!market.ok||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(market.ticker)||!Number.isSafeInteger(now)||
 !Number.isFinite(market.verifiedAt)||market.verifiedAt>now||now-market.verifiedAt>5000)
  return deny(intent==='ENTRY'?'durable_fee_current_market_unverified':'protective_fee_unavailable_no_verified_bound');
 return {ok:true as const,reason:'approved_durable_terms_and_fresh_market_metadata',sourceDigest:model.digest,
 verifiedAtMs:market.verifiedAt,marketTicker:market.ticker,intent,
 publicationKnownCurrent:false as const,publicationMonitorState:model.monitorState,
 entryConsentRequired:intent==='ENTRY',feeProofOnly:true as const,tradingAuthorized:false as const};
}
/** Existing caller transaction must hold these locks THROUGH final send.
 * No HTTP route exposes a model/intent override. Native integration pending. */
export const DURABLE_FEE_LOCK_SQL=`SELECT m.*,m.effective_date::text AS effective_date_text,s.known_publication_change,s.monitor_state,s.entry_revoked,
 p.state AS policy_state FROM private.strata_durable_owner_fee_model m
 JOIN private.strata_durable_owner_fee_state s ON s.model_id=m.model_id
 JOIN public.v13_production_account a ON a.id=m.execution_account_id AND a.owner_user_id=m.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE m.owner_user_id=$1::uuid AND m.execution_account_id=$2 AND m.release_commit_sha=$3
 AND m.approved_policy_hash=$4 AND p.policy_hash=$4 AND p.state='APPROVED'
 AND p.fee_source_url='strata-durable-owner-fee://'||m.model_id::text
 AND p.fee_policy_version=m.policy_version AND p.fee_formula_version=m.formula_version
 AND a.subaccount=1 AND a.exchange_index=2 AND a.fee_artifact_digest=m.official_source_digest
 FOR SHARE OF m,s,a,p`;
/** No PDF request, time-based publication refresh or 429 retry occurs here.
 * Must remain composed with existing technical/account/lease/order fences. */
export async function verifyDurableOwnerFee(tx:{query(sql:string,args:unknown[]):Promise<{rows:Record<string,unknown>[]}>},
 scope:{owner:string;account:string;sha:string;policyHash:string},ticker:string,intent:Intent,
 deps:{fetcher?:typeof fetch;clock?:()=>number;monotonicNow?:()=>number}={}){
 if(process.env.NODE_ENV!=='test'&&Object.keys(deps).length)return deny('durable_fee_production_override_forbidden');
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return deny('durable_fee_feature_disabled');
 const now=deps.clock??Date.now,monotonic=deps.monotonicNow??(()=>performance.now());
 try{
 const rows=await tx.query(DURABLE_FEE_LOCK_SQL,[scope.owner,scope.account,scope.sha,scope.policyHash]);
 if(rows.rows.length!==1)return deny('durable_fee_unique_locked_model_required');
 const r=rows.rows[0];
 // This probe owns fresh direct GETs (no supplied cache/prefetch reader).
 // Start the durable age conservatively BEFORE its earliest transport, never
 // at the last response or the generic probe's completion timestamp. Keep the
 // original fetch identity so existing public quota/cancellation rules remain.
 const sourceStartedAt=now(),sourceStartedMono=monotonic();
 if(!Number.isSafeInteger(sourceStartedAt)||sourceStartedAt<=0||!Number.isFinite(sourceStartedMono)||sourceStartedMono<0)
  return deny('durable_fee_observation_clock_invalid');
 const observation=await probeCurrentKalshiFeeApi(deps.fetcher??globalThis.fetch,now,ticker);
 const candidate=preparePdfFreeApiFeePolicyReview(observation,now());
 const assessedAt=now(),elapsedMono=monotonic()-sourceStartedMono;
 if(!Number.isSafeInteger(assessedAt)||assessedAt<sourceStartedAt||assessedAt-sourceStartedAt>5000||
 !Number.isFinite(elapsedMono)||elapsedMono<0||elapsedMono>5000)
  return deny('durable_fee_market_observation_deadline_exceeded');
 const proof=assessDurableFee({owner:String(r.owner_user_id),account:String(r.execution_account_id),sha:String(r.release_commit_sha),
 policyHash:String(r.approved_policy_hash),digest:String(r.official_source_digest),version:String(r.policy_version),formula:String(r.formula_version),
 effectiveDate:String(r.effective_date_text),approved:r.policy_state==='APPROVED',entryRevoked:r.entry_revoked===true,
 integrityValid:r.genuine_source_verified===true,knownPublicationChange:r.known_publication_change===true,
 monitorState:r.monitor_state as DurableModel['monitorState']},scope,intent,
 {ok:candidate.ok&&candidate.marketTicker===ticker,ticker,verifiedAt:sourceStartedAt},assessedAt);
 if(!proof.ok)return proof;
 // Process-local capability, never serialized or reconstructed from a receipt.
 // Retains the SAME source clock through signing/fences and final send.
 const sourceFresh=()=>{const wall=now(),mono=monotonic(),elapsed=mono-sourceStartedMono;
  return Number.isSafeInteger(wall)&&wall>=sourceStartedAt&&wall-sourceStartedAt<=5000&&
   Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=5000;};
 return {...proof,sourceFresh};
 }catch{return deny('durable_fee_database_or_market_unavailable');}
}
