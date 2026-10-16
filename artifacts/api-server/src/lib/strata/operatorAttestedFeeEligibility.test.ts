import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateOperatorFeeRelease, REVIEWED_FEE_DIGEST, RELEASE_KIND,
  type FeeReview, type FeeReleaseCandidate } from "./operatorAttestedFeeEligibility";

const now = Date.parse("2026-10-16T03:30:00Z");
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const base: FeeReleaseCandidate = {
  releaseId: ids[0]!, digest: REVIEWED_FEE_DIGEST, evidenceKind: RELEASE_KIND,
  recordedAt: "2026-10-16T03:28:00Z", expiresAt: "2026-10-16T03:38:00Z",
  revokedAt: null, reviewer1: ids[1]!, reviewer2: ids[2]!,
};
const reviews: FeeReview[] = [
  { reviewId: ids[1]!, userId: ids[3]!, digest: REVIEWED_FEE_DIGEST,
    expiresAt: "2026-10-16T03:50:00Z", revokedAt: null, isCurrentAdmin: true },
  { reviewId: ids[2]!, userId: ids[4]!, digest: REVIEWED_FEE_DIGEST,
    expiresAt: "2026-10-16T03:45:00Z", revokedAt: null, isCurrentAdmin: true },
];
describe("operator-attested fee candidate eligibility", () => {
  it("recognizes exactly the unexpired independent candidate, never provider provenance", () => {
    assert.deepEqual(validateOperatorFeeRelease(base, reviews, now), {
      ok: true, releaseId: ids[0], expiresAt: base.expiresAt, provenance: "operator_attested",
    });
  });
  it.each([
    ["no candidate", null, reviews, now],
    ["expired", { ...base, expiresAt: "2026-10-16T03:29:00Z" }, reviews, now],
    ["revoked", { ...base, revokedAt: "2026-10-16T03:29:00Z" }, reviews, now],
    ["forged official type", { ...base, evidenceKind: "provider_verified" }, reviews, now],
    ["wrong PDF digest", { ...base, digest: "a".repeat(64) }, reviews, now],
    ["duplicate review IDs", { ...base, reviewer2: ids[1] }, reviews, now],
    ["same administrator", base, [reviews[0], { ...reviews[1]!, userId: ids[3]! }], now],
    ["admin removed", base, [{ ...reviews[0]!, isCurrentAdmin: false }, reviews[1]], now],
    ["review expired", base, [{ ...reviews[0]!, expiresAt: "2026-10-16T03:29:00Z" }, reviews[1]], now],
    ["review revoked", base, [{ ...reviews[0]!, revokedAt: "2026-10-16T03:29:00Z" }, reviews[1]], now],
    ["ambiguous row", base, [...reviews, reviews[0]], now],
    ["stale observation", base, reviews, now + 20 * 60_000],
  ] as const)("%s fails closed", (_label, candidate, source, at) => {
    assert.equal(validateOperatorFeeRelease(candidate, source, at).ok, false);
  });
});
