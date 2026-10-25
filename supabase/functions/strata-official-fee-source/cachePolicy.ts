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
/** V5 is a *document observation* only: no grant and no restamped capture. */
export const V5_REVIEWED_DOCUMENT_QUERY = "?document_policy=v5-reviewed-55m";
export const V5_DOCUMENT_POLICY_VERSION = "strata_fee_document_v5_observation_only" as const;

export type BridgeMode = "general" | "v4_strict" | "v5_document";

export function parseBridgeMode(search: string): BridgeMode | null {
  if (search === "") return "general";
  if (search === STRICT_V4_QUERY) return "v4_strict";
  if (search === V5_REVIEWED_DOCUMENT_QUERY) return "v5_document";
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
    : GENERAL_FEE_CAPTURE_MAX_AGE_MS;
  return age < maximum;
}
