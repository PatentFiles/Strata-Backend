import { inspectOperatorFeeCandidate } from "./operatorFeeCandidateRead";
import { activeOperatorFeeRelease, ATTESTED_FEE_POLICY_VERSION,
  feeSourceForApprovedRelease, verifyAttestedFeeIdentity } from "./approvedOperatorFeeSource";
import { STANDARD_QUADRATIC_FEE_FORMULA_VERSION } from "../microLiveFeeArtifact";
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";

/**
 * Read-only cross-source inspection. An operator-attested candidate remains
 * non-authoritative for policy approval, commissioning and live execution.
 * Use this to explain which independent sources pass without retrying PDF HTTP429.
 */
export async function inspectCommissioningFeeEvidence(): Promise<{
  ok: boolean; reason: string; digest: string | null;
  operatorAttested: boolean; uploadedPdfBytesVerified: boolean;
  liveMarketFeesVerified: boolean; candidateExpiresAt: string | null;
  releaseApproved: boolean; sourceUrl?: string; policyVersion?: string;
  checkedAt?: string; marketTicker?: string;
  pdfProviderVerified: false; policyApproved: false;
  commissioningApproved: false; tradingAuthorized: false;
}> {
  const result = { ok: false, reason: "evidence_unavailable",
    digest: null as string | null, operatorAttested: false,
    uploadedPdfBytesVerified: false, liveMarketFeesVerified: false,
    candidateExpiresAt: null as string | null, releaseApproved: false,
    pdfProviderVerified: false as const, policyApproved: false as const,
    commissioningApproved: false as const, tradingAuthorized: false as const };
  try {
    const approved = await activeOperatorFeeRelease();
    if (approved) {
      const source = feeSourceForApprovedRelease(approved.approvalId);
      if (!source) return { ...result, reason: "release_source_identity_invalid" };
      const checked = await verifyAttestedFeeIdentity(source, ATTESTED_FEE_POLICY_VERSION,
        STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
        "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601");
      if (!checked.ok) return { ...result, reason: checked.reason };
      return { ...result, ok: true, reason: "operator_attested_release_verified_read_only",
        digest: checked.digest, releaseApproved: true, operatorAttested: true,
        uploadedPdfBytesVerified: true, liveMarketFeesVerified: true,
        candidateExpiresAt: approved.expiresAt,
        sourceUrl: checked.sourceUrl, policyVersion: ATTESTED_FEE_POLICY_VERSION,
        checkedAt: checked.checkedAt, marketTicker: checked.marketTicker };
    }
    const candidate = await inspectOperatorFeeCandidate();
    if (!candidate.ok) return { ...result, reason: candidate.reason };
    result.candidateExpiresAt = candidate.expiresAt ?? null;
    // The fixed-path Edge POST verifies the exact private 281,129-byte PDF,
    // its SHA-256 and both ADMIN reviewers before writing the service-only
    // candidate row. A trusted row is evidence of that *historical* integrity
    // check, not a current official provider PDF capture.
    // Railway deliberately does NOT receive the Supabase service-role key.
    result.digest = "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
    result.uploadedPdfBytesVerified = true;
    // Don't allow an expiry during the independent market API request.
    if (!(await inspectOperatorFeeCandidate()).ok)
      return { ...result, reason: "candidate_expired_during_verification" };
    const market = await probeCurrentKalshiFeeApi();
    result.liveMarketFeesVerified = market.ok;
    const stillCurrent = (await inspectOperatorFeeCandidate()).ok;
    result.operatorAttested = market.ok && stillCurrent;
    return { ...result, ok: false,
      reason: market.ok && stillCurrent ? "separate_fee_release_approval_required" :
        "live_kalshi_market_fee_or_candidate_unverified" };
  } catch {
    return { ...result, reason: "cross_source_fee_evidence_unavailable" };
  }
}
