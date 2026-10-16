import { pool } from "@workspace/db";
import { inspectCommissioningFeeEvidence } from "./commissioningFeeEvidenceDiagnostic";

/** Owner-scoped readiness only. No grants are issued, no flags are altered. */
export type FeeAuthorizationReadiness = {
  ok: false;
  stage: "STEP_6" | "STEP_9" | "STEP_11" | "ORDER_ENTRY";
  ownerScoped: true;
  operatorEvidenceDiagnosticPassed: boolean;
  privateAuthorizationStoreReady: boolean;
  sourcePolicyGrantRecorded: boolean;
  ownerSourceConsentRecorded: boolean;
  blockers: string[];
  officialPdfApproved: false;
  policyApproved: false;
  commissioningApproved: false;
  tradingAuthorized: false;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(["STEP_6", "STEP_9", "STEP_11", "ORDER_ENTRY"]);
export async function inspectFeeAuthorizationReadiness(
  userId: string, requestedStage: string,
  query: typeof pool.query = pool.query.bind(pool),
  diagnostic: typeof inspectCommissioningFeeEvidence = inspectCommissioningFeeEvidence,
): Promise<FeeAuthorizationReadiness> {
  const stage = STAGES.has(requestedStage)
    ? requestedStage as FeeAuthorizationReadiness["stage"] : "STEP_6";
  const blockers: string[] = [];
  let evidencePassed = false;
  let storeReady = false;
  let grantRecorded = false;
  let consentRecorded = false;
  if (!UUID.test(userId) || !STAGES.has(requestedStage)) {
    blockers.push("owner_or_stage_invalid");
  } else {
    try {
      const evidence = await diagnostic();
      evidencePassed = evidence.ok && evidence.operatorAttested &&
        evidence.uploadedPdfBytesVerified && evidence.liveMarketFeesVerified &&
        evidence.pdfProviderVerified === false;
      if (!evidencePassed) blockers.push("operator_evidence_missing_or_expired");
    } catch {
      blockers.push("operator_evidence_check_unavailable");
    }
    try {
      // Discover optional, service-only private authorization tables. Do not
      // allow browser data to supply grants, consent, issuer IDs or fee proofs.
      const found = await query(`
        SELECT to_regclass('private.strata_operator_fee_source_grants') IS NOT NULL
                 AS grant_table,
               to_regclass('private.strata_owner_fee_source_consents') IS NOT NULL
                 AS consent_table
      `);
      storeReady = found.rows.length === 1 &&
        found.rows[0]?.grant_table === true && found.rows[0]?.consent_table === true;
      if (!storeReady) blockers.push("source_authorization_store_not_installed");
      // Even if tables exist, do NOT infer that a grant or consent is valid
      // from a row count. The authorization issuer, revocation, scoped stages,
      // owner signature, and immutable receipt still require verified reads.
      if (!grantRecorded) blockers.push("approved_operator_source_grant_unverified");
      if (!consentRecorded) blockers.push("signed_owner_source_consent_unverified");
    } catch {
      blockers.push("source_authorization_store_unavailable");
    }
  }
  blockers.push("stage_bound_fee_approval_not_implemented");
  return {
    ok: false, stage, ownerScoped: true,
    operatorEvidenceDiagnosticPassed: evidencePassed,
    privateAuthorizationStoreReady: storeReady,
    sourcePolicyGrantRecorded: grantRecorded,
    ownerSourceConsentRecorded: consentRecorded,
    blockers,
    officialPdfApproved: false, policyApproved: false,
    commissioningApproved: false, tradingAuthorized: false,
  };
}
