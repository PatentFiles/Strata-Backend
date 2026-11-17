# Explicit historical fee authorization for an exact new release

This change adds an immutable release binding to the existing model and policy. It does not replace the original model, policy hash, risk limits, source digest, or revocation state. The July 7, 2026 source remains an owner-attested historical baseline: authenticity and publication currentness are **not verified**. Canonical source enrollment is not supported by this endpoint.

## Reviewed rollout order

1. Verify the account is killed, execution disabled, worker killed and disarmed, and no outstanding exposure. Do not ARM, START, or submit orders.
2. Apply `lib/db/owner-self-release/005_durable_fee_release_authorization.sql` through the separately approved schema deployment workflow. It is additive and is **not** automatically applied by the application deployment. Verify the table, immutable-history trigger, deferred evidence deadline trigger, forced RLS and privilege revocations. Apply before the new backend: exact-release consumer queries refer to this table. Do not insert or alter consent rows manually.
3. Deploy the reviewed backend revision, verify health and exact deployed SHA, then deploy the reviewed dashboard. Verify stopped state remains unchanged. Code deployment alone neither renews fee authorization nor proves readiness.
4. Read preview. If the original 15-minute cash reconciliation requirement is stale, use the supported authenticated Wallets cash reconciliation action (`POST /cash/reconcile`), then refresh preview. This does not transfer funds. Do not widen that freshness limit or edit account rows directly.
5. Obtain explicit owner consent for the exact displayed new SHA, original model/SHA, unchanged policy and digest, and the historical-source risk disclosure. Use the supported dashboard action once. Preserve its client journal. Only exact authoritative `RECORDED` readback proves the release binding. UNKNOWN prohibits retry; use supported readback or explicit pending cancellation. Cancellation locks the same row as completion, cannot change RECORDED, and fences a still-pending writer.
6. Complete fresh signed qualification, separate build-specific owner approval, and supported account activation with authoritative readback. These remain independent gates and may refuse. Preserve ambiguous activation attempts. Stop before ARM and START; the owner performs those steps.

## Regression coverage

`durable-fee-candidate.yml` invokes the offline test script (including `durableFeeReauthorization.test.ts`), authenticated route tests, historical full-chain tests, retained-109-history tests, and original durable native suites. Tests use isolated PostgreSQL and synthetic signed exchange transport, not production or order submission. Coverage includes exact consent/scope, original/new/unapproved SHA, immutable source/policy, global revocation and known-change latches, pending cancellation, commit/cancel serialization, deferred evidence expiry, lost commit acknowledgment, and retained history. Passing tests do not prove current issuer authenticity or live account readiness.
