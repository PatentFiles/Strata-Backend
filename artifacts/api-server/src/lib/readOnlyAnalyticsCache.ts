/**
 * Per-process cache for expensive, read-only analytical summaries.
 *
 * A request burst must not launch dozens of concurrent full-history scans
 * against the same database. Never use this cache for worker heartbeats,
 * financial reconciliation, quote freshness, risk gates, or exchange orders.
 *
 * Rejected loads are never cached; after expiry a failed refresh fails closed
 * rather than disguising stale data as a current successful read.
 */
export function createSingleFlightAnalyticsCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  clock: () => number = Date.now,
): () => Promise<T> {
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
    throw new RangeError("Analytics cache TTL must be between 1ms and 5 minutes");
  }
  let cached: {value: T; expiresAt: number} | null = null;
  let pending: Promise<T> | null = null;
  return () => {
    const now = clock();
    if (cached && now < cached.expiresAt) return Promise.resolve(cached.value);
    if (pending) return pending;
    const inFlight = Promise.resolve().then(load).then(value => {
      cached = {value, expiresAt: clock() + ttlMs};
      return value;
    });
    pending = inFlight;
    void inFlight.then(
      () => { if (pending === inFlight) pending = null; },
      () => { if (pending === inFlight) pending = null; },
    );
    return inFlight;
  };
}
