/** Pure, testable validation for explicit administrator review claims.
 * The input is a human statement and NEVER a verified Kalshi server receipt.
 */
export const SOURCE_URL = "https://kalshi.com/docs/kalshi-fee-schedule.pdf";
export const ATTESTATION =
  "I independently reviewed the current Kalshi fee schedule at its official URL and confirmed its July 7, 2026 effective date, general rate, exceptions, and market scope. This is a human review, not an automated Kalshi download.";

export type ReviewRequest = {
  canonicalUrl: string;
  effectiveDate: string;
  observedAt: string;
  reviewNote: string;
  statement: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validReview(payload: unknown, now: number): payload is ReviewRequest {
  if (!isRecord(payload)) return false;
  const fields = Object.keys(payload).sort();
  if (fields.join(",") !== "canonicalUrl,effectiveDate,observedAt,reviewNote,statement") return false;
  if (payload.canonicalUrl !== SOURCE_URL || payload.effectiveDate !== "2026-07-07" ||
      payload.statement !== ATTESTATION || typeof payload.reviewNote !== "string" ||
      payload.reviewNote.trim().length < 40 || payload.reviewNote.length > 1200 ||
      typeof payload.observedAt !== "string") return false;
  const observedAt = Date.parse(payload.observedAt);
  return Number.isFinite(observedAt) && observedAt >= now - 15 * 60_000 &&
    observedAt <= now + 10_000;
}
