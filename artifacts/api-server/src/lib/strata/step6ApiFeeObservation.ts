/**
 * Step 6 read-only fallback when Kalshi blocks automated PDF downloads.
 *
 * Confirms the current KXBTC15M fee rules through Kalshi's own Trade API,
 * using the existing strict series/event/market/scheduled-change probe.
 * The reviewed PDF digest is only a reference: this deliberately does NOT
 * verify PDF provenance, produce an approvable fee-artifact digest, or
 * satisfy Steps 9/11 or any live-money authorization gate.
 */
import {
  KALSHI_API_ORIGIN,
  KALSHI_SERIES,
  REVIEWED_REFERENCE_PDF_SHA256,
  type KalshiMarketFeeReadOnly,
} from "./twoSourceFeeEvidence";

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_OBSERVATION_AGE_MS = 15_000;

export function step6ApiFeeObservation(
  market: KalshiMarketFeeReadOnly,
  nowMs: number = Date.now(),
) {
  const observedAt = typeof market.liveVerifiedAt === "string"
    ? Date.parse(market.liveVerifiedAt) : NaN;
  if (!market.ok ||
      market.series !== KALSHI_SERIES ||
      market.exchangeIndex !== 2 ||
      market.feeType !== "quadratic" ||
      market.feeMultiplier !== "1" ||
      market.referenceDigest !== REVIEWED_REFERENCE_PDF_SHA256 ||
      !market.marketTicker?.startsWith("KXBTC15M-") ||
      !market.eventTicker?.startsWith("KXBTC15M-") ||
      !market.metadataDigest || !DIGEST.test(market.metadataDigest) ||
      !Number.isSafeInteger(nowMs) || !Number.isFinite(observedAt) ||
      observedAt > nowMs || nowMs - observedAt > MAX_OBSERVATION_AGE_MS ||
      market.pdfProvenanceApproved !== false ||
      market.ownerPolicyApproved !== false ||
      market.commissioningApproved !== false ||
      market.tradingEnabled !== false) return null;

  return {
    ok: true as const,
    reason: "kalshi_api_fee_metadata_verified_read_only" as const,
    /** SHA-256 of current API fee metadata, NOT a PDF artifact digest. */
    feeEvidenceDigest: market.metadataDigest,
    /** A pinned, previously reviewed PDF only. No current origin claim. */
    referencePdfDigest: REVIEWED_REFERENCE_PDF_SHA256,
    checkedAt: market.liveVerifiedAt!,
    sourceUrl: `${KALSHI_API_ORIGIN}/series/${KALSHI_SERIES}`,
    marketTicker: market.marketTicker,
    provenanceType: "kalshi_api_fee_metadata_not_pdf" as const,
    providerPdfVerified: false as const,
    policyApproved: false as const,
    commissioningPerformed: false as const,
    tradingAuthorized: false as const,
  };
}
