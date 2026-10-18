/** Pure guards used before recording a time-limited operator release candidate. */
export type SourceReviewRow = {
  review_id: string;
  reviewer_user_id: string;
  expires_at: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function selectLiveSingleReview(
  rows: SourceReviewRow[],
  nowMs: number,
): { ok: true; ids: [string]; latestPossibleExpiryMs: number } |
   { ok: false; reason: string } {
  if (!Number.isSafeInteger(nowMs) || rows.length > 12)
    return { ok: false, reason: "invalid_review_window" };
  const distinct = new Map<string, SourceReviewRow>();
  for (const row of rows) {
    const expiration = Date.parse(row.expires_at);
    if (!UUID.test(row.review_id) || !UUID.test(row.reviewer_user_id) ||
        !Number.isFinite(expiration) || expiration <= nowMs) continue;
    if (!distinct.has(row.reviewer_user_id)) distinct.set(row.reviewer_user_id, row);
  }
  const first = [...distinct.values()].slice(0, 1);
  if (first.length !== 1) return { ok: false, reason: "one_current_admin_claim_required" };
  const ids = first.map(x => x.review_id).sort() as [string];
  const latestPossibleExpiryMs = Math.min(...first.map(x => Date.parse(x.expires_at)));
  if (ids[0] === ids[1] || latestPossibleExpiryMs <= nowMs)
    return { ok: false, reason: "review_claims_expired" };
  return { ok: true, ids, latestPossibleExpiryMs };
}

export function boundedCandidateExpiry(
  nowMs: number,
  reviewExpiryMs: number,
): string | null {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(reviewExpiryMs))
    return null;
  const until = Math.min(nowMs + 15 * 60_000, reviewExpiryMs);
  // Refuse a race near expiry; never extend either review.
  return until > nowMs + 30_000 ? new Date(until).toISOString() : null;
}
