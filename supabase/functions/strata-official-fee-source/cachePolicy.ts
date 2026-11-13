/**
 * Strict V4 fee publication fetches do not reuse the standard 55-minute
 * document cache. This is a read policy, not a permission to bypass the
 * existing atomic, project-wide upstream capture rate limit.
 *
 * Invariant: no synthetic captured_at value and no stale bytes can be
 * presented as fresh evidence for dynamic V4 consent.
 */
export const V4_FEE_CAPTURE_MAX_AGE_MS = 60_000;
export const GENERAL_FEE_CAPTURE_MAX_AGE_MS = 55 * 60_000;
export const STRICT_V4_QUERY = "?max_age_seconds=60";
// Versioned source lease: authentic issuer bytes are reusable only while their
// ORIGINAL capture timestamp and immutable SHA are within the documented lease.
// This is NOT a fresh download. Every trading action still separately requires
// a fresh Kalshi market/event/series fee API observation and owner consent.
export const V4_VERSIONED_LEASE_MS = 55 * 60_000;
export const VERSIONED_V4_QUERY = "?max_age_seconds=3300";

export type BridgeMode = "general" | "v4_strict" | "v4_versioned";

export function parseBridgeMode(search: string): BridgeMode | null {
  if (search === "") return "general";
  if (search === STRICT_V4_QUERY) return "v4_strict";
  if (search === VERSIONED_V4_QUERY) return "v4_versioned";
  return null;
}

export function isUsableFeeCapture(
  capturedAt: unknown,
  expiresAt: unknown,
  nowMs: number,
  mode: BridgeMode,
): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      typeof capturedAt !== "string" || typeof expiresAt !== "string") return false;
  const captured = Date.parse(capturedAt);
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(captured) || !Number.isFinite(expiry) ||
      captured > nowMs + 10_000 || nowMs >= expiry ||
      expiry <= captured || expiry - captured > 60 * 60_000) return false;
  // Negative age (up to 10s clock skew) cannot certify a V4 fresh
  // capture from the future; the operator should correct its clock.
  const age = nowMs - captured;
  if (age < 0) return false;
  const maximum = mode === "v4_strict"
    ? V4_FEE_CAPTURE_MAX_AGE_MS
    : mode === "v4_versioned"
      ? V4_VERSIONED_LEASE_MS
      : GENERAL_FEE_CAPTURE_MAX_AGE_MS;
  return age < maximum;
}

/** Capture provenance describes the response transport, not fee authority.
 * Cached bytes remain the original issuer capture; no clock is re-stamped.
 * Only the Edge server (never its caller) chooses the provenance.
 */
export type FeeResponseOrigin = "edge_issuer_get" | "immutable_verified_storage";
export const V4_VERSIONED_FEE_LEASE_POLICY = "issuer_pdf_55m_signed_api_recheck_v2";
export function feeProvenanceHeaders(
  mode:BridgeMode,origin:FeeResponseOrigin,
):Record<string,string> {
  return {
    "x-strata-fee-response-origin": origin,
    ...(mode==="v4_versioned" ? {
      "x-strata-fee-document-lease-policy":V4_VERSIONED_FEE_LEASE_POLICY,
    } : {}),
  };
}
