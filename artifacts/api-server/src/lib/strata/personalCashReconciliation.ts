import { readSubaccountSpendableCash } from "./personalMarketAdapter";

export const RECORD_OWNED_CASH_CONFIRMATION = "RECORD_OWNED_SUBACCOUNT_CASH";

// Precision is not proof of opening capital. A zero observation is allowed,
// but a nonzero opening basis can only be established from a previously
// verified, owner-scoped initial funding receipt on a pristine stopped account.
// After establishment, a different balance requires a separate history-based
// recovery operation. No balance-only overwrite of commissioned cash or basis.
const RECORD_SQL = `
  -- owned-cash:reconcile
  UPDATE v13_production_account AS a
  SET cash_micros = CASE WHEN a.commissioned THEN a.cash_micros ELSE $3::bigint END,
      initial_cash_micros = CASE WHEN a.commissioned THEN a.initial_cash_micros ELSE $3::bigint END,
      cash_precision_verified = true,
      reconciled_at = $4::timestamptz
  WHERE a.id = $1
    AND a.owner_user_id = $2::uuid
    AND a.owner_user_id IS NOT NULL
    AND a.subaccount = 1
    AND a.exchange_index = 2
    AND a.reserved_micros = 0
    AND (a.reconciled_at IS NULL OR a.reconciled_at <= $4::timestamptz)
    AND (a.commissioned OR (
      a.execution_enabled IS FALSE AND a.kill_switch IS TRUE
      AND NOT EXISTS (SELECT 1 FROM public.v13_production_event e WHERE e.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM public.v13_production_position p WHERE p.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM public.v13_production_intent i WHERE i.account_id = a.id)
      AND (
        (a.initial_cash_micros = $3::bigint AND a.cash_micros = $3::bigint)
        OR (
          $3::bigint > 0 AND a.initial_cash_micros = 0
          AND (a.cash_micros = 0 OR a.cash_micros = $3::bigint)
          AND NOT EXISTS (
            SELECT 1 FROM private.kalshi_owner_topups u WHERE u.execution_account_id = a.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM private.strata_capital_credit_repair c WHERE c.execution_account_id = a.id
          )
          -- Refuse competing or ambiguous funding records, even if one matches.
          AND ((SELECT count(*) FROM private.kalshi_owner_pilot_transfers t
                WHERE t.execution_account_id = a.id)
             + (SELECT count(*) FROM private.kalshi_owner_historical_funding h
                WHERE h.execution_account_id = a.id)) = 1
          AND (
            EXISTS (
              SELECT 1 FROM private.kalshi_owner_pilot_transfers t
              WHERE t.execution_account_id = a.id AND t.owner_user_id = a.owner_user_id
                AND t.financial_account_id = a.kalshi_connection_id
                AND t.from_subaccount = 0 AND t.to_subaccount = a.subaccount
                AND t.exchange_index = a.exchange_index AND t.state = 'completed'
                AND t.verified_exchange_transfer_id IS NOT NULL
                AND t.verified_at IS NOT NULL AND t.completed_at IS NOT NULL
                AND t.verified_at <= $4::timestamptz AND t.completed_at <= $4::timestamptz
                AND t.bot_before_cents = 0 AND t.amount_cents > 0
                AND t.bot_after_cents = t.amount_cents
                AND t.amount_cents::bigint * 10000 = $3::bigint
            )
            OR EXISTS (
              SELECT 1 FROM private.kalshi_owner_historical_funding h
              WHERE h.execution_account_id = a.id AND h.owner_user_id = a.owner_user_id
                AND h.exchange_transfer_id IS NOT NULL
                AND h.transfer_created_at <= h.verified_at AND h.verified_at <= $4::timestamptz
                AND h.primary_after_cents = 0 AND h.bot_after_cents > 0
                AND h.bot_after_cents::numeric * 10000 = $3::bigint
            )
          )
        )
      )
    ))
    AND (NOT a.commissioned OR (
      a.cash_precision_verified IS TRUE
      AND a.cash_micros = $3::bigint
      AND a.execution_enabled IS FALSE AND a.kill_switch IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.v13_production_position p
        WHERE p.account_id = a.id AND p.quantity_hundredths > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.v13_production_intent i
        WHERE i.account_id = a.id
          AND (NOT i.terminal OR i.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR i.reserved_micros <> 0)
      )
    ))
  RETURNING a.id
`;

export async function persistOwnedCashReconciliation(
  db: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> },
  input: {
    ownerUserId: string;
    executionAccountId: string;
    confirmation: unknown;
    subaccount: number;
    exchangeIndex: number;
    observedAtMs: number;
    nowMs: number;
    maxAgeMs: number;
    subaccountBalance: unknown;
    primaryBalance: unknown;
  },
): Promise<{ ok: boolean; reason: string; cashCents: number | null; transferAttempted: false }> {
  if (input.confirmation !== RECORD_OWNED_CASH_CONFIRMATION) {
    return { ok: false, reason: "explicit_authorization_required", cashCents: null, transferAttempted: false };
  }
  const read = readSubaccountSpendableCash(input);
  if (!read.ok) return { ok: false, reason: read.reason, cashCents: null, transferAttempted: false };
  const recorded = await db.query(RECORD_SQL, [
    input.executionAccountId,
    input.ownerUserId,
    read.cashMicros,
    new Date(input.observedAtMs).toISOString(),
  ]);
  if ((recorded.rowCount ?? recorded.rows.length) !== 1) {
    return { ok: false, reason: "cash_not_reconciled", cashCents: null, transferAttempted: false };
  }
  return { ok: true, reason: "cash_reconciled", cashCents: read.cashCents, transferAttempted: false };
}
