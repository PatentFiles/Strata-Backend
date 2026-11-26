# Bounded economic recovery latency correction

This is an incremental correction to the existing canonical discharge path and PR #394 diagnostics. It adds no financial schema, owner permission, automatic retry, live sizing change, worker-start authority or second settlement system.

## Reproduced failure

The current real Wallets/native PostgreSQL acceptance, with 90 ms of added latency on each database reply for economic-discharge requests only, reproduced a successful preview followed by `economic_discharge_evidence_expired` on apply. The original apply used 60 database round trips and took approximately 8.46 seconds. Its transaction rolled back; no discharge receipt or second cash credit was recorded. Synthetic signed venue responses, two independent owners, full application migrations and the restricted runtime role were used. This reproduces a credible production failure mechanism; it is not a claim that production's formerly unlogged refusal was independently identified.

## Narrow changes

History and maintenance reads are batched without changing the row limits, owner/account predicates, exact bigint values, timestamps, xmin revisions or history digests. Materialized dependencies retain the original table-lock order. Native tests compare the original SELECT projections byte-for-byte at the canonical hash boundary and verify all row locks, cross-tenant isolation and denial of insufficient privileges.

The final capture reuses only the account row already read and FOR UPDATE locked by the current writer. It still locks and rereads the related lease, connection, credentials and history and obtains a fresh final identity pin. That pin, the preview digest and all current financial revisions must match. A preview account object is not accepted as a substitute for the writer's locked row.

Short transaction setup statements share a round trip. The original lock and statement timeouts are unchanged. The original five-second evidence clock, signed balance/history bracket, transfer cut, cancellation fence, cash conservation checks, immutable receipt and ambiguous-COMMIT readback remain intact.

The stopped-owner PIN query avoids evaluating the expensive canonical discharge function only when no matching receipt exists. In that case the old exit remains unresolved. Existing receipts still require the complete canonical function. Qualified outer aliases are mandatory for this optimization; all ordinary call sites retain the original SQL. An isolated EXPLAIN comparison measured approximately 101 ms versus 0.015 ms for the absent-receipt case. Timing is environment-specific, not a production service-level guarantee.

## Qualification and release

Run economic settlement and discharge offline/native tests, native batch equivalence and locking tests on PostgreSQL 16 and 17, the real worker entry/protective-exit/STOP/restart cycle, full security/regression checks, and the private frontend full-schema browser lifecycle with latency injection. Preserve exact source commits and evidence. The private frontend fixture must never be copied into public CI.

The latency test does not modify the published UI. Its test-only instrumentation is retained separately from the published application release. Failure remains closed when genuine evidence becomes stale; no amount of qualification grants an owner approval or permission to replay a pending recovery request.

Deploy only after the protected exact-head checks pass. Retain the existing additive migration and receipts, verify serving source identity and release-bound rollout pins, and verify account readiness without issuing financial mutations. A successful signed preview is not a completed discharge. An owner must resolve their saved pending request through the existing exact readback/cancellation flow before any new deliberate recovery attempt. ARM and START remain separate deliberate owner actions.

## Rollback

Roll back this optimization to the preceding qualified canonical-discharge release if necessary. Do not delete receipts, recreate old reserves, rewrite UNKNOWN transport history, credit a payout again, clear an unrelated hold, or replay an ambiguous request. Restore the corresponding release pins and independently reverify readiness; a software rollback is never permission to start trading.
