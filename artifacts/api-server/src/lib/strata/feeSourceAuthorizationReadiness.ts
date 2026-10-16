import { pool } from "@workspace/db";
import { inspectOperatorFeeCandidate } from "./operatorFeeCandidateRead";

/**
 * Stage-specific fee approval readiness. Read only. The current trusted
 * grant/consent stores are not yet installed; do not infer permission from
 * an uploaded PDF, an operator release, or live market metadata.
 */
export type FeeSourceReadiness = {
  ok: true;
  reason: "fee_source_authorization_not_commissioned";
  approvalPathReady: false;
  grantStoreInstalled: boolean;
  ownerConsentStoreInstalled: boolean;
  candidateCurrent: boolean;
  candidateReason: string;
  missingRequirements: string[];
  step6Approved: false;
  step9Approved: false;
  step11Approved: false;
  orderEntryAuthorized: false;
  tradingAuthorized: false;
};

export function buildFeeSourceReadiness(input: {
  grantStoreInstalled: boolean;
  ownerConsentStoreInstalled: boolean;
  candidateCurrent: boolean;
  candidateReason: string;
}): FeeSourceReadiness {
  const missingRequirements: string[] = [];
  if (!input.grantStoreInstalled) missingRequirements.push("trusted_operator_source_grant_store_missing");
  if (!input.ownerConsentStoreInstalled) missingRequirements.push("owner_source_consent_store_missing");
  if (!input.candidateCurrent) missingRequirements.push("independent_operator_release_missing_or_expired");
  // Even if the stores exist and candidate is current, no binding to owner
  // policy, commissioning, and final order verification has been approved.
  missingRequirements.push("owner_policy_stage_binding_not_implemented");
  missingRequirements.push("commissioning_stage_binding_not_implemented");
  missingRequirements.push("final_order_fee_source_binding_not_implemented");
  missingRequirements.push("independent_source_policy_authorization_required");
  return {
    ok: true, reason: "fee_source_authorization_not_commissioned",
    approvalPathReady: false,
    ...input, missingRequirements,
    step6Approved: false, step9Approved: false, step11Approved: false,
    orderEntryAuthorized: false, tradingAuthorized: false,
  };
}

/** Authenticated owner only; no browser-supplied IDs, symbols, or approval. */
export async function inspectFeeSourceAuthorizationReadiness(): Promise<FeeSourceReadiness> {
  let grantStoreInstalled = false;
  let ownerConsentStoreInstalled = false;
  try {
    const r = await pool.query(
      "SELECT to_regclass('private.strata_operator_fee_source_grants') IS NOT NULL AS grants, " +
      "to_regclass('private.strata_operator_fee_owner_consents') IS NOT NULL AS consents",
    );
    grantStoreInstalled = r.rows.length === 1 && r.rows[0]?.grants === true;
    ownerConsentStoreInstalled = r.rows.length === 1 && r.rows[0]?.consents === true;
  } catch {
    // Storage inspection failing must never be interpreted as installed.
  }
  let candidateCurrent = false;
  let candidateReason = "operator_candidate_unavailable";
  try {
    const candidate = await inspectOperatorFeeCandidate();
    candidateCurrent = candidate.ok;
    candidateReason = candidate.reason;
  } catch {
    candidateReason = "operator_candidate_unavailable";
  }
  return buildFeeSourceReadiness({
    grantStoreInstalled, ownerConsentStoreInstalled,
    candidateCurrent, candidateReason,
  });
}
