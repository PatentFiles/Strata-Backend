import { readSubaccountSpendableCash } from "./personalMarketAdapter";

export const RECORD_OWNED_CASH_CONFIRMATION = "RECORD_OWNED_SUBACCOUNT_CASH";

// Pre-commissioning funding can establish cash. A commissioned ledger may only
// refresh a matching, stopped and locally flat balance; unexplained differences
// require full signed history reconciliation, never a balance overwrite.
// This remains a cash observation, not complete exchange flatness or release proof.
const RECORD_SQL = `
  -- owned-cash:reconcile
  UPDATE v13_production_account AS a
  SET cash_micros = CASE WHEN a.commissioned THEN a.cash_micros ELSE $3::bigint END,
      initial_cash_micros = CASE WHEN a.commissioned OR a.cash_precision_verified THEN a.initial_cash_micros ELSE $3::bigint END,
      cash_precision_verified = true,
      reconciled_at = $4::timestamptz
  WHERE a.id = $1
    AND a.owner_user_id = $2::uuid
    AND a.owner_user_id IS NOT NULL
    AND a.subaccount = 1
    AND a.exchange_index = 2
    AND a.reserved_micros = 0
    AND (a.reconciled_at IS NULL OR a.reconciled_at <= $4::timestamptz)
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
