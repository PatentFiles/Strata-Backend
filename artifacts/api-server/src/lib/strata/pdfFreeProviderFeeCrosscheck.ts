/**
 * Cross-checks independently fetched first-party Kalshi website content with
 * exact KXBTC15M market/series/event live API fee metadata. Both sources must
 * come directly from the backend's fixed URLs, not owner-provided browser data.
 *
 * This builds REVIEW EVIDENCE ONLY. A page's SHA-256 and a positive API read
 * cannot establish the full current fee formula, certify six-decimal rounding,
 * create an approval/grant, or authorize any funded/signed order.
 */
import {createHash} from "node:crypto";
import {
 captureOfficialPredictionFeePage,OFFICIAL_PREDICTION_FEE_PAGE,
} from "./providerFeePageCapture";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {preparePdfFreeApiFeePolicyReview} from "./apiFeePolicyReviewCandidate";

const TICKER=/^KXBTC15M-[A-Za-z0-9-]+$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_AGE=10_000;
export type PdfFreeReviewEvidence =
 | {ok:true;reason:"provider_page_api_observations_for_review_only";
     marketTicker:string;pageSha256:string;apiMetadataSha256:string;
     reviewEvidenceSha256:string;observedAt:string;
     formulaIndependentlyVerified:false;ownerFeeApproval:false;
     protectiveExitExecutionVerified:false;tradingAuthorized:false}
 | {ok:false;reason:string;formulaIndependentlyVerified:false;
     ownerFeeApproval:false;protectiveExitExecutionVerified:false;
     tradingAuthorized:false};
type Capture=typeof captureOfficialPredictionFeePage;
type Probe=typeof probeCurrentKalshiFeeApi;
const deny=(reason:string):PdfFreeReviewEvidence=>({
 ok:false,reason,formulaIndependentlyVerified:false,ownerFeeApproval:false,
 protectiveExitExecutionVerified:false,tradingAuthorized:false,
});

/** No account credentials or order POSTs. Never accept an arbitrary URL. */
export async function readPdfFreeProviderFeeReviewEvidence(
 exactMarketTicker:string,
 deps:{capture?:Capture;probe?:Probe;clock?:()=>number;transport?:typeof fetch}={},
):Promise<PdfFreeReviewEvidence>{
 if(!TICKER.test(exactMarketTicker))return deny("fee_crosscheck_exact_market_invalid");
 const clock=deps.clock??Date.now;
 const start=clock();
 if(!Number.isSafeInteger(start)||start<=0)return deny("fee_crosscheck_clock_invalid");
 let page:Awaited<ReturnType<Capture>>;
 let api:Awaited<ReturnType<Probe>>;
 try{
  [page,api]=await Promise.all([
   (deps.capture??captureOfficialPredictionFeePage)(
     deps.transport??globalThis.fetch,clock),
   (deps.probe??probeCurrentKalshiFeeApi)(
     deps.transport??globalThis.fetch,clock,exactMarketTicker),
  ]);
 }catch{return deny("fee_crosscheck_read_failed");}
 if(!page.ok)return deny("fee_crosscheck_page_"+page.reason);
 if(!api.ok)return deny("fee_crosscheck_api_"+api.reason);
 const finished=clock();
 if(!Number.isSafeInteger(finished)||finished<start||finished-start>MAX_AGE)
  return deny("fee_crosscheck_evidence_stale");
 if(page.canonicalUrl!==OFFICIAL_PREDICTION_FEE_PAGE||
    !HASH.test(page.sha256)||page.byteLength<100||
    page.currentFeeFormulaVerified!==false||
    page.sourcePolicyApproved!==false||page.exchangeExecutionAuthorized!==false)
  return deny("fee_crosscheck_page_identity_invalid");
 if(api.marketTicker!==exactMarketTicker||
    api.feeType!=="quadratic"||api.feeMultiplier!=="1"||
    !api.metadataDigest||!HASH.test(api.metadataDigest)||
    api.pdfProvenanceApproved!==false||api.tradingEnabled!==false)
  return deny("fee_crosscheck_api_identity_invalid");
 const candidate=preparePdfFreeApiFeePolicyReview(api,finished);
 if(!candidate.ok || candidate.marketTicker!==exactMarketTicker)
  return deny("fee_crosscheck_review_candidate_"+candidate.reason);
 const time=Date.parse(page.capturedAt);
 if(!Number.isFinite(time)||time<start||time>finished)
  return deny("fee_crosscheck_page_timestamp_invalid");
 const digest=createHash("sha256").update(JSON.stringify({
   version:"strata_pdf_free_crosscheck_review_v1",
   pageUrl:OFFICIAL_PREDICTION_FEE_PAGE,
   pageSha256:page.sha256,
   marketTicker:exactMarketTicker,
   apiMetadataSha256:api.metadataDigest,
   apiCandidateSha256:candidate.reviewCandidateDigest,
   observedAt:candidate.verifiedAt,
 })).digest("hex");
 return {
   ok:true,reason:"provider_page_api_observations_for_review_only",
   marketTicker:exactMarketTicker,pageSha256:page.sha256,
   apiMetadataSha256:api.metadataDigest,reviewEvidenceSha256:digest,
   observedAt:candidate.verifiedAt,
   formulaIndependentlyVerified:false,ownerFeeApproval:false,
   protectiveExitExecutionVerified:false,tradingAuthorized:false,
 };
}
