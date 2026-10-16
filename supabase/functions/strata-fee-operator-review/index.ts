// Non-authoritative, admin-signed observations of the operator's private Kalshi
// PDF. This function MUST NEVER approve owner policies, publish an official
// capture, change execution authority, or claim browser attestations are proof
// that the canonical Kalshi server served the identical bytes.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SOURCE_URL, validReview } from "./reviewValidation.ts";

const BUCKET = "strata-official-fee-artifacts";
const OBJECT_PATH = "operator-pending/kalshi-fee-schedule.pdf";

const EXPECTED_SHA = "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
const EXPECTED_BYTES = 281_129;
const TABLE = "strata_fee_operator_source_reviews";
// Browser access is limited to the configured Strata frontend, not to arbitrary origins.
// JWT verification and the private ADMIN role check remain independently mandatory.
const ALLOWED_ORIGIN = Deno.env.get("STRATA_WEB_ORIGIN")?.trim() ||
  "https://private-multi-asset-eviv.bolt.host";
const CORS = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-version",
  "access-control-allow-methods": "POST, OPTIONS",
  "vary": "Origin",
};
const HEADERS = {
  "content-type": "application/json",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  ...CORS,
};

function error(reason: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, reason }), { status, headers: HEADERS });
}

async function digest(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
  return Array.from(hashed, x => x.toString(16).padStart(2, "0")).join("");
}

function validPdfEnvelope(bytes: Uint8Array): boolean {
  const decode = new TextDecoder();
  return bytes.length === EXPECTED_BYTES && decode.decode(bytes.subarray(0, 5)) === "%PDF-" &&
    decode.decode(bytes.subarray(Math.max(0, bytes.length - 2048))).includes("%%EOF");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    if (request.headers.get("origin") !== ALLOWED_ORIGIN) {
      return new Response(null, { status: 403, headers: { vary: "Origin" } });
    }
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") return error("method_not_allowed", 405);
  const url = new URL(request.url);
  if (url.search || url.pathname.split("/").pop() !== "strata-fee-operator-review") {
    return error("unsupported_path", 404);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return error("json_required", 415);
  }
  const rawLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(rawLength) || rawLength > 4096) return error("request_too_large", 413);

  const endpoint = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!endpoint || !anon || !service) return error("service_unavailable", 503);

  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(auth);
  if (!match) return error("login_required", 401);

  try {
    const now = Date.now();
    const raw = await request.text();
    if (raw.length > 4096) return error("request_too_large", 413);
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return error("invalid_json", 400); }
    if (!validReview(payload, now)) return error("review_claim_invalid_or_stale", 422);

    const caller = createClient(endpoint, anon, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const identity = await caller.auth.getUser(match[1]);
    const reviewer = identity.data.user;
    if (identity.error || !reviewer?.id || !reviewer.email ||
        !reviewer.email_confirmed_at) return error("login_required", 401);
    // Existing locked-down boolean RPC is resolved against the caller's JWT.
    const role = await caller.rpc("strata_can_inspect_pending_fee_artifact");
    if (role.error || role.data !== true) return error("operator_access_denied", 403);

    const server = createClient(endpoint, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stored = await server.storage.from(BUCKET).download(OBJECT_PATH);
    if (stored.error || !stored.data) return error("pending_pdf_unavailable", 404);
    if (stored.data.size !== EXPECTED_BYTES) return error("uploaded_pdf_invalid", 422);
    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    if (!validPdfEnvelope(bytes) || await digest(bytes) !== EXPECTED_SHA) {
      return error("uploaded_pdf_mismatch", 422);
    }

    // Reject repeat claims from the same reviewer in an active review window.
    // The database is append-only: expired historical reviews remain auditable.
    const existing = await server.from(TABLE).select("review_id")
      .eq("content_sha256", EXPECTED_SHA)
      .eq("reviewer_user_id", reviewer.id)
      .gt("expires_at", new Date().toISOString())
      .limit(1);
    if (existing.error) return error("source_review_database_unavailable", 503);
    if ((existing.data ?? []).length > 0) return error("reviewer_already_attested_in_current_window", 409);

    // An owner-supplied PDF hash is not proof of Kalshi provenance.
    // Record ONLY this reviewer's signed human-source claim.
    const result = await server.from(TABLE).insert({
      content_sha256: EXPECTED_SHA,
      storage_bucket: BUCKET,
      storage_object_path: OBJECT_PATH,
      canonical_claim_url: SOURCE_URL,
      effective_date: "2026-07-07",
      reviewer_user_id: reviewer.id,
      reviewer_email: reviewer.email.toLowerCase(),
      source_observed_at: new Date(Date.parse(payload.observedAt)).toISOString(),
      source_review_note: payload.reviewNote.trim(),
      review_kind: "human_canonical_source_claim",
    }).select("review_id,reviewed_at,expires_at").single();
    if (result.error || !result.data) {
      return error("source_review_not_recorded_or_already_exists", 409);
    }

    const reviews = await server.from(TABLE)
      .select("reviewer_user_id")
      .eq("content_sha256", EXPECTED_SHA)
      .gt("expires_at", new Date().toISOString());
    const count = reviews.error ? 0 :
      new Set((reviews.data ?? []).map(r => r.reviewer_user_id)).size;
    return new Response(JSON.stringify({
      ok: true,
      reason: "signed_operator_claim_recorded_only",
      reviewId: result.data.review_id,
      reviewedAt: result.data.reviewed_at,
      expiresAt: result.data.expires_at,
      independentReviewClaims: count,
      requiresSeparateApproval: true,
      currentCanonicalByteIdentityVerified: false,
      approvedOfficialFeeCapture: false,
      ownerPolicyApproved: false,
      accountCommissioned: false,
      tradingAuthorityChanged: false,
    }), { status: 201, headers: HEADERS });
  } catch {
    return error("review_service_unavailable", 503);
  }
});
