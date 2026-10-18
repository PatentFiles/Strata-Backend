import { pool } from "@workspace/db";
import { validateOperatorFeeRelease, REVIEWED_FEE_DIGEST,
  type FeeReleaseCandidate, type FeeReview } from "./operatorAttestedFeeEligibility";

/**
 * Backend-only, read-only candidate assessment. Never accepts reviewer identities
 * from the browser and never promotes operator attestations to official captures.
 */
export async function inspectOperatorFeeCandidate(): Promise<{
  ok: boolean; reason: string; provenance: "operator_attested" | null;
  releaseId?: string; expiresAt?: string; approvedOfficialPdf: false;
  policyApproved: false; commissioningApproved: false; tradingAuthorized: false;
}> {
  const blocked = (reason: string) => ({
    ok: false, reason, provenance: null as null, approvedOfficialPdf: false as const,
    policyApproved: false as const, commissioningApproved: false as const,
    tradingAuthorized: false as const,
  });
  try {
    const release = await pool.query(`
      SELECT release_id, content_sha256, evidence_kind, recorded_at, expires_at,
             revoked_at, reviewer_1, reviewer_2
      FROM public.strata_fee_operator_release_candidates
      WHERE content_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY recorded_at DESC LIMIT 2`, [REVIEWED_FEE_DIGEST]);
    if (release.rows.length !== 1) return blocked("candidate_missing_or_ambiguous");
    const item = release.rows[0]!;
    const reviews = await pool.query(`
      SELECT r.review_id, r.reviewer_user_id, r.content_sha256, r.expires_at,
             u.email_confirmed_at,
             EXISTS(SELECT 1 FROM private.role_assignments ra
               WHERE lower(btrim(ra.email))=lower(btrim(u.email)) AND ra.role='ADMIN')
               AS is_current_admin
      FROM public.strata_fee_operator_source_reviews r
      JOIN auth.users u ON u.id=r.reviewer_user_id
      WHERE r.review_id IN ($1::uuid,$2::uuid)`,
      [item.reviewer_1, item.reviewer_2]);
    const asTime = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : String(value ?? "");
    const candidate: FeeReleaseCandidate = {
      releaseId: String(item.release_id), digest: String(item.content_sha256),
      evidenceKind: String(item.evidence_kind), recordedAt: asTime(item.recorded_at),
      expiresAt: asTime(item.expires_at), revokedAt: item.revoked_at === null
        ? null : asTime(item.revoked_at),
      reviewer1: String(item.reviewer_1), reviewer2: item.reviewer_2 === null ? null : String(item.reviewer_2),
    };
    const claims: FeeReview[] = reviews.rows.map(r => ({
      reviewId: String(r.review_id), userId: String(r.reviewer_user_id),
      digest: String(r.content_sha256), expiresAt: asTime(r.expires_at),
      revokedAt: null,
      isCurrentAdmin: r.is_current_admin === true && r.email_confirmed_at !== null,
    }));
    const eligibility = validateOperatorFeeRelease(candidate, claims, Date.now());
    if (!eligibility.ok) return blocked(eligibility.reason);
    return { ...eligibility, reason: "operator_candidate_reviewed_only", approvedOfficialPdf: false, policyApproved: false,
      commissioningApproved: false, tradingAuthorized: false };
  } catch {
    return blocked("operator_fee_review_unavailable");
  }
}
