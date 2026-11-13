/** A failed startup can relinquish only the exact lease it acquired. An owner
 * STOP may release any current lease, but asynchronous startup cleanup is not
 * such a command: STOP/re-ARM in another process may already have replaced it.
 */
export const FAILED_START_LEASE_RELEASE_SQL = `
  UPDATE private.kalshi_account_worker_lease
  SET state = 'released', released_at = $3::timestamptz,
      heartbeat_at = $3::timestamptz, arm_requested = false,
      fencing_token = fencing_token + 1
  WHERE execution_account_id = $1 AND owner_user_id = $2::uuid
    AND state = 'owned' AND account_kill = false
    AND holder_id = $4 AND fencing_token = $5::bigint
  RETURNING fencing_token::text AS fencing_token
`;

export function releaseFailedStartLease(
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  input: { executionAccountId: string; ownerUserId: string; holderId: string; fencingToken: number; now: string },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  if (!input.holderId || !Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)
    throw new Error("failed_start_lease_identity_unverified");
  return db.query(FAILED_START_LEASE_RELEASE_SQL, [input.executionAccountId, input.ownerUserId,
    input.now, input.holderId, input.fencingToken]);
}
