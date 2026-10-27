import type { CredentialClient } from "./accountCredentialStore";

/**
 * Only an unused, uncommissioned, killed account may detach its deleted
 * restricted Kalshi key. No account, order, transfer, lease or financial
 * evidence is deleted. This read takes a row lock so commission/arm cannot
 * interleave with the subsequent credential mutation in the same transaction.
 *
 * Historical credential references remain intact; a replacement is only
 * eligible when the account has never carried live trading or funding.
 */
export const LOCK_FROZEN_RESTRICTED_RECOVERY_SQL = `
  -- account-credential:frozen-recovery
  SELECT a.id::text AS execution_account_id,
         a.key_fingerprint AS previous_fingerprint,
         (
           a.commissioned = false
           AND a.execution_enabled = false
           AND a.kill_switch = true
           AND a.blocked_reason = 'awaiting_account_commissioning'
           AND a.policy_id IS NULL
           AND a.commissioning_digest IS NULL
           AND a.minimum_exit_micros IS NULL
           AND a.cash_micros = 0
           AND a.reserved_micros = 0
           AND a.reconciled_at IS NULL
           AND a.subaccount = 1
           AND a.exchange_index = 2
           AND NOT EXISTS (
             SELECT 1 FROM public.v13_production_intent i
             WHERE i.account_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.v13_production_position p
             WHERE p.account_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM private.kalshi_account_worker_lease l
             WHERE l.execution_account_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM private.kalshi_owner_pilot_transfers t
             WHERE t.execution_account_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM private.kalshi_owner_shard_allocations t
             WHERE t.execution_account_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM private.kalshi_owner_topups t
             WHERE t.execution_account_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM private.kalshi_owner_historical_funding t
             WHERE t.execution_account_id = a.id
           )
         ) AS permitted
  FROM public.v13_production_account a
  WHERE a.owner_user_id = $1::uuid
    AND a.kalshi_connection_id = $2::uuid
  FOR UPDATE OF a
`;

export type FrozenRestrictedRecovery = {
  executionAccountId: string;
  previousFingerprint: string;
};

/** No bypass flag: eligibility is freshly computed under a production row lock. */
export async function lockFrozenRestrictedRecovery(
  client: CredentialClient,
  ownerUserId: string,
  financialAccountId: string,
): Promise<FrozenRestrictedRecovery | null> {
  const rows = await client.query(LOCK_FROZEN_RESTRICTED_RECOVERY_SQL, [
    ownerUserId,
    financialAccountId,
  ]);
  if (rows.rows.length !== 1) return null;
  const row = rows.rows[0] ?? {};
  if (row.permitted !== true ||
      typeof row.execution_account_id !== "string" ||
      typeof row.previous_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.previous_fingerprint)) {
    return null;
  }
  return {
    executionAccountId: row.execution_account_id,
    previousFingerprint: row.previous_fingerprint,
  };
}
