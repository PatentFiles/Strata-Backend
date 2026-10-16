import assert from "node:assert/strict";
import test from "node:test";
import { buildFeeSourceReadiness } from "./feeSourceAuthorizationReadiness";

test("refuses uninstalled storage and expired operator release", () => {
  const result = buildFeeSourceReadiness({
    grantStoreInstalled:false, ownerConsentStoreInstalled:false,
    candidateCurrent:false, candidateReason:"candidate_expired",
  });
  assert.equal(result.approvalPathReady,false);
  assert.equal(result.orderEntryAuthorized,false);
  assert.equal(result.tradingAuthorized,false);
  assert.ok(result.missingRequirements.includes("trusted_operator_source_grant_store_missing"));
  assert.ok(result.missingRequirements.includes("owner_source_consent_store_missing"));
});
test("even fully present diagnostic inputs grant no authority", () => {
  const result = buildFeeSourceReadiness({
    grantStoreInstalled:true, ownerConsentStoreInstalled:true,
    candidateCurrent:true, candidateReason:"operator_candidate_reviewed_only",
  });
  assert.equal(result.step6Approved,false);
  assert.equal(result.step9Approved,false);
  assert.equal(result.step11Approved,false);
  assert.equal(result.orderEntryAuthorized,false);
  assert.equal(result.tradingAuthorized,false);
  assert.ok(result.missingRequirements.includes("independent_source_policy_authorization_required"));
});
