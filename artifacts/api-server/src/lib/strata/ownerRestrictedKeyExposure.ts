/**
 * Signed, read-only Kalshi exposure gate for owner-specific restricted key
 * recovery. Paths and query strings MUST stay separate: getScopedKalshiJson
 * appends the query verbatim to the path; without '?' the request targets
 * /orderssubaccount=... and returns a provider HTTP error.
 *
 * Kalshi GET /portfolio/orders: status=resting and subaccount=1.
 * Kalshi GET /portfolio/positions: default settlement_status=unsettled,
 * subaccount=1. Both inventories must prove empty and unpaginated.
 *
 * This is NOT authorization to generate a key or turn on trading. All other
 * account/position/ledger and signed metadata guards remain in the caller.
 */
export const RECOVERY_RESTING_ORDERS_PATH = "/trade-api/v2/portfolio/orders";
export const RECOVERY_RESTING_ORDERS_QUERY = "?subaccount=1&status=resting&limit=200";
export const RECOVERY_UNSETTLED_POSITIONS_PATH = "/trade-api/v2/portfolio/positions";
export const RECOVERY_UNSETTLED_POSITIONS_QUERY = "?subaccount=1&limit=200";

type SignedKalshiGet = (
  creds: { keyId: string; privateKey: string },
  path: string,
  query?: string,
) => Promise<unknown>;

export type RestrictedKeyExposureResult = {
  ok: boolean;
  reason: string;
};

function records(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function inspectSignedRestrictedRecoveryExposure(
  get: SignedKalshiGet,
  verificationKey: { keyId: string; privateKey: string },
): Promise<RestrictedKeyExposureResult> {
  // Separate try/catch per endpoint so permission, rate-limit, and transport
  // failures can be distinguished without exposing HTTP errors or secrets.
  let orders: unknown;
  try {
    orders = await get(verificationKey, RECOVERY_RESTING_ORDERS_PATH, RECOVERY_RESTING_ORDERS_QUERY);
  } catch {
    return { ok: false, reason: "recovery_signed_orders_unavailable" };
  }

  const o = records(orders);
  if (!o || !Array.isArray(o.orders) || o.orders.length !== 0 ||
      (o.cursor !== undefined && (typeof o.cursor !== "string" || o.cursor.length > 0))) {
    return { ok: false, reason: "recovery_exchange_exposure_or_pagination_unresolved" };
  }

  let positions: unknown;
  try {
    positions = await get(verificationKey, RECOVERY_UNSETTLED_POSITIONS_PATH, RECOVERY_UNSETTLED_POSITIONS_QUERY);
  } catch {
    return { ok: false, reason: "recovery_signed_positions_unavailable" };
  }

  const p = records(positions);
  if (!p || !Array.isArray(p.market_positions) || !Array.isArray(p.event_positions) ||
      p.market_positions.length !== 0 || p.event_positions.length !== 0 ||
      (p.cursor !== undefined && (typeof p.cursor !== "string" || p.cursor.length > 0))) {
    return { ok: false, reason: "recovery_exchange_exposure_or_pagination_unresolved" };
  }
  return { ok: true, reason: "recovery_exchange_exposure_clear" };
}
