/**
 * Typed commissioning-only candidate eligibility. This is NOT official PDF provenance,
 * a risk-policy approval, a fee receipt, or live-execution authorization.
 *
 * Callers MUST obtain claims and release rows from trusted service-only storage;
 * never accept this input from an HTTP request body.
 * An actual commissioning path must also verify the exact private PDF bytes,
 * an independent live Kalshi fee API result, and explicit owner permission.
 */
export const REVIEWED_FEE_DIGEST =
  "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
export const RELEASE_KIND = "operator_attested_commissioning_candidate";
export type FeeReview = {
  reviewId: string;
  userId: string;
  digest: string;
  expiresAt: string;
  revokedAt: string | null;
  isCurrentAdmin: boolean;
};
export type FeeReleaseCandidate = {
  releaseId: string;
  digest: string;
  evidenceKind: string;
  recordedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  reviewer1: string;
  reviewer2: string;
};
export type CandidateEligibility =
  | { ok: true; releaseId: string; expiresAt: string; provenance: "operator_attested" }
  | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = (input: string): number | null => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(input)) return null;
  const value = Date.parse(input);
  return Number.isFinite(value) ? value : null;
};

/** Pure fail-closed check; does not update any approval ledger. */
export function validateOperatorFeeRelease(
  candidate: FeeReleaseCandidate | null,
  reviews: readonly FeeReview[],
  nowMs: number,
): CandidateEligibility {
  const fail = (reason: string): CandidateEligibility => ({ ok: false, reason });
  if (!candidate || !Number.isSafeInteger(nowMs)) return fail("candidate_unavailable");
  if (!UUID.test(candidate.releaseId) || !UUID.test(candidate.reviewer1) ||
      !UUID.test(candidate.reviewer2) || candidate.reviewer1 === candidate.reviewer2 ||
      candidate.digest !== REVIEWED_FEE_DIGEST || candidate.evidenceKind !== RELEASE_KIND ||
      candidate.revokedAt !== null) return fail("candidate_identity_invalid");
  const start = timestamp(candidate.recordedAt), end = timestamp(candidate.expiresAt);
  if (start === null || end === null || start > nowMs || end <= nowMs ||
      end <= start || end - start > 15 * 60_000) return fail("candidate_expired");
  const matched = [candidate.reviewer1, candidate.reviewer2].map(
    id => reviews.filter(r => r.reviewId === id),
  );
  if (matched.some(rows => rows.length !== 1)) return fail("reviews_missing_or_ambiguous");
  const first = matched[0]![0]!, second = matched[1]![0]!;
  if (!UUID.test(first.userId) || !UUID.test(second.userId) ||
      first.userId === second.userId || !first.isCurrentAdmin || !second.isCurrentAdmin ||
      first.revokedAt !== null || second.revokedAt !== null ||
      first.digest !== REVIEWED_FEE_DIGEST || second.digest !== REVIEWED_FEE_DIGEST)
    return fail("review_authority_invalid");
  const expiry1 = timestamp(first.expiresAt), expiry2 = timestamp(second.expiresAt);
  if (expiry1 === null || expiry2 === null || expiry1 <= nowMs || expiry2 <= nowMs ||
      end > expiry1 || end > expiry2) return fail("review_expired");
  return { ok: true, releaseId: candidate.releaseId,
    expiresAt: candidate.expiresAt, provenance: "operator_attested" };
}
