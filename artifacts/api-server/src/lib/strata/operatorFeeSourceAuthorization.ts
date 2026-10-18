/**
 * Deliberately isolated fee-source authorization boundary.
 *
 * An uploaded PDF, independent administrator claims, a short-lived release,
 * and an official market-metadata API response are four DIFFERENT artifacts.
 * They are NOT a provider-origin PDF capture or, on their own, authority to
 * approve an owner's policy or release live orders.
 *
 * This module validates a future explicitly approved alternative-source grant.
 * The grant and owner consent must be independently authenticated, immutable
 * records loaded by backend service credentials (never browser input).
 *
 * IMPORTANT: Not currently wired to Step 6, 9, 11 or the worker. Until a
 * separately audited authority store, revocation flow and stage-gate integration
 * exist, the legacy official-source gates remain authoritative.
 */
import { REVIEWED_FEE_DIGEST, type CandidateEligibility } from "./operatorAttestedFeeEligibility";

export const OPERATOR_FEE_SOURCE_POLICY = "operator_attested_fee_source_v2" as const;
export type FeeAuthorizationStage = "STEP_6" | "STEP_9" | "STEP_11" | "ORDER_ENTRY";

export type ApprovedOperatorFeeSourceGrant = {
  policyVersion: typeof OPERATOR_FEE_SOURCE_POLICY;
  grantId: string;
  releaseId: string;
  reviewedPdfSha256: string;
  ownerUserId: string;
  approvedByAdminId: string;
  approvedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  /** Explicit, auditable decisions about where alternative provenance may be used. */
  authorizedStages: readonly FeeAuthorizationStage[];
};
export type SignedOwnerSourceConsent = {
  ownerUserId: string;
  grantId: string;
  releaseId: string;
  confirmedAtMs: number;
  revokedAtMs: number | null;
};
export type LiveKalshiFeeScope = {
  ticker: string;
  eventTicker: string;
  series: "KXBTC15M";
  exchangeIndex: 2;
  multiplier: 1;
  feeType: "quadratic";
  metadataFingerprint: string;
  verifiedAtMs: number;
  /** Complete live market + event/series scheduled changes and overrides. */
  noUnverifiedOverridesOrChanges: true;
};
export type OperatorSourceInputs = {
  nowMs: number;
  stage: FeeAuthorizationStage;
  callerOwnerUserId: string;
  eligibleCandidate: CandidateEligibility;
  grant: ApprovedOperatorFeeSourceGrant | null;
  consent: SignedOwnerSourceConsent | null;
  liveScope: LiveKalshiFeeScope | null;
  privatePdfSha256: string | null;
};

export type OperatorSourceDecision = {
  ok: boolean;
  reason: string;
  expiresAtMs: number | null;
  sourceKind: "operator_attested_not_provider";
  /** This assessment NEVER establishes cryptographic provider PDF provenance. */
  pdfProviderVerified: false;
  /** Actual persistent policy, commissioning and execution decisions are separate. */
  policyApproved: false;
  commissioningApproved: false;
  tradingAuthorized: false;
};
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKER = /^KXBTC15M-[A-Za-z0-9-]+$/;
const MAX_GRANT_LIFETIME_MS = 15 * 60_000;
const MAX_LIVE_METADATA_AGE_MS = 10_000;
const deny = (reason: string): OperatorSourceDecision => ({
  ok:false, reason, expiresAtMs:null,
  sourceKind:"operator_attested_not_provider",
  pdfProviderVerified:false, policyApproved:false,
  commissioningApproved:false, tradingAuthorized:false,
});

/**
 * Advisory, fail-closed validation. A positive outcome means only that a
 * proposed operator-source grant is internally consistent at this instant.
 * It is NOT an authorization side effect and never establishes provider proof.
 */
export function evaluateOperatorSourceGrant(input: OperatorSourceInputs): OperatorSourceDecision {
  const now = input.nowMs;
  if (!Number.isSafeInteger(now) || now <= 0 || !UUID.test(input.callerOwnerUserId))
    return deny("owner_identity_invalid");
  const candidate = input.eligibleCandidate;
  if (!candidate.ok || candidate.provenance !== "operator_attested" ||
      !UUID.test(candidate.releaseId)) return deny("operator_release_not_eligible");
  const candidateExpiry = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(candidateExpiry) || candidateExpiry <= now)
    return deny("operator_release_expired");
  if (input.privatePdfSha256 !== REVIEWED_FEE_DIGEST)
    return deny("reviewed_pdf_integrity_unverified");

  const grant = input.grant;
  if (!grant) return deny("operator_source_policy_grant_missing");
  if (grant.policyVersion !== OPERATOR_FEE_SOURCE_POLICY ||
      !UUID.test(grant.grantId) || !UUID.test(grant.approvedByAdminId) ||
      grant.ownerUserId !== input.callerOwnerUserId ||
      grant.releaseId !== candidate.releaseId ||
      grant.reviewedPdfSha256 !== REVIEWED_FEE_DIGEST ||
      grant.revokedAtMs !== null)
    return deny("operator_source_policy_grant_invalid");
  if (!Array.isArray(grant.authorizedStages) ||
      new Set(grant.authorizedStages).size !== grant.authorizedStages.length ||
      !grant.authorizedStages.includes(input.stage) ||
      !Number.isSafeInteger(grant.approvedAtMs) ||
      !Number.isSafeInteger(grant.expiresAtMs) ||
      grant.approvedAtMs > now || grant.approvedAtMs <= 0 ||
      grant.expiresAtMs <= now || grant.expiresAtMs > candidateExpiry ||
      grant.expiresAtMs - grant.approvedAtMs > MAX_GRANT_LIFETIME_MS)
    return deny("operator_source_policy_scope_or_expiry_invalid");

  const consent = input.consent;
  if (!consent || consent.ownerUserId !== grant.ownerUserId ||
      consent.grantId !== grant.grantId || consent.releaseId !== candidate.releaseId ||
      consent.revokedAtMs !== null || !Number.isSafeInteger(consent.confirmedAtMs) ||
      consent.confirmedAtMs < grant.approvedAtMs || consent.confirmedAtMs > now)
    return deny("owner_source_consent_missing_or_invalid");

  const scope = input.liveScope;
  if (!scope || scope.series !== "KXBTC15M" ||
      scope.exchangeIndex !== 2 || scope.feeType !== "quadratic" ||
      scope.multiplier !== 1 || !TICKER.test(scope.ticker) ||
      !TICKER.test(scope.eventTicker) ||
      !scope.ticker.startsWith(scope.eventTicker + "-") ||
      scope.noUnverifiedOverridesOrChanges !== true ||
      !SHA.test(scope.metadataFingerprint) ||
      !Number.isSafeInteger(scope.verifiedAtMs) ||
      scope.verifiedAtMs > now ||
      now - scope.verifiedAtMs > MAX_LIVE_METADATA_AGE_MS)
    return deny("live_event_fee_evidence_unverified");
  return {
    ...deny("operator_source_grant_read_only_eligible"),
    ok: true,
    expiresAtMs: Math.min(candidateExpiry, grant.expiresAtMs),
  };
}
