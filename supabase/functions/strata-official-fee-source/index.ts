// Trusted alternate egress for ONE canonical Kalshi PDF. Never accepts a URL,
// uploaded bytes, account identifier, or fee formula from the caller.
// JWT required at the Supabase gateway. The only outbound provider request is
// https://kalshi.com/docs/kalshi-fee-schedule.pdf; storage remains private.
import { createClient } from "npm:@supabase/supabase-js@2";

const OFFICIAL_URL = "https://kalshi.com/docs/kalshi-fee-schedule.pdf";
const BUCKET = "strata-official-fee-artifacts";
const MAX_BYTES = 2_000_000;
const CACHE_MS = 55 * 60 * 1000; // Not reusable after its one-hour evidence lease.
const encoder = new TextEncoder();
const endpoint = Deno.env.get("SUPABASE_URL");
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function json(reason: string, status: number, retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json", "cache-control": "no-store",
  };
  if (status === 429 && Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds! >= 1 && retryAfterSeconds! <= 1800) {
    headers["retry-after"] = String(retryAfterSeconds);
  }
  return new Response(JSON.stringify({ ok: false, reason }), { status, headers });
}
function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function fingerprint(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
function validPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 100 || bytes.byteLength > MAX_BYTES) return false;
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return false;
  return new TextDecoder().decode(bytes.slice(-2048)).includes("%%EOF");
}
async function boundedPdf(response: Response): Promise<Uint8Array | null> {
  const size = response.headers.get("content-length");
  if (size && (!Number.isSafeInteger(Number(size)) || Number(size) > MAX_BYTES)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}
function pdfResponse(bytes: Uint8Array, digest: string, capturedAt: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-strata-canonical-source": OFFICIAL_URL,
      "x-strata-source-sha256": digest,
      "x-strata-captured-at": capturedAt,
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "GET") return json("method_not_allowed", 405);
  // This is not an arbitrary URL proxy. Reject every query/path variant.
  if (new URL(req.url).search) return json("unsupported_query", 400);
  if (!endpoint || !serviceRole) return json("bridge_configuration_missing", 503);
  try {
    const client = createClient(endpoint, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = Date.now();
    const recent = await client.from("strata_official_fee_captures")
      .select("content_sha256,storage_path,captured_at,expires_at,byte_length")
      .eq("canonical_url", OFFICIAL_URL).gt("expires_at", new Date(now).toISOString())
      .order("captured_at", { ascending: false }).limit(1).maybeSingle();

    if (recent.error) return json("capture_index_unavailable", 503);
    if (recent.data) {
      const saved = recent.data;
      const captureTime = Date.parse(saved.captured_at);
      const expiry = Date.parse(saved.expires_at);
      // DB row + file must both be authentic and inside the configured lease.
      if (Number.isFinite(captureTime) && Number.isFinite(expiry) &&
          captureTime <= now + 10000 && now < expiry &&
          expiry - captureTime <= 3600000 && now - captureTime < 3600000) {
        const fetched = await client.storage.from(BUCKET).download(saved.storage_path);
        if (!fetched.error && fetched.data) {
          const bytes = new Uint8Array(await fetched.data.arrayBuffer());
          if (validPdf(bytes) && bytes.length === saved.byte_length) {
            const digest = await fingerprint(bytes);
            if (digest === saved.content_sha256) {
              return pdfResponse(bytes, digest, saved.captured_at);
            }
          }
        }
        // Missing or altered immutable object is a hard failure, not a reason
        // to accept a different file or silently claim a successful refresh.
        return json("captured_fee_artifact_integrity_failure", 503);
      }
    }

    // Atomic project-wide cooldown; service role only. Anonymous clients
    // cannot invoke this RPC and cannot upload/read objects in the bucket.
    const claim = await client.rpc("strata_claim_official_fee_capture");
    if (claim.error) return json("capture_throttle_unavailable", 503);
    if (claim.data !== true) {
      // Read the shared lease instead of returning an arbitrary short wait.
      // No network request to Kalshi is made when another worker owns it.
      const throttle = await client.from("strata_official_fee_capture_throttle")
        .select("next_allowed_at").eq("id", true).maybeSingle();
      if (throttle.error || !throttle.data) return json("capture_throttle_unavailable", 503);
      const next = Date.parse(throttle.data.next_allowed_at);
      const seconds = Number.isFinite(next)
        ? Math.max(1, Math.min(1800, Math.ceil((next - Date.now()) / 1000)))
        : 1800;
      return json("official_source_refresh_rate_limited_or_unavailable", 429, seconds);
    }
    let response: Response;
    try {
      response = await fetch(OFFICIAL_URL, {
        method: "GET", redirect: "error", headers: {
          Accept: "application/pdf", "Cache-Control": "no-cache",
        }, signal: AbortSignal.timeout(12000),
      });
    } catch { return json("canonical_source_network_unavailable", 503); }
    if (!response.ok) {
      // The atomic capture lease is 30m even when the provider rejects the
      // request. Return that window to the authenticated caller; never spin.
      if (response.status === 429) return json("canonical_source_http_429", 429, 1800);
      return json(`canonical_source_http_${response.status}`, 502);
    }
    if (response.url !== OFFICIAL_URL ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
          !== "application/pdf") return json("canonical_source_identity_invalid", 502);
    const bytes = await boundedPdf(response);
    if (!bytes || !validPdf(bytes)) return json("canonical_pdf_invalid", 502);
    const digest = await fingerprint(bytes);
    const path = `official/${digest}.pdf`;

    // Creating a bucket is performed through the Storage API, never storage SQL.
    const bucket = await client.storage.getBucket(BUCKET);
    if (bucket.error) {
      const created = await client.storage.createBucket(BUCKET, {
        public: false, fileSizeLimit: "2MB", allowedMimeTypes: ["application/pdf"],
      });
      if (created.error) return json("private_bucket_unavailable", 503);
    }
    const upload = await client.storage.from(BUCKET).upload(path, bytes, {
      upsert: false, contentType: "application/pdf", cacheControl: "0",
    });
    if (upload.error) {
      // An existing content-addressed object must match before reusing it.
      const existing = await client.storage.from(BUCKET).download(path);
      if (existing.error || !existing.data ||
          await fingerprint(new Uint8Array(await existing.data.arrayBuffer())) !== digest)
        return json("immutable_fee_storage_error", 503);
    }
    const capturedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CACHE_MS).toISOString();
    const entry = await client.from("strata_official_fee_captures").insert({
      canonical_url: OFFICIAL_URL,
      storage_path: path,
      content_sha256: digest,
      byte_length: bytes.length,
      captured_at: capturedAt,
      expires_at: expiresAt,
    });
    if (entry.error) return json("fee_evidence_ledger_write_failed", 503);
    return pdfResponse(bytes, digest, capturedAt);
  } catch {
    // Never surface service-role tokens, Postgres details, or upstream headers.
    return json("canonical_fee_source_unavailable", 503);
  }
});
