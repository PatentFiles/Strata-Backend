import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

const MAX_QUEUED_MS = 15_000;

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
  // All verified credential roles belonging to a single member must
  // consume the SAME bucket. Separate users must not block one another's
  // live execution reads. Unknown credentials use one conservative fallback.
  let effectiveOwner=ownerUserId;
  if(!effectiveOwner && signerFingerprint && /^[0-9a-f]{64}$/.test(signerFingerprint)){
    const identities=await query(
      `SELECT DISTINCT owner_user_id::text AS owner
         FROM private.kalshi_connection_credentials
        WHERE key_fingerprint=$1 AND revoked_at IS NULL
          AND verified_at IS NOT NULL AND verification_reason='credential_verified'
        LIMIT 2`,[signerFingerprint]);
    if(identities.rows.length===1 && typeof identities.rows[0]?.owner==="string")
      effectiveOwner=identities.rows[0].owner;
  }
  const scope=effectiveOwner ? `member:${effectiveOwner}` : "member:unmapped-conservative";
  const digest=createHash("sha256").update(`strata:kalshi:balance:${scope}:v1`).digest("hex");
  const response=await query(
    `INSERT INTO private.strata_kalshi_balance_read_slots (budget_key,next_slot_at)
     VALUES ($1,clock_timestamp()+interval '1200 milliseconds')
     ON CONFLICT (budget_key) DO UPDATE SET
       next_slot_at=greatest(private.strata_kalshi_balance_read_slots.next_slot_at,clock_timestamp())+interval '1200 milliseconds'
     -- An already saturated queue must NOT reserve more slots on a rejected
     -- request. The predicate runs atomically under the conflicting-row lock.
     -- Preserve the conservative 1.2s spacing and fail closed with no result.
     WHERE private.strata_kalshi_balance_read_slots.next_slot_at
           <= clock_timestamp()+interval '13800 milliseconds'
     RETURNING extract(epoch FROM ((next_slot_at-interval '1200 milliseconds')-clock_timestamp()))*1000 AS wait_ms`,
    [digest],
  );
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
