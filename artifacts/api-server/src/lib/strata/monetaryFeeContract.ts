/** Authenticated monetary fee SOURCE verifier shared by the three boundaries.
 * Verifies the official, strictly parsed Kalshi fee schedule plus the live
 * exchange's exact market, event, series and future fee changes. An official
 * PDF transport failure fails closed; this function never authorizes trading.
 */
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";
import { preparePdfFreeApiFeePolicyReview } from "./apiFeePolicyReviewCandidate";
import { establishOfficialFeeDigest } from "../microLiveFeeArtifact";
import type { ApiFeeStage } from "./apiFeeGrantEligibility";

export type MonetaryFeeEvidenceContract = {
  ok:boolean;reason:string;stage:ApiFeeStage;
  marketTicker?:string;eventTicker?:string;sourceDigest?:string;
  verifiedAt?:string;monetaryFeeAuthorized:boolean;
  policyApproved:false;tradingAuthorized:false;
  rateLimitOrigin?:"provider"|"shared_cooldown"|"backend_local"|"bridge_unclassified";
  retryAt?:string;
};
const deny=(stage:ApiFeeStage,reason:string):MonetaryFeeEvidenceContract=>({
  ok:false,reason,stage,monetaryFeeAuthorized:false,
  policyApproved:false,tradingAuthorized:false,
});
type PdfProof = Awaited<ReturnType<typeof establishOfficialFeeDigest>>;
export async function verifyMonetaryFeeContract(
 stage:ApiFeeStage,exactMarketTicker?:string,
 fetchImpl:typeof fetch=globalThis.fetch,now:()=>number=Date.now,
 establish:()=>Promise<PdfProof>=establishOfficialFeeDigest,
):Promise<MonetaryFeeEvidenceContract>{
 if(!["STEP_9","STEP_11","ORDER_ENTRY"].includes(stage))return deny(stage,"invalid_fee_stage");
 if(stage==="ORDER_ENTRY"&&!exactMarketTicker)return deny(stage,"exact_order_market_required");
 const start=now();
 if(!Number.isSafeInteger(start)||start<=0)return deny(stage,"invalid_fee_clock");
 // An official monetary source MUST be present before relying on the API's
 // series multiplier. No browser claims, uploads or self-attestations.
 let proof:PdfProof;
 try{proof=await establish();}catch{return deny(stage,"official_monetary_fee_source_unavailable");}
 if(!proof.ok){
   // Transport classification is diagnostic-only, never a fee grant.
   const origin=proof.diagnostic.rateLimitOrigin;
   const suffix=origin==="provider"?"provider":origin==="shared_cooldown"
     ?"shared_cooldown":origin==="backend_local"?"backend_local":
     origin==="bridge_unclassified"?"bridge_unclassified":null;
   const reason=proof.reason==="official_fee_schedule_http_429" && suffix
     ? "official_fee_schedule_http_429_"+suffix:proof.reason;
   return {...deny(stage,reason),
     ...(suffix?{rateLimitOrigin:origin!}:{}),
     ...(proof.diagnostic.retryAt?{retryAt:proof.diagnostic.retryAt}:{})};
 }
 if(!/^[a-f0-9]{64}$/.test(proof.digest))
   return deny(stage,"official_monetary_fee_digest_invalid");
 const observation=await probeCurrentKalshiFeeApi(fetchImpl,now,exactMarketTicker);
 if(!observation.ok)return deny(stage,observation.reason);
 const candidate=preparePdfFreeApiFeePolicyReview(observation,now());
 if(!candidate.ok)return deny(stage,candidate.reason);
 if(exactMarketTicker&&candidate.marketTicker!==exactMarketTicker)
   return deny(stage,"fee_market_identity_mismatch");
 if(now()-start>15_000)return deny(stage,"monetary_fee_source_stale");
 // This digest is the official PDF bytes, NOT a reviewer grant. It must be
 // pinned to the authenticated owner's persisted policy before approval.
 return {ok:true,reason:"provider_monetary_fee_schedule_and_market_verified",
  stage,marketTicker:candidate.marketTicker,eventTicker:candidate.eventTicker,
  sourceDigest:proof.digest,verifiedAt:candidate.verifiedAt,
  monetaryFeeAuthorized:true,policyApproved:false,tradingAuthorized:false};
}
