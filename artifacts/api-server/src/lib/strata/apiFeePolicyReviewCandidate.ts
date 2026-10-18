/**
 * PDF-free KXBTC15M fee-policy REVIEW CANDIDATE (not an approval).
 *
 * This source can only be constructed from the existing strict, live Kalshi
 * Trade API probe. A valid observation still cannot authorize Step 9 policy,
 * Step 11 commissioning, cash movements or any exchange order. The rate
 * formula/rounding requires an independently signed, versioned decision
 * before the approval path may accept this candidate.
 */
import { createHash } from "node:crypto";
import {
  KALSHI_API_ORIGIN, KALSHI_SERIES, type KalshiMarketFeeReadOnly,
} from "./twoSourceFeeEvidence";
import { STANDARD_QUADRATIC_FEE_FORMULA_VERSION } from "../microLiveFeeArtifact";
import { PDF_FREE_RATE_REVIEW_VECTOR_VERSION, validateConservativeFeeVectors } from "./apiFeeRateReference";

export const API_FEE_POLICY_SOURCE_V1 = "kalshi_trade_api_fee_policy_candidate_v1" as const;
const HASH=/^[a-f0-9]{64}$/;
const TICKER=/^KXBTC15M-[A-Za-z0-9-]+$/;
const MAX_AGE_MS=10_000;

export type ApiFeePolicyReviewResult =
 | {ok:true; reason:"api_fee_observation_eligible_for_independent_review_only";
    sourceKind:typeof API_FEE_POLICY_SOURCE_V1;
    observationDigest:string; reviewCandidateDigest:string;
    marketTicker:string; eventTicker:string; verifiedAt:string;
    feeFormulaVersion:typeof STANDARD_QUADRATIC_FEE_FORMULA_VERSION;
    policyApproved:false; commissioningApproved:false; tradingAuthorized:false;
    requiresIndependentFeeModelReview:true}
 | {ok:false;reason:string;policyApproved:false;
    commissioningApproved:false;tradingAuthorized:false};

const deny=(reason:string):ApiFeePolicyReviewResult=>({
  ok:false,reason,policyApproved:false,commissioningApproved:false,
  tradingAuthorized:false,
});

export function preparePdfFreeApiFeePolicyReview(
  market:KalshiMarketFeeReadOnly, nowMs:number=Date.now(),
):ApiFeePolicyReviewResult {
  if(!validateConservativeFeeVectors()) return deny("fee_reference_vectors_invalid");
  if(!Number.isSafeInteger(nowMs) || nowMs<=0)
    return deny("observation_clock_invalid");
  if(market.ok!==true ||
     market.reason!=="live_series_event_fee_metadata_verified_read_only" ||
     market.series!==KALSHI_SERIES || market.exchangeIndex!==2 ||
     market.feeType!=="quadratic" || market.feeMultiplier!=="1" ||
     market.pdfProvenanceApproved!==false ||
     market.ownerPolicyApproved!==false ||
     market.commissioningApproved!==false ||
     market.tradingEnabled!==false)
    return deny("live_api_fee_source_not_verified");

  if(!market.marketTicker || !TICKER.test(market.marketTicker) ||
     !market.eventTicker || !TICKER.test(market.eventTicker) ||
     !market.metadataDigest || !HASH.test(market.metadataDigest))
    return deny("live_api_fee_source_identity_invalid");
  const observed=typeof market.liveVerifiedAt==="string"
     ? Date.parse(market.liveVerifiedAt):NaN;
  if(!Number.isFinite(observed) || observed>nowMs ||
      nowMs-observed>MAX_AGE_MS)
    return deny("live_api_fee_observation_stale");

  // This digest binds the official API observation to the proposed fee-model
  // review version. It is NEVER PDF provenance or a policy approval signature.
  const canonical=JSON.stringify({
    version:API_FEE_POLICY_SOURCE_V1,
    issuer:KALSHI_API_ORIGIN,
    series:KALSHI_SERIES,
    exchangeIndex:2,
    marketTicker:market.marketTicker,
    eventTicker:market.eventTicker,
    apiMetadataDigest:market.metadataDigest,
    verifiedAt:market.liveVerifiedAt,
    feeFormulaVersion:STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    conservativeReferenceVersion:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
  });
  return {
    ok:true,reason:"api_fee_observation_eligible_for_independent_review_only",
    sourceKind:API_FEE_POLICY_SOURCE_V1,
    observationDigest:market.metadataDigest,
    reviewCandidateDigest:createHash("sha256").update(canonical).digest("hex"),
    marketTicker:market.marketTicker,eventTicker:market.eventTicker,
    verifiedAt:market.liveVerifiedAt!,
    feeFormulaVersion:STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    requiresIndependentFeeModelReview:true,
    policyApproved:false,commissioningApproved:false,tradingAuthorized:false,
  };
}
