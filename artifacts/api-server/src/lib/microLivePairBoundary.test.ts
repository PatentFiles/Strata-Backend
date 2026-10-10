import assert from "node:assert/strict";
import test from "node:test";
import { isFundingBoundaryEligible } from "./microLivePairBoundary";

test("funding requires the exact verified (N,2) key-bound state", () => {
  const expected = {
    subaccountNumber: 7,
    apiKeyId: "restricted-key",
    fingerprint: "a".repeat(64),
  };
  const boundary = {
    state: "KEY_BOUND_VERIFIED",
    subaccountNumber: 7,
    exchangeIndex: 2,
    restrictedApiKeyId: "restricted-key",
    restrictedKeyFingerprint: "a".repeat(64),
    keyBoundAt: new Date("2026-09-26T12:00:00.000Z"),
    keyBindingEvidenceDigest: "b".repeat(64),
  };
  assert.equal(isFundingBoundaryEligible(boundary, expected), true);
  assert.equal(isFundingBoundaryEligible({ ...boundary, state: "CREATED_CLEAN" }, expected), false);
  assert.equal(isFundingBoundaryEligible({ ...boundary, subaccountNumber: 8 }, expected), false);
  assert.equal(isFundingBoundaryEligible({ ...boundary, exchangeIndex: 1 }, expected), false);
  assert.equal(isFundingBoundaryEligible({
    ...boundary, restrictedApiKeyId: "different-key",
  }, expected), false);
});