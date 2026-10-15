// Read-only inspection of the operator-uploaded Kalshi PDF in PRIVATE Storage.
// Never approves fees, returns PDF bytes, writes a capture row or changes trading.
// Only a verified signed-in Strata ADMIN may inspect the pending fixed-path object.
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "strata-official-fee-artifacts";
const PENDING_PATH = "operator-pending/kalshi-fee-schedule.pdf";
const EXPECTED_SHA256 = "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
const EXPECTED_SIZE = 281129;
const MAX_BYTES = 2_000_000;
const OFFICIAL_SOURCE = "https://kalshi.com/docs/kalshi-fee-schedule.pdf";
const jsonHeaders = { "content-type": "application/json", "cache-control": "private, no-store",
  "x-content-type-options": "nosniff" };

function failure(reason: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, reason }), { status, headers: jsonHeaders });
}

function validPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 100 || bytes.byteLength > MAX_BYTES) return false;
  const dec = new TextDecoder();
  return dec.decode(bytes.subarray(0, 5)) === "%PDF-" &&
    dec.decode(bytes.subarray(Math.max(0, bytes.length - 2048))).includes("%%EOF");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // WebCrypto requires an owned ArrayBuffer, not an ArrayBufferLike view.
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const hex = new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
  return Array.from(hex, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "GET") return failure("method_not_allowed", 405);
  const url = new URL(request.url);
  if (url.search || url.pathname.split("/").pop() !== "strata-fee-pending-audit") {
    return failure("unsupported_path", 404);
  }

  const endpoint = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!endpoint || !anonKey || !serviceRole) return failure("service_unavailable", 503);

  const authHeader = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(authHeader);
  if (!match) return failure("login_required", 401);

  try {
    // Caller checks are made with the CALLER'S token, not the service role.
    const owner = createClient(endpoint, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const identity = await owner.auth.getUser(match[1]);
    if (identity.error || !identity.data.user || !identity.data.user.email_confirmed_at) {
      return failure("login_required", 401);
    }
    // A locked-down SECURITY DEFINER function validates the verified user's
    // email against existing, server-owned private.role_assignments ADMIN roles.
    const permitted = await owner.rpc("strata_can_inspect_pending_fee_artifact");
    if (permitted.error || permitted.data !== true) {
      return failure("operator_access_denied", 403);
    }

    const server = createClient(endpoint, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // There is NO caller-controlled object path, URL, file or destination.
    const obj = await server.storage.from(BUCKET).download(PENDING_PATH);
    if (obj.error || !obj.data) return failure("pending_pdf_not_found", 404);
    if (obj.data.size > MAX_BYTES || obj.data.size < 100) {
      return failure("pending_pdf_invalid_size", 422);
    }
    const data = new Uint8Array(await obj.data.arrayBuffer());
    const digest = await sha256(data);
    const shapeOk = validPdf(data);
    const exactMatch = shapeOk &&
      data.length === EXPECTED_SIZE &&
      digest === EXPECTED_SHA256;

    // The digest is observed from the actual private Storage bytes.
    // The operator upload is *not* an authenticated Kalshi source receipt.
    return new Response(JSON.stringify({
      ok: exactMatch,
      reason: exactMatch ? "pending_upload_bytes_match_reference" : "pending_upload_bytes_mismatch",
      bucket: BUCKET,
      path: PENDING_PATH,
      actualSha256: digest,
      expectedSha256: EXPECTED_SHA256,
      byteLength: data.length,
      pdfEnvelopeValid: shapeOk,
      exactReferenceMatch: exactMatch,
      claimedOriginalUrl: OFFICIAL_SOURCE,
      canonicalOriginIndependentlyVerified: false,
      officialFeeApproved: false,
      approvedCaptureWritten: false,
      policyApproved: false,
      commissioningPerformed: false,
      tradingEnabled: false,
      inspectedAt: new Date().toISOString(),
    }), { status: exactMatch ? 200 : 422, headers: jsonHeaders });
  } catch {
    // Never leak JWTs, service secrets, role records, file bytes or server stack.
    return failure("pending_fee_audit_unavailable", 503);
  }
});
