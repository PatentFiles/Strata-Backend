/** Automated KXBTC15M monetary fee-evidence qualification (READ ONLY).
 * No human reviewer is needed to inspect provider-origin market metadata, but
 * this is NOT a trading authorization: an authenticated owner must separately
 * approve policy, and exact monetary model provenance remains required.
 */
import { probeCurrentKalshiFeeApi, type KalshiMarketFeeReadOnly } from "./twoSourceFeeEvidence";
import { preparePdfFreeApiFeePolicyReview } from "./apiFeePolicyReviewCandidate";
import { validateConservativeFeeVectors } from "./apiFeeRateReference";

export type OwnerFeePreflight = {
  ok: boolean;
  reason: string;
  source: "kalshi_trade_api";
  marketTicker?: string;
  evidenceDigest?: string;
  observedAt?: string;
  independentHumanReviewerRequired: false;
  monetaryScheduleVerified: false;
  policyApproved: false;
  commissioningApproved: false;
  tradingAuthorized: false;
};

export async function inspectOwnerFeeEvidence(
  fetchImpl: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
  expectedMarketTicker?: string,
): Promise<OwnerFeePreflight> {
  const base = {
    source: "kalshi_trade_api" as const,
    independentHumanReviewerRequired: false as const,
    monetaryScheduleVerified: false as const,
    policyApproved: false as const,
    commissioningApproved: false as const,
    tradingAuthorized: false as const,
  };
  if (!validateConservativeFeeVectors()) return { ...base, ok: false, reason: "offline_fee_vector_mismatch" };
  let read: KalshiMarketFeeReadOnly;
  try {
    read = await probeCurrentKalshiFeeApi(fetchImpl, now, expectedMarketTicker);
  } catch {
    return { ...base, ok: false, reason: "official_api_read_unavailable" };
  }
  const candidate = preparePdfFreeApiFeePolicyReview(read, now());
  if (!candidate.ok) return { ...base, ok: false, reason: candidate.reason };
  if (expectedMarketTicker && candidate.marketTicker !== expectedMarketTicker)
    return { ...base, ok: false, reason: "fee_market_scope_mismatch" };
  return {
    ...base, ok: true, reason: "live_market_metadata_verified_monetary_schedule_pending",
    marketTicker: candidate.marketTicker,
    evidenceDigest: candidate.reviewCandidateDigest,
    observedAt: candidate.verifiedAt,
  };
}
