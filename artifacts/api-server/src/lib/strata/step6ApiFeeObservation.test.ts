import test from "node:test";
import assert from "node:assert/strict";
import { step6ApiFeeObservation } from "./step6ApiFeeObservation";
import { REVIEWED_REFERENCE_PDF_SHA256, type KalshiMarketFeeReadOnly } from "./twoSourceFeeEvidence";

const now = Date.parse("2026-10-17T15:00:00.000Z");
function verified(): KalshiMarketFeeReadOnly {
  return {
    ok: true, reason: "live_series_event_fee_metadata_verified_read_only",
    series: "KXBTC15M", exchangeIndex: 2,
    referenceDigest: REVIEWED_REFERENCE_PDF_SHA256,
    liveVerifiedAt: new Date(now).toISOString(),
    marketTicker: "KXBTC15M-26OCT17T1500",
    eventTicker: "KXBTC15M-26OCT17T1500",
    feeType: "quadratic", feeMultiplier: "1",
    metadataDigest: "a".repeat(64),
    pdfProvenanceApproved: false, ownerPolicyApproved: false,
    commissioningApproved: false, tradingEnabled: false,
  };
}
test("accepts current official API metadata as Step 6-only preflight", () => {
  const proof = step6ApiFeeObservation(verified(), now);
  assert.equal(proof?.ok, true);
  assert.equal(proof?.feeEvidenceDigest, "a".repeat(64));
  assert.equal(proof?.referencePdfDigest, REVIEWED_REFERENCE_PDF_SHA256);
  assert.equal(proof?.providerPdfVerified, false);
  assert.equal(proof?.policyApproved, false);
  assert.equal(proof?.commissioningPerformed, false);
  assert.equal(proof?.tradingAuthorized, false);
  assert.equal("feeArtifactDigest" in (proof ?? {}), false);
});
test("fails closed for stale or future-dated fee metadata", () => {
  assert.equal(step6ApiFeeObservation(verified(), now + 15_001), null);
  assert.equal(step6ApiFeeObservation(verified(), now - 1), null);
});
test("rejects wrong fees, digest, unapproved overrides and live authority", () => {
  for (const changes of [
    { feeMultiplier: "2" }, { feeType: "flat" },
    { referenceDigest: "f".repeat(64) },
    { metadataDigest: "INVALID" }, { exchangeIndex: 0 },
    { pdfProvenanceApproved: true }, { ownerPolicyApproved: true },
    { commissioningApproved: true }, { tradingEnabled: true },
    { marketTicker: "NOT-BTC" }, { eventTicker: "OTHER" },
    { ok: false },
  ]) {
    const bad = { ...verified(), ...changes } as KalshiMarketFeeReadOnly;
    assert.equal(step6ApiFeeObservation(bad, now), null);
  }
});
