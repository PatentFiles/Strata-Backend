import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

const MAX_QUEUED_MS = 15_000;

export const BALANCE_RESERVATION_SQL=`INSERT INTO private.strata_kalshi_balance_read_slots (budget_key,next_slot_at)
     VALUES ($1,clock_timestamp()+interval '1200 milliseconds')
     ON CONFLICT (budget_key) DO UPDATE SET
       next_slot_at=greatest(private.strata_kalshi_balance_read_slots.next_slot_at,clock_timestamp())+interval '1200 milliseconds'
     -- An already saturated queue must NOT reserve more slots on a rejected
     -- request. The predicate runs atomically under the conflicting-row lock.
     -- Preserve the conservative 1.2s spacing and fail closed with no result.
     WHERE private.strata_kalshi_balance_read_slots.next_slot_at
           <= clock_timestamp()+interval '13800 milliseconds'
     RETURNING extract(epoch FROM ((next_slot_at-interval '1200 milliseconds')-clock_timestamp()))*1000 AS wait_ms`;
export const BALANCE_IDENTITY_RESERVATION_SQL=`WITH identities AS MATERIALIZED (
 SELECT DISTINCT owner_user_id::text AS owner
 FROM private.kalshi_connection_credentials
 WHERE key_fingerprint=$1 AND revoked_at IS NULL AND verified_at IS NOT NULL
 AND verification_reason='credential_verified' LIMIT 2
), budget AS MATERIALIZED (
 SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
 'strata:kalshi:balance:' || CASE WHEN count(*)=1 AND max(owner) IS NOT NULL
 THEN 'member:'||max(owner) ELSE 'member:unmapped-conservative' END || ':v1','UTF8')),'hex') AS budget_key
 FROM identities
)
INSERT INTO private.strata_kalshi_balance_read_slots (budget_key,next_slot_at)
     SELECT budget_key,clock_timestamp()+interval '1200 milliseconds' FROM budget WHERE true
     ON CONFLICT (budget_key) DO UPDATE SET
       next_slot_at=greatest(private.strata_kalshi_balance_read_slots.next_slot_at,clock_timestamp())+interval '1200 milliseconds'
     -- An already saturated queue must NOT reserve more slots on a rejected
     -- request. The predicate runs atomically under the conflicting-row lock.
     -- Preserve the conservative 1.2s spacing and fail closed with no result.
     WHERE private.strata_kalshi_balance_read_slots.next_slot_at
           <= clock_timestamp()+interval '13800 milliseconds'
     RETURNING extract(epoch FROM ((next_slot_at-interval '1200 milliseconds')-clock_timestamp()))*1000 AS wait_ms`;

/**
 * Kalshi's /portfolio/balance has a separate one-request-per-second bucket
 * for Basic/Advanced, without burst. Until a reliable per-member identifier
 * is available for every caller, one conservative shared bucket serializes
 * balance requests across users, keys, and Railway processes.
 * The reservation is a database transaction, not a lock held across network I/O.
 *
 * Never log owner IDs or API key IDs. A missing database is fail-closed.
 */
export async function reserveKalshiBalanceReadSlot(
  keyId: string,
  ownerUserId?: string,
  query: typeof pool.query = pool.query.bind(pool),
  signerFingerprint?: string|null,
): Promise<void> {
  if (!keyId.trim()) throw new Error("kalshi_balance_credential_missing");
  if (ownerUserId && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(ownerUserId))
    throw new Error("kalshi_balance_owner_invalid");
  // Fuse only the original two-query identity-discovery path. Explicit-owner
  // and missing/invalid-fingerprint callers retain their original single query,
  // including no credential-table dependency. This is bucket routing, NOT
  // authorization: the authoritative member binding still runs after its wait.
  const response=!ownerUserId&&signerFingerprint&&/^[0-9a-f]{64}$/.test(signerFingerprint)
    ? await query(BALANCE_IDENTITY_RESERVATION_SQL,[signerFingerprint])
    : await query(BALANCE_RESERVATION_SQL,[createHash("sha256").update(
      `strata:kalshi:balance:${ownerUserId?`member:${ownerUserId}`:"member:unmapped-conservative"}:v1`).digest("hex")]);
  const wait=Number(response.rows[0]?.wait_ms);
  if (!Number.isFinite(wait) || wait < -2_000 || wait > MAX_QUEUED_MS)
    throw new Error("kalshi_balance_quota_busy");
  if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.ceil(wait)+15));
}

/** Diagnostic classification preserves 401/403/429 without secret material. */
export function safeBalanceFailureReason(error: unknown, base = "shard_cash"): string {
  if (error && typeof error === "object") {
    const x=error as {type?:unknown;status?:unknown;message?:unknown};
    if (x.type === "HTTP_ERROR" && [401,403,429,500,502,503,504].includes(Number(x.status)))
      return `${base}_http_${Number(x.status)}`;
    if (x.type === "INVALID_CREDENTIALS") return `${base}_signing_failed`;
    if (x.message === "kalshi_balance_quota_busy")return `${base}_quota_busy`;
  }
  return `${base}_read_unavailable`;
}
