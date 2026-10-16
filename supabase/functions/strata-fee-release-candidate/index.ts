/**
 * Incident-scoped operator attestation RELEASE CANDIDATE, not official Kalshi
 * evidence and not authorization for a policy, account or live orders.
 *
 * GET: readiness of two unexpired ADMIN-reviewed claims and candidate status.
 * POST: separate explicit authenticated ADMIN confirmation, fixed private PDF
 * digest, distinct reviewers, 15-minute expiry; append-only candidate record.
 *
 * Importantly: no official capture write, policy write, or Kalshi credential.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { selectLiveDistinctReviews, boundedCandidateExpiry, type SourceReviewRow } from "./releaseCandidateValidation.ts";

const BUCKET = "strata-official-fee-artifacts";
const PATH = "operator-pending/kalshi-fee-schedule.pdf";
const SHA = "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
const SIZE = 281129;
const REVIEWS = "strata_fee_operator_source_reviews";
const RELEASES = "strata_fee_operator_release_candidates";
const CONFIRMATION = "REVIEW_OPERATOR_ATTESTED_COMMISSIONING_ONLY";
const HOST = Deno.env.get("STRATA_WEB_ORIGIN")?.trim() || "https://private-multi-asset-eviv.bolt.host";
const CORS = {
  "access-control-allow-origin": HOST, "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-version",
  "access-control-allow-methods": "GET, POST, OPTIONS", vary: "Origin",
};
const HEADERS = { "content-type": "application/json", "cache-control": "private, no-store",
  "x-content-type-options": "nosniff", ...CORS };
function result(status: number, obj: Record<string, unknown>): Response {
  return new Response(JSON.stringify(obj), { status, headers: HEADERS });
}
function fail(status: number, reason: string): Response { return result(status, { ok: false, reason }); }
function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength)); owned.set(bytes);
  return crypto.subtle.digest("SHA-256", owned.buffer)
    .then(buffer => Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2, "0")).join(""));
}
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return req.headers.get("origin") === HOST
      ? new Response(null, { status: 204, headers: CORS })
      : new Response(null, { status: 403, headers: { vary: "Origin" } });
  }
  if (req.method !== "GET" && req.method !== "POST") return fail(405, "method_not_allowed");
  const address = new URL(req.url);
  if (address.search || address.pathname.split("/").pop() !== "strata-fee-release-candidate")
    return fail(404, "unsupported_path");
  const endpoint = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!endpoint || !anon || !service) return fail(503, "service_unavailable");
  const authorization = req.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(authorization);
  if (!match) return fail(401, "login_required");
  try {
    const userClient = createClient(endpoint, anon, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userResult = await userClient.auth.getUser(match[1]);
    const user = userResult.data.user;
    if (userResult.error || !user?.id || !user.email_confirmed_at)
      return fail(401, "login_required");
    const admin = await userClient.rpc("strata_can_inspect_pending_fee_artifact");
    if (admin.error || admin.data !== true) return fail(403, "admin_required");
    const server = createClient(endpoint, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = new Date();
    const claims = await server.from(REVIEWS)
      .select("review_id,reviewer_user_id,expires_at")
      .eq("content_sha256", SHA).gt("expires_at", now.toISOString())
      .order("reviewed_at", { ascending: false }).limit(12);
    if (claims.error) return fail(503, "review_database_unavailable");
    const selected = selectLiveDistinctReviews((claims.data ?? []) as SourceReviewRow[], now.getTime());
    const ids = selected.ok ? selected.ids : null;
    let reviewerClaimsValid = false;
    if (ids) {
      const approved = await server.rpc("strata_two_operator_fee_reviews_valid", {
        first_review: ids[0], second_review: ids[1], expected_digest: SHA,
      });
      reviewerClaimsValid = !approved.error && approved.data === true;
    }
    const existing = await server.from(RELEASES)
      .select("release_id,recorded_at,expires_at,revoked_at")
      .eq("content_sha256", SHA).gt("expires_at", now.toISOString())
      .is("revoked_at", null).order("recorded_at", { ascending: false }).limit(1);
    if (existing.error) return fail(503, "release_database_unavailable");
    const live = existing.data?.[0] ?? null;
    if (req.method === "GET") {
      return result(200, { ok: true,
        reason: "operator_source_claims_reviewed_only",
        validDistinctClaims: reviewerClaimsValid ? 2 : 0,
        readyForSeparateReleaseSignature: reviewerClaimsValid && !live,
        candidateActive: Boolean(live),
        candidateExpiresAt: live?.expires_at ?? null,
        approvedOfficialPdf: false,
        ownerPolicyApproved: false, commissioningAuthorized: false,
        tradingAuthorized: false,
      });
    }
    if (live) return fail(409, "active_release_candidate_already_recorded");
    if (!reviewerClaimsValid) return fail(409, "two_current_independent_admin_claims_required");
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return fail(415, "json_required");
    const raw = await req.text();
    if (raw.length > 2500) return fail(413, "review_note_too_long");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return fail(400, "invalid_json"); }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail(422, "confirmation_required");
    const item = body as Record<string, unknown>;
    const note = typeof item.note === "string" ? item.note.trim() : "";
    if (item.confirmation !== CONFIRMATION || note.length < 80 || note.length > 1600)
      return fail(422, "explicit_review_and_note_required");
    // Fixed-path, service-only download. No arbitrary URLs or client-supplied PDF.
    const stored = await server.storage.from(BUCKET).download(PATH);
    if (stored.error || !stored.data || stored.data.size !== SIZE)
      return fail(409, "reviewed_storage_artifact_unavailable");
    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    if (bytes.length !== SIZE || new TextDecoder().decode(bytes.subarray(0,5)) !== "%PDF-" ||
        !new TextDecoder().decode(bytes.subarray(-2048)).includes("%%EOF") ||
        await sha256(bytes) !== SHA)
      return fail(409, "reviewed_storage_digest_mismatch");
    if (!selected.ok || !ids) return fail(409, "review_claims_expired");
    const expiresAt = boundedCandidateExpiry(Date.now(), selected.latestPossibleExpiryMs);
    if (!expiresAt) return fail(409, "review_claims_expired");
    // Release candidates are written to an isolated ledger. They do NOT
    // become provider captures or trading evidence.
    const written = await server.from(RELEASES).insert({
      content_sha256: SHA, reviewer_1: ids[0], reviewer_2: ids[1],
      released_by: user.id, reviewer_note: note, release_confirmation: CONFIRMATION,
      expires_at: expiresAt,
    }).select("release_id,recorded_at,expires_at").single();
    if (written.error || !written.data) return fail(409, "release_candidate_not_recorded");
    return result(201, { ok: true, reason: "operator_release_candidate_recorded_only",
      releaseId: written.data.release_id,
      recordedAt: written.data.recorded_at,
      expiresAt: written.data.expires_at,
      reviewerCount: 2,
      provenanceType: "operator_attested_commissioning_candidate",
      pdfByteIntegrityVerified: true,
      liveMarketFeeVerificationRequired: true,
      approvedOfficialPdf: false,
      ownerPolicyApproved: false,
      commissioningAuthorized: false,
      tradingAuthorized: false,
    });
  } catch {
    return fail(503, "review_service_unavailable");
  }
});
