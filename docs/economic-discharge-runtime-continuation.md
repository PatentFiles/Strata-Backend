# Canonical discharge: execution continuation

This extends the existing economic-exit discharge model. It introduces no second
receipt table, no permission model, and no change to strategy, stake or loss limits.
The historical exit remains UNKNOWN/DISPATCHED, with no fabricated venue order.

## Closed release gaps

- The executor's admission and final-order gates formerly still rejected the
  discharged historical exit. Only its exact immutable identity can now be
  excluded after positive database recognition AND a complete authenticated
  signed snapshot no more than five seconds old with matching exact-account
  cash, settlement, credentials and zero retired-market exposure.
- A new/different UNKNOWN remains blocking. Cancellation never borrows the
  discharge exception, and the historic exit cannot be a dispatch target.
- The final snapshot is rechecked against the same immutable receipt under
  account locks. The last synchronous entry wire check retains original source
  clocks and adds the five-second economic-evidence deadline.
- The independent protective sender requires an opaque process-local carry of
  the committed signed snapshot for the exact new order, then rechecks the
  canonical receipt and monotonic/wall-clock lifetime before its only POST.
- Existing reviewed-API market-fee checks now borrow the actual final ledger
  transaction, preventing a second connection from waiting on its own account
  lock. No fee consent or source requirement is removed.

## Tests and rollout

The full disposable worker cycle uses actual production code and PostgreSQL with
synthetic venue HTTP/RSA material, including entry, reducing exit, STOP, restart,
cash conservation, one original settlement, one discharge, and immutable UNKNOWN.
These are not live trading results. Native tests run only through the existing
loopback disposable-PostgreSQL runner. Pure tests reject stale, incomplete,
wrong-owner/key/shard/cash/settlement evidence, later fills/orders, forged or
cross-scope protective carries and historical replay.

Rollout still requires all current exact-head CI, published source verification,
current owner readiness and the existing supported owner recovery/authorization.
Do not enable live orders or raise limits as part of deploying this code.
The default-off STRATA_ECONOMIC_EXIT_FINALITY_ENABLED flag and exact-build writer
binding remain unchanged. The additive discharge schema was installed separately;
its installation neither books money nor releases a reserve or worker.

Rollback: stop/disarm through the supported owner control before changing a live
release. Disable the recognition/writer rollout flags to return to fail-closed
UNKNOWN gates. Pin the last verified compatible release only after checking its
financial read model. Keep immutable receipts and all canonical ledger events;
never delete or reverse them to make an old build appear ready.

## Concurrent implementation reconciliation

Brady PR391 is included as a merge parent. Its real STOP/KILL call-order
regression and centralized ledger final-settlement proof are retained. The
duplicated full-cycle fixture and SQL-only admission helper are superseded by
one full-worker test and the stricter fresh-signed-evidence admission guard.
Both implementations use the sole #387 canonical receipt. No active branch
was force-pushed, no strategy changed, and no second disposition schema added.
