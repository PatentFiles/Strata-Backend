import { readSubaccountSpendableCash } from "./personalMarketAdapter";

export const RECORD_OWNED_CASH_CONFIRMATION = "RECORD_OWNED_SUBACCOUNT_CASH";

const RECORD_SQL = `
  -- owned-cash:reconcile
  UPDATE v13_production_account
  SET cash_micros = $3::bigint,
      initial_cash_micros = CASE WHEN cash_precision_verified THEN initial_cash_micros ELSE $3::bigint END,
      cash_precision_verified = true,
      reconciled_at = $4::timestamptz
  WHERE id = $1
    AND owner_user_id = $2::uuid
    AND owner_user_id IS NOT NULL
    AND subaccount = 1
    AND exchange_index = 2
    AND reserved_micros = 0
  RETURNING id
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
