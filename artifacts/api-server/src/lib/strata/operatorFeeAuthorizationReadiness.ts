import { pool } from "@workspace/db";
import { REVIEWED_FEE_DIGEST } from "./operatorAttestedFeeEligibility";
import { FEE_SOURCE_DECISION_SHA256 } from "./operatorFeePolicyDecision";
import { inspectOperatorFeeCandidate } from "./operatorFeeCandidateRead";
import { evaluateOperatorSourceGrant, OPERATOR_FEE_SOURCE_POLICY,
  type ApprovedOperatorFeeSourceGrant, type FeeAuthorizationStage,
  type LiveKalshiFeeScope, type SignedOwnerSourceConsent,
} from "./operatorFeeSourceAuthorization";
import { probeCurrentKalshiFeeApi } from "./twoSourceFeeEvidence";

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type CandidateReader = typeof inspectOperatorFeeCandidate;
type MarketReader = typeof probeCurrentKalshiFeeApi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnerFeeSourceReadiness {
  ok: boolean;
  reason: string;
  diagnosticEligible: boolean;
  sourceKind: "operator_attested_not_provider";
  providerPdfVerified: false;
  feePolicyApproved: false;
  commissioningApproved: false;
  tradingAuthorized: false;
  stageChecks: Record<FeeAuthorizationStage, boolean>;
  candidateExpiresAt: string | null;
  grantExpiresAt: string | null;
  grantId: string | null;
  releaseId: string | null;
  marketTicker: string | null;
  metadataFingerprint: string | null;
  metadataVerifiedAt: string | null;
}

const ALL_STAGES: readonly FeeAuthorizationStage[] = ["STEP_6","STEP_9","STEP_11","ORDER_ENTRY"];
function blocked(reason: string): OwnerFeeSourceReadiness {
  return {
    ok: false, reason, diagnosticEligible: false,
    sourceKind: "operator_attested_not_provider",
    providerPdfVerified: false, feePolicyApproved: false,
    commissioningApproved: false, tradingAuthorized: false,
    stageChecks: { STEP_6:false, STEP_9:false, STEP_11:false, ORDER_ENTRY:false },
    candidateExpiresAt: null, grantExpiresAt: null,
    grantId: null, releaseId: null, marketTicker: null,
    metadataFingerprint: null,metadataVerifiedAt: null,
  };
}
function isoMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : NaN;
}
function dbGrant(r: Record<string, unknown>): ApprovedOperatorFeeSourceGrant {
  // Only used with rows retrieved from PRIVATE server-side tables, never HTTP body.
  return {
    policyVersion: String(r.policy_version) as typeof OPERATOR_FEE_SOURCE_POLICY,
    grantId: String(r.grant_id), ownerUserId: String(r.owner_user_id),
    releaseId: String(r.release_id), reviewedPdfSha256: String(r.reviewed_pdf_sha256),
    approvedByAdminId: String(r.approved_by_admin_id),
    approvedAtMs: isoMs(r.approved_at), expiresAtMs: isoMs(r.expires_at),
    revokedAtMs: r.revoked_at === null ? null : isoMs(r.revoked_at),
    authorizedStages: Array.isArray(r.authorized_stages)
      ? r.authorized_stages as FeeAuthorizationStage[] : [],
  };
}
function dbConsent(r: Record<string, unknown>): SignedOwnerSourceConsent {
  return {
    ownerUserId: String(r.owner_user_id), grantId: String(r.grant_id),
    releaseId: String(r.release_id), confirmedAtMs: isoMs(r.confirmed_at),
    revokedAtMs: r.revoked_at === null ? null : isoMs(r.revoked_at),
  };
}
function observedMarket(
  market: Awaited<ReturnType<MarketReader>>,
): LiveKalshiFeeScope | null {
  if (!market.ok || !market.marketTicker || !market.eventTicker ||
      !market.metadataDigest || !market.liveVerifiedAt ||
      market.feeType !== "quadratic" || market.feeMultiplier !== "1" ||
      market.exchangeIndex !== 2 || market.series !== "KXBTC15M") return null;
  return {
    ticker: market.marketTicker, eventTicker: market.eventTicker,
    series: "KXBTC15M", exchangeIndex: 2, feeType: "quadratic", multiplier: 1,
    metadataFingerprint: market.metadataDigest,
    verifiedAtMs: isoMs(market.liveVerifiedAt),
    noUnverifiedOverridesOrChanges: true,
  };
}

/**
 * Authenticated owner-scoped, READ-ONLY authorization prerequisite inspector.
 * Does NOT write grant/consent, approve a policy, commission, or submit orders.
 * Any future stage mutator MUST independently reload immutable private records,
 * check the relevant stage and the exact trade market at its final execution fence.
 */
export async function inspectOwnerFeeSourceReadiness(
  ownerUserId: string,
  db: Queryable = pool,
  readCandidate: CandidateReader = inspectOperatorFeeCandidate,
  readMarket: MarketReader = probeCurrentKalshiFeeApi,
  now: () => number = Date.now,
): Promise<OwnerFeeSourceReadiness> {
  if (!UUID.test(ownerUserId)) return blocked("owner_identity_invalid");
  try {
    const account = await db.query(
      "SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 LIMIT 2",
      [ownerUserId],
    );
    if (account.rows.length !== 1) return blocked("owned_execution_account_missing_or_ambiguous");
    const candidate = await readCandidate();
    if (!candidate.ok || !candidate.releaseId || !candidate.expiresAt)
      return blocked(candidate.reason || "operator_candidate_missing");
    // Multiple independently issued grants are ambiguous; never choose one.
    const grants = await db.query(
      `SELECT grant_id,owner_user_id,release_id,reviewed_pdf_sha256,policy_version,
              approved_by_admin_id,approved_at,expires_at,revoked_at,authorized_stages
         FROM private.strata_fee_source_grants
        WHERE owner_user_id=$1::uuid AND release_id=$2::uuid
          AND revoked_at IS NULL AND expires_at>now()
          AND policy_decision_sha256=$3
          AND EXISTS (
            SELECT 1 FROM auth.users issuing
            JOIN private.role_assignments ar ON lower(btrim(ar.email))=lower(btrim(issuing.email))
            WHERE issuing.id=approved_by_admin_id AND issuing.email_confirmed_at IS NOT NULL
              AND ar.role='ADMIN'
          )
          AND (
            SELECT count(DISTINCT reviewers.reviewer_user_id)
            FROM private.strata_fee_source_policy_reviews reviewers
            JOIN auth.users signer ON signer.id=reviewers.reviewer_user_id
            JOIN private.role_assignments sr
              ON lower(btrim(sr.email))=lower(btrim(signer.email))
            WHERE reviewers.owner_user_id=$1::uuid AND reviewers.release_id=$2::uuid
              AND reviewers.policy_decision_sha256=$3
              AND reviewers.reviewed_pdf_sha256=reviewed_pdf_sha256
              AND reviewers.revoked_at IS NULL AND reviewers.expires_at>now()
              AND signer.email_confirmed_at IS NOT NULL AND sr.role='ADMIN'
          ) >= 2
        ORDER BY approved_at DESC LIMIT 2`,
      [ownerUserId, candidate.releaseId, FEE_SOURCE_DECISION_SHA256],
    );
    if (grants.rows.length !== 1) {
      const denied = blocked(grants.rows.length ? "multiple_active_source_grants" : "source_policy_grant_missing");
      denied.candidateExpiresAt = candidate.expiresAt;
      return denied;
    }
    const grant = dbGrant(grants.rows[0]!);
    const consents = await db.query(
      `SELECT grant_id,owner_user_id,release_id,confirmed_at,revoked_at,confirmation
         FROM private.strata_fee_source_owner_consents
        WHERE grant_id=$1::uuid AND owner_user_id=$2::uuid
        LIMIT 2`,
      [grant.grantId, ownerUserId],
    );
    if (consents.rows.length !== 1 ||
        consents.rows[0]?.confirmation !== "CONFIRM_OPERATOR_FEE_SOURCE_ONLY") {
      const denied = blocked("owner_source_consent_missing_or_ambiguous");
      denied.candidateExpiresAt = candidate.expiresAt;
      return denied;
    }
    const consent = dbConsent(consents.rows[0]!);
    const market = observedMarket(await readMarket());
    const at = now();
    const stages = Object.fromEntries(ALL_STAGES.map(stage => {
      const assessment = evaluateOperatorSourceGrant({
        nowMs: at, stage, callerOwnerUserId: ownerUserId,
        eligibleCandidate: { ok:true,releaseId:candidate.releaseId!,
          expiresAt:candidate.expiresAt!,provenance:"operator_attested" },
        grant,consent,liveScope:market,privatePdfSha256:REVIEWED_FEE_DIGEST,
      });
      return [stage,assessment.ok];
    })) as Record<FeeAuthorizationStage, boolean>;
    const allOk = ALL_STAGES.every(stage => stages[stage]);
    return {
      ...blocked(allOk ? "operator_source_read_only_prerequisites_present" :
        !market ? "live_market_fee_evidence_unverified" : "source_scope_or_evidence_not_authorized"),
      diagnosticEligible: allOk,
      // Even a positive diagnostic is NOT valid production authority.
      candidateExpiresAt:candidate.expiresAt,
      grantExpiresAt:Number.isFinite(grant.expiresAtMs)
        ? new Date(grant.expiresAtMs).toISOString() : null,
      stageChecks:stages,
      grantId: grant.grantId,
      releaseId: candidate.releaseId,
      marketTicker: market?.ticker ?? null,
      metadataFingerprint: market?.metadataFingerprint ?? null,
      metadataVerifiedAt: market && Number.isFinite(market.verifiedAtMs)
        ? new Date(market.verifiedAtMs).toISOString():null,
    };
  } catch {
    return blocked("private_fee_authorization_ledger_unavailable");
  }
}
