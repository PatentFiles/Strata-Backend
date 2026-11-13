/**
 * Read-only per-owner top-up preflight for an ALREADY COMMISSIONED Kalshi bot.
 *
 * The one-time $25 pilot allocator requires globally disabled, uncommissioned
 * accounts and MUST NOT be recycled to top up live accounts. This status read
 * deliberately does NOT enforce that legacy lifecycle requirement. Instead it
 * checks a local STOP/DISARM/zero-exposure maintenance boundary.
 *
 * A passing status is NOT transfer authority: it has no provider balances,
 * no complete authenticated exchange order inventory, no immutable claim,
 * and no signed transfer receipt. Future new transfer legs must re-check
 * this state under transaction and enforce an account-level maintenance hold.
 */
export type OwnerFundingMaintenanceReadiness = {
  ok: boolean;
  reason: string;
  accountScopedMaintenanceEligible: boolean;
  executable: false;
  transferAttempted: false;
  variableTransferImplemented: false;
  requiresSignedKalshiCashRead: true;
  requiresAuthenticatedExchangeReconciliation: true;
  requiresOwnerTransferConsent: true;
  recordedBotCashCents: number | null;
  reconciledAt: string | null;
};

type Query = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export const OWNER_FUNDING_MAINTENANCE_READ_SQL = `
  -- owner-funding:readiness read-only; independent of global execution mode
  SELECT a.commissioned,a.execution_enabled,a.kill_switch,
    a.cash_precision_verified,a.blocked_reason,
    a.cash_micros::text,a.reserved_micros::text,a.reconciled_at,
    (SELECT count(*)::int FROM public.v13_production_position p
      WHERE p.account_id=a.id AND p.quantity_hundredths>0) AS open_positions,
    (SELECT count(*)::int FROM public.v13_production_intent i
      WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) AS unresolved_orders,
    (SELECT count(*)::int FROM private.kalshi_account_worker_lease l
      WHERE l.execution_account_id=a.id AND l.state='owned') AS owned_worker_leases
  FROM public.v13_production_account a
  WHERE a.owner_user_id=$1::uuid AND a.owner_user_id IS NOT NULL
    AND a.subaccount=1 AND a.exchange_index=2
`;

const unavailable = (reason: string): OwnerFundingMaintenanceReadiness => ({
  ok: false, reason,
  accountScopedMaintenanceEligible: false,
  executable: false, transferAttempted: false, variableTransferImplemented: false,
  requiresSignedKalshiCashRead: true,
  requiresAuthenticatedExchangeReconciliation: true,
  requiresOwnerTransferConsent: true,
  recordedBotCashCents: null, reconciledAt: null,
});
const zero = (value: unknown) => value === 0 || value === '0';
const validCount = (value: unknown) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export async function readOwnerFundingMaintenanceReadiness(
  db: Query, ownerId: string,
): Promise<OwnerFundingMaintenanceReadiness> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ownerId))
    return unavailable('owner_identity_invalid');
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await db.query(OWNER_FUNDING_MAINTENANCE_READ_SQL, [ownerId])).rows;
  } catch {
    return unavailable('owner_maintenance_database_unavailable');
  }
  if (rows.length !== 1) return unavailable('owner_execution_account_missing_or_ambiguous');
  const a = rows[0]!;
  if (a.commissioned !== true) return unavailable('account_not_commissioned');
  if (a.execution_enabled !== false || a.kill_switch !== true)
    return unavailable('stop_and_disarm_account_before_funding_review');
  if (a.cash_precision_verified !== true)
    return unavailable('execution_cash_precision_unverified');
  if (a.blocked_reason != null && a.blocked_reason !== 'awaiting_account_commissioning')
    return unavailable('risk_freeze_requires_resolution');
  if (!zero(a.reserved_micros)) return unavailable('funds_reserved_or_unknown');
  const positions=validCount(a.open_positions);
  const intents=validCount(a.unresolved_orders);
  const workers=validCount(a.owned_worker_leases);
  if (positions===null || intents===null || workers===null)
    return unavailable('maintenance_exposure_unproven');
  if (positions>0 || intents>0 || workers>0)
    return unavailable('maintenance_exposure_or_worker_lease_present');

  const rawCash=a.cash_micros;
  if (typeof rawCash !== 'string' || !/^\d+$/.test(rawCash))
    return unavailable('recorded_cash_unverified');
  const cashMicros=BigInt(rawCash);
  const cents=cashMicros/10_000n;
  if (cents>BigInt(Number.MAX_SAFE_INTEGER))
    return unavailable('recorded_cash_unverified');
  // Scope verified locally only; the vendor must still prove actual deposits,
  // source balance and receiving account balance BEFORE any transfer.
  return {
    ...unavailable('owner_maintenance_local_preconditions_passed_exchange_proof_required'),
    ok: true, accountScopedMaintenanceEligible: true,
    recordedBotCashCents: Number(cents),
    reconciledAt: typeof a.reconciled_at === 'string' ? a.reconciled_at : null,
  };
}
