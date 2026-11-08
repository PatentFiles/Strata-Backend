/**
 * Coalesce one read-only analytical batch per key until every query settles.
 * The public result still rejects on the first failure, with that same reason.
 * Retries during drainage reuse that rejected result instead of starting scans.
 * This stores no completed values; the caller's cache owns any successful TTL.
 *
 * Readers must return the underlying query thenable, not a client-side timeout
 * or cancellation race. Abandoning a caller does not cancel shared work. A key
 * remains occupied if a query never settles. Query settlement is not proof of
 * server cancellation when the driver can settle before server work finishes.
 * Never use this for trading authority, leases, freshness or financial state.
 */
export function createSingleFlightAnalyticsBatch<T extends readonly unknown[]>(
  readers: { readonly [I in keyof T]: (key: string | undefined) => PromiseLike<T[I]> },
): (key?: string) => Promise<T> {
  const pending = new Map<string | undefined, Promise<T>>();
  return key => {
    const current = pending.get(key);
    if (current) return current;

    // Each thunk and lazy query thenable is invoked exactly once. Normalize
    // before observing twice: observing a raw Drizzle query twice executes it twice.
    const work = readers.map(read => Promise.resolve().then(() => read(key)));
    // Array.map preserves tuple order, which TypeScript's signature cannot express.
    const result = Promise.all(work) as unknown as Promise<T>;
    pending.set(key, result);
    void Promise.allSettled(work).then(() => {
      if (pending.get(key) === result) pending.delete(key);
    });
    return result;
  };
}
