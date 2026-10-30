import { publicFeedRetryAfterMs } from "./publicFeedJson";

type Hold = { until: number; failures: number };
export type ReadRateLimitDetails = {
  provider: "kalshi";
  endpoint: string;
  responseReceived: boolean;
  retryAfterMs: number | null;
  remainingMs: number;
};
/** Local read-only suppression, not a substitute for the durable account quota.
 * No data caching, retry loop, credential storage, or write-path authority. */
export function createReadOnlyRateLimit(
  wallNow = Date.now,
  monotonicNow = () => performance.now(),
) {
  const holds = new Map<string, Hold>();
  let lastNow = 0;
  const now = () => {
    const n = monotonicNow();
    if (!Number.isFinite(n) || n < 0) throw Error("read_rate_limit_clock_invalid");
    lastNow = Math.max(lastNow, n);
    return lastNow;
  };
  return {
    begin(key: string, endpoint: string) {
      const before = now();
      const held = holds.get(key);
      if (held && held.until > before) {
        return { blocked: { provider: "kalshi", endpoint, responseReceived: false,
          retryAfterMs: null, remainingMs: Math.ceil(held.until - before) } as ReadRateLimitDetails };
      }
      return {
        blocked: null,
        limited(retryAfterHeader: string | null): ReadRateLimitDetails {
          const current = holds.get(key);
          const failures = Math.min(5, (current?.failures ?? 0) + 1);
          const retryAfterMs = publicFeedRetryAfterMs(retryAfterHeader, wallNow());
          const delay = retryAfterMs === null ? Math.min(300_000, 30_000 * 2 ** (failures - 1)) : Math.max(1000, retryAfterMs);
          const at = now();
          const until = Math.max(current?.until ?? 0, Math.min(Number.MAX_SAFE_INTEGER, at + delay));
          holds.set(key, { until, failures });
          return { provider: "kalshi", endpoint, responseReceived: true,
            retryAfterMs, remainingMs: Math.ceil(until - at) };
        },
        success() {
          // A response launched before a later 429 cannot erase that cooldown.
          if (holds.get(key) === held) holds.delete(key);
        },
      };
    },
  };
}

const DIAGNOSTIC_ENDPOINTS = new Set([
  "research_orderbook", "/trade-api/v2/portfolio/balance",
  "/trade-api/v2/portfolio/subaccounts/balances", "/trade-api/v2/portfolio/subaccounts/transfers",
  "/trade-api/v2/portfolio/intra_exchange_instance_transfers",
  "/trade-api/v2/portfolio/intra_exchange_instance_transfers/:id",
  "/trade-api/v2/portfolio/orders", "/trade-api/v2/portfolio/orders/:id",
  "/trade-api/v2/portfolio/positions", "/trade-api/v2/portfolio/fills",
  "/trade-api/v2/portfolio/settlements", "/trade-api/v2/historical/orders",
  "/trade-api/v2/historical/fills", "/trade-api/v2/api_keys",
  "/trade-api/v2/account/limits", "/trade-api/v2/series/KXBTC15M",
  "/trade-api/v2/markets", "/trade-api/v2/markets/:ticker",
  "/trade-api/v2/markets/:ticker/orderbook",
]);
/** Emit at the trusted transport boundary before callers collapse errors into
 * stable categories. Never serialize an Error, URL, query, headers or payload. */
export function emitReadRateLimitDiagnostic(details: ReadRateLimitDetails): void {
  const duration = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  try {
    console.warn(JSON.stringify({
      event: "strata_kalshi_read_rate_limit",
      provider: "kalshi",
      endpoint: DIAGNOSTIC_ENDPOINTS.has(details.endpoint) ? details.endpoint : "unknown",
      occurrence: details.responseReceived === true ? "provider_response" : "local_cooldown",
      httpStatus: details.responseReceived === true ? 429 : null,
      retryAfterMs: duration(details.retryAfterMs),
      remainingMs: duration(details.remainingMs),
    }));
  } catch { /* Optional logging cannot change the fail-closed read result. */ }
}
