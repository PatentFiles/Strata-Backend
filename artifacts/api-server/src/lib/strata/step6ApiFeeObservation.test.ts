import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { step6ApiFeeObservation } from "./step6ApiFeeObservation";
import { REVIEWED_REFERENCE_PDF_SHA256, type KalshiMarketFeeReadOnly } from "./twoSourceFeeEvidence";

const now = Date.parse("2026-10-17T15:00:00.000Z");
function verified(): KalshiMarketFeeReadOnly {
  return {
    ok: true, reason: "live_series_event_fee_metadata_verified_read_only",
    series: "KXBTC15M", exchangeIndex: 2,
    referenceDigest: REVIEWED_REFERENCE_PDF_SHA256,
    liveVerifiedAt: new Date(now).toISOString(),
    marketTicker: "KXBTC15M-26OCT17T1500",
    eventTicker: "KXBTC15M-26OCT17T1500",
    feeType: "quadratic", feeMultiplier: "1",
    metadataDigest: "a".repeat(64),
    pdfProvenanceApproved: false, ownerPolicyApproved: false,
    commissioningApproved: false, tradingEnabled: false,
  };
}
test("accepts current official API metadata as Step 6-only preflight", () => {
  const proof = step6ApiFeeObservation(verified(), now);
  assert.equal(proof?.ok, true);
  assert.equal(proof?.feeEvidenceDigest, "a".repeat(64));
  assert.equal(proof?.referencePdfDigest, REVIEWED_REFERENCE_PDF_SHA256);
  assert.equal(proof?.providerPdfVerified, false);
  assert.equal(proof?.policyApproved, false);
  assert.equal(proof?.commissioningPerformed, false);
  assert.equal(proof?.tradingAuthorized, false);
  assert.equal("feeArtifactDigest" in (proof ?? {}), false);
});
test("fails closed for stale or future-dated fee metadata", () => {
  assert.equal(step6ApiFeeObservation(verified(), now + 15_001), null);
  assert.equal(step6ApiFeeObservation(verified(), now - 1), null);
});
test("rejects wrong fees, digest, unapproved overrides and live authority", () => {
  for (const changes of [
    { feeMultiplier: "2" }, { feeType: "flat" },
    { referenceDigest: "f".repeat(64) },
    { metadataDigest: "INVALID" }, { exchangeIndex: 0 },
    { pdfProvenanceApproved: true }, { ownerPolicyApproved: true },
    { commissioningApproved: true }, { tradingEnabled: true },
    { marketTicker: "NOT-BTC" }, { eventTicker: "OTHER" },
    { ok: false },
  ]) {
    const bad = { ...verified(), ...changes } as KalshiMarketFeeReadOnly;
    assert.equal(step6ApiFeeObservation(bad, now), null);
  }
});

test("Step 6 read-only route has no PDF fetch dependency or authority mutation", () => {
  // Source contract test: a regression that reintroduces the PDF fetch
  // before API verification fails CI. Path is fixed source controlled by us.
  const workspacePath = join(process.cwd(), "src/routes/userExecutionRouter.ts");
  const rootPath = join(process.cwd(), "artifacts/api-server/src/routes/userExecutionRouter.ts");
  const source = readFileSync(existsSync(workspacePath) ? workspacePath : rootPath, "utf8");
  const start = source.indexOf('router.get("/fees/preflight"');
  const end = source.indexOf('router.get("/policy/evidence"', start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /await probeCurrentKalshiFeeApi\(\)/);
  assert.match(route, /step6ApiFeeObservation\(market\)/);
  assert.doesNotMatch(route, /establishOfficialFeeDigest|fetchOfficialFeeSchedule|feeSchedule\.pdf/);
  assert.match(route, /policyApproved:\s*false/);
  assert.match(route, /commissioningPerformed:\s*false/);
  assert.match(route, /tradingAuthorized:\s*false/);
  assert.doesNotMatch(route, /res\.status\(20[01]\).*approve|executeOrder|sendOrder/);
});
