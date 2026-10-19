/** Automated KXBTC15M monetary fee-evidence qualification (READ ONLY).
 * No human reviewer is needed to inspect provider-origin market metadata, but
 * this is NOT a trading authorization: an authenticated owner must separately
 * approve policy, and exact monetary model provenance remains required.
 */
import { verifyMonetaryFeeContract } from "./monetaryFeeContract";

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
  const checked = await verifyMonetaryFeeContract(
    expectedMarketTicker ? "ORDER_ENTRY" : "STEP_9", expectedMarketTicker,
    fetchImpl, now,
  );
  if(!checked.ok) return {...base,ok:false,reason:checked.reason};
  return {
    ...base,ok:true,reason:checked.reason,
    marketTicker:checked.marketTicker,evidenceDigest:checked.sourceDigest,
    observedAt:checked.verifiedAt,
  };
}
