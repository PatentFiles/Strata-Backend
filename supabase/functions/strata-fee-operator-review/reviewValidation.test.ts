import assert from "node:assert/strict";
import { ATTESTATION, SOURCE_URL, validReview } from "./reviewValidation.ts";

const now = Date.parse("2026-10-15T23:00:00.000Z");
const good = () => ({
  canonicalUrl: SOURCE_URL,
  effectiveDate: "2026-07-07",
  observedAt: new Date(now - 30_000).toISOString(),
  reviewNote: "I inspected all 12 official PDF pages, the effective date and the KXBTC15M exception table.",
  statement: ATTESTATION,
});

Deno.test("accepts exact, recent, explicit independent operator claim", () => {
  assert.equal(validReview(good(), now), true);
});

Deno.test("does not accept a self-declared canonical URL substitute", () => {
  assert.equal(validReview({ ...good(), canonicalUrl: SOURCE_URL + "?refresh=1" }, now), false);
  assert.equal(validReview({ ...good(), canonicalUrl: "https://example.com/fees.pdf" }, now), false);
});

Deno.test("rejects stale or future operator observations", () => {
  assert.equal(validReview({ ...good(), observedAt: new Date(now - 15*60_000-1).toISOString() }, now), false);
  assert.equal(validReview({ ...good(), observedAt: new Date(now+10_001).toISOString() }, now), false);
  assert.equal(validReview({ ...good(), observedAt: "not-a-date" }, now), false);
});

Deno.test("requires exact document edition and fully reviewed statement", () => {
  assert.equal(validReview({ ...good(), effectiveDate: "2025-10-01" }, now), false);
  assert.equal(validReview({ ...good(), statement: "I saw a PDF" }, now), false);
  assert.equal(validReview({ ...good(), reviewNote: "ok" }, now), false);
  assert.equal(validReview({ ...good(), reviewNote: "x".repeat(1201) }, now), false);
});

Deno.test("rejects extra authorization fields and malformed objects", () => {
  assert.equal(validReview({ ...good(), approved: true }, now), false);
  assert.equal(validReview({ ...good(), tradingEnabled: true }, now), false);
  assert.equal(validReview(null, now), false);
  assert.equal(validReview([], now), false);
});
