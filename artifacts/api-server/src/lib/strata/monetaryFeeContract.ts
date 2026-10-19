/** Shared fail-closed fee qualification for Step 9, Step 11 and ORDER_ENTRY.
 * This verifies real provider market metadata and binds its digest to one
 * market and stage. It does NOT turn metadata into an approved monetary rate.
 */
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";
import { preparePdfFreeApiFeePolicyReview } from "./apiFeePolicyReviewCandidate";
import type { ApiFeeStage } from "./apiFeeGrantEligibility";

export type MonetaryFeeEvidenceContract = {
  ok: boolean;
  reason: string;
  stage: ApiFeeStage;
  marketTicker?: string;
  eventTicker?: string;
  sourceDigest?: string;
  verifiedAt?: string;
  monetaryFeeAuthorized: false;
  policyApproved: false;
  tradingAuthorized: false;
};

const deny = (stage: ApiFeeStage, reason: string): MonetaryFeeEvidenceContract =>
  ({ok:false,reason,stage,monetaryFeeAuthorized:false,policyApproved:false,tradingAuthorized:false});

export async function verifyMonetaryFeeContract(
  stage: ApiFeeStage,
  exactMarketTicker?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<MonetaryFeeEvidenceContract> {
  if(!["STEP_9","STEP_11","ORDER_ENTRY"].includes(stage))
    return deny(stage,"invalid_fee_stage");
  if(stage==="ORDER_ENTRY" && !exactMarketTicker)
    return deny(stage,"exact_order_market_required");
  const observation = await probeCurrentKalshiFeeApi(fetchImpl,now,exactMarketTicker);
  if(!observation.ok) return deny(stage,observation.reason);
  const candidate = preparePdfFreeApiFeePolicyReview(observation,now());
  if(!candidate.ok) return deny(stage,candidate.reason);
  if(exactMarketTicker && candidate.marketTicker!==exactMarketTicker)
    return deny(stage,"fee_market_identity_mismatch");
  // No current official monetary-rate provenance has been authenticated for
  // the owner. A favorable metadata read is NOT sufficient for Step 9/11/order.
  return {
    ok:false,reason:"market_fee_metadata_verified_monetary_authorization_pending",
    stage,marketTicker:candidate.marketTicker,eventTicker:candidate.eventTicker,
    sourceDigest:candidate.reviewCandidateDigest,verifiedAt:candidate.verifiedAt,
    monetaryFeeAuthorized:false,policyApproved:false,tradingAuthorized:false,
  };
}
