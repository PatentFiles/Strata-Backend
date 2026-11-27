# Live entry readiness / proven price refusal release

## Incident and scope

The owner incident contained missing market targets during the first seconds of new BTC15M contracts, a price-protection refusal hidden by generic analytics, and a first-source claim preventing a later fresh crossing even though no order existed. A separate deployment replaced a running worker; the owner's approval remained bound to the previous release. A healthy API alone is not a healthy personal worker or successful execution.

## Qualified behavior

- Exact market identity, BTC timestamps, provider freshness and window checks run before target classification. Only explicitly absent/null target fields, within 15 seconds of market opening, and never after that market had a valid target, produce `market_target_initializing`. No quote, source claim, reservation or order occurs. Malformed, stale, later missing or persistently unavailable targets remain errors. No target is inferred and no old crossing is reconstructed.
- The fixed reason `live_money_best_ask_above_signal_ceiling` remains visible in History. Arbitrary exception text is not persisted.
- `STRATA_DIRECT_PRICE_RETRY_V1_SHA` must exactly match the deployed, qualified build to enable a single new crossing after a committed pre-intent price refusal. The original 50-cent ceiling is not raised to accommodate a 52-cent ask.
- Only the actual price-preflight refusal, before intent creation and reservation, may write the immutable no-order receipt inside its existing account transaction. The database independently checks owner, source, worker, credential, policy, freshness and financial state. Fee errors, transport errors and uncertain outcomes do not qualify.
- A second separately sealed observation must be fresh, belong to the same worker/release and market, and follow the refusal. A database generation CHECK and UNIQUE index bound this to two source observations even under a concurrent insertion race; there is still at most ONE financial ENTRY intent per account/market. Retired sources are rejected at the intent INSERT boundary. Old evidence, claims, decisions, receipts and financial history remain unchanged.
- Paper and browser roles have no access to the new private receipt table. Existing trusted API role receives SELECT/INSERT only. Functions use invoker rights.

## Release sequence

1. Qualify the exact candidate with protected CI, native PostgreSQL 16/17, actual worker price-refusal/fill/exit/restart tests, target-wait tests and existing accounting/authority regressions. Confirm source tree identity after merge.
2. Read production worker heartbeats, armed state, positions, reserves, pending monetary operations and release identifiers. Do not interrupt another account's active execution. Coordinate any independently initiated deployments; a stale lease is not proof of a running process.
3. Apply `supabase/migrations/20261127021634_direct_price_refusal_retry.sql` on a stopped deployment boundary. Confirm schema permissions, immutable guards, original intent uniqueness, unchanged financial totals, and no new production receipts. This is an explicit application migration, not a startup action. The Drizzle definitions remain the historical test/bootstrap baseline; do not use schema push against production.
4. Deploy the matched backend and align all applicable platform/recovery release pins to the qualified merged SHA in one reviewed Railway change. Set the retry SHA only after qualification. Leave paper trading authority, withdrawals, owner limits, credentials and account controls untouched.
5. Verify deployed SHA AND source digest, platform pins, health, logs and stopped account state. Existing frontend APIs are unchanged. The owner must deliberately ARM the new release and START after fresh cash, fee and protective-exit checks. Never fabricate approval records or start a worker from a release script.

## Rollback

Disable `STRATA_DIRECT_PRICE_RETRY_V1_SHA` using the matched binary: new replacement admission and replacement ENTRY dispatch fail closed; reconciliation and protective exits remain available. Do not delete receipts or restore the former source-claim unique constraint over retained second-generation observations. Do not roll back to an old binary that explicitly targets the removed source constraint. Financial intent uniqueness is unchanged. Never replay an uncertain order.

## Evidence boundaries

Native test venue responses and fills are synthetic and offline, even when exercising the production worker path. Successful tests prove specific code invariants, not a real fill, profitable strategy, owner consent or unattended reliability. Historical error totals are retained; use release/time filters to inspect post-release behavior.
