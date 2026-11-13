import { assertEquals, assert } from "jsr:@std/assert@1";
import { boundedCandidateExpiry, selectLiveDistinctReviews } from "./releaseCandidateValidation.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const now = Date.parse("2026-10-15T21:00:00Z");
const row = (review_id: string, reviewer_user_id: string, futureMs=120_000) =>
  ({ review_id, reviewer_user_id, expires_at: new Date(now + futureMs).toISOString() });

Deno.test("accepts two distinct current reviewers with sorted IDs", () => {
  const selected = selectLiveDistinctReviews([row(B, A), row(A, B)], now);
  assert(selected.ok);
  assertEquals(selected.ids, [A, B]);
  assertEquals(selected.latestPossibleExpiryMs, now+120_000);
});
Deno.test("rejects duplicate reviewer even with different review ids", () => {
  assertEquals(selectLiveDistinctReviews([row(A, C), row(B, C)], now),
    {ok:false,reason:"two_current_independent_admin_claims_required"});
});
Deno.test("rejects expired and malformed reviews and no reviewer", () => {
  for (const reviews of [
    [row(A,A,-1),row(B,B)],
    [row(A,A),row(B,B,-1)],
    [row("not-a-uuid",A),row(B,B)],
    [row(A,A),row(B,"invalid")],
    [],
  ]) {
    assertEquals(selectLiveDistinctReviews(reviews, now).ok, false);
  }
});
Deno.test("only first valid claim from each reviewer counts", () => {
  const selection=selectLiveDistinctReviews([row(A,C),row(C,C),row(B,D)],now);
  assert(selection.ok);
  assertEquals(selection.ids,[A,B]);
});
Deno.test("expiry never extends a review or exceeds 15 minutes", () => {
  assertEquals(boundedCandidateExpiry(now,now + 60_000),new Date(now+60_000).toISOString());
  assertEquals(boundedCandidateExpiry(now,now + 3_600_000),new Date(now+900_000).toISOString());
  assertEquals(boundedCandidateExpiry(now,now + 30_000),null);
  assertEquals(boundedCandidateExpiry(now,now - 1),null);
});
Deno.test("invalid times and too many rows fail closed", () => {
  assertEquals(boundedCandidateExpiry(Number.NaN, now+60_000),null);
  assertEquals(selectLiveDistinctReviews(Array(13).fill(row(A,A)),now).ok,false);
});
