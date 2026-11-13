# Lifecycle strike feasibility prototype

**Offline, unwired, and not production-ready.** This directory imports no Strata runtime code, starts no socket, reads no credential, stores no database data, and can neither authorize nor submit an order. Production was not modified.

## Why this path is worth qualifying

Kalshi documents `market_lifecycle_v2` metadata updates containing strike fields. Its June 18 changelog explains that consumers can reconstruct strike metadata without waiting for the eventually consistent REST read model. This does not prove that the observed October 31 rollover delay was caused by that read model: the old rejection logs did not retain raw strike fields or HTTP cache evidence.

Official references:
- https://docs.kalshi.com/websockets/market-and-event-lifecycle
- https://docs.kalshi.com/changelog

The lifecycle subscription is authenticated and covers all markets; ticker filters are not supported. **The July 23 changelog supersedes the earlier restriction on subaccount-restricted WebSocket keys.** The prototype accepts an opaque verified owner/key binding; it does not assume a broader credential is required and cannot establish an actual credential's capability.

## Files and validation

- `lifecycle-strike.mjs`: pure bounded metadata store and quote-feasibility reducer.
- `lifecycle-strike.test.mjs`: 58 deterministic tests.
- `replay.mjs`: conditional synthetic availability comparison.
- `replay.json`: generated comparison with explicit assumptions.

Run:

```sh
node --test lifecycle-strike.test.mjs
node replay.mjs > replay.json
```

All 58 tests and replay assertions passed on Node 24.22.1. This is prototype coverage, not the production backend's full test suite.

## Invariants exercised

- The configured owner and credential binding must match the caller's trusted authenticated connection context. Connection generations strictly increase.
- Reconnection never restores cached authority. An explicit verified resync with a trusted subscription sequence anchor is required. Same-generation resync cannot rewind accepted sequence.
- Every data envelope on the subscribed SID passes sequence and source-time validation **before** filtering unrelated tickers or lifecycle message types. A gap, replay, out-of-order envelope, stale source time, clock regression, malformed frame, or unsupported subscription poisons continuity and requires resync.
- At most two exact, externally verified KXBTC15M scopes are held: the current canonical 15-minute window and the next. The scope carries the actual market exchange index; current Strata's final adapter expects index 2. The docs' example index 0 must not be substituted.
- Only explicitly prevalidated `greater` or `greater_or_equal` scopes with numeric positive `floor_strike` are accepted; every lifecycle strike type must exactly match its scope. Fixtures and replay use the observed KXBTC15M `greater_or_equal` contract. No comparison operator is inferred or changed by this metadata store. No subtitle inference, aliases, guessed strike, or silent numeric-string conversion. Explicit malformed/null data, conflicting strikes, window changes and lifecycle deactivation fail closed.
- Lifecycle metadata never changes a price quote timestamp. Quote feasibility still requires the same ticker/window, active market, verified depth, valid dollar ask, and age no greater than **5,000 ms**. These are simplified feasibility inputs, not replacements for actual book validation or financial gates.
- A non-null conflicting REST strike fails closed. Null REST strike is eligible for the simulated push path only if a separately verified lifecycle strike and an independently current executable quote exist.
- State is at most two scopes and a three-record diagnostic ring. No raw payloads or per-tick persistent logs are retained. Frame limit is 16 KiB. Transport-level queue/concurrency bounds belong to the separate shadow adapter.

## Trust boundary: not a production authentication implementation

The `authenticated` and `scopeVerified` booleans are **trusted test-fixture inputs**, not attestations and not proof of authentication. A production adapter must obtain its binding from the existing authenticated owner-scoped credential factory, validate its allowed capabilities, establish the actual subscribed SID and sequence baseline from supported protocol evidence, and deliver data without inventing sequence values. It must invalidate the store on disconnect, credentials/release/account changes, backpressure, parsing loss, heartbeat failure, and resync uncertainty.

The `heartbeat()` method accepts only the current generation but assumes the caller verified a genuine connection keepalive. Do not call it merely because a local timer fired. Neither a late heartbeat nor a fresh lifecycle event can repair a previously stale transport without resync. Any transport queue must be bounded and draining must preserve all-message ordering; dropped frames require invalidation, not catch-up using cached authority.

## Replay results: potential, not measured latency

The synthetic baseline reads at seconds 0–10, then every five seconds. Production timing offsets differ. Push is assumed to arrive 100 ms after the strike exists. Existing reads are assumed to retain a valid executable quote even when the REST strike is null; an event-driven wake is assumed to evaluate that quote without another request.

Examples:
- Strike and REST ready at 0: no gain (REST was already ready).
- Strike ready at 11 seconds, REST consistent immediately: simulated push feasibility at 11.1 seconds versus the next REST poll at 15 seconds, a 3.9-second potential improvement.
- Strike exists at 0 but REST exposes it at 15 seconds: simulated push feasibility at 0.1 seconds, a 14.9-second potential improvement.
- Push absent: no improvement; no invented strike.
- Quote 5,001 ms old: push path rejected regardless of strike availability.

The generated report also compares strike-ready times 0, 1, 5, 11, 15, 20 and 30 seconds with zero/five-second assumed REST visibility lag. These are NOT authenticated production measurements, order timings, fill evidence or profitability evidence. A push arriving late or carrying missing metadata cannot eliminate the provider-side publication delay.

## Both producer and final live consumers must be qualified

Source mapping at backend release `0a42b84b58491be76c05b6a9baba0ba2623d2b1b`:

1. `artifacts/api-server/src/lib/forwardTestFeeds.ts`: `targetOf` currently parses REST strike fields, and feed validation rejects invalid targets. Any future alternate metadata source must preserve exact market identity/window and publish a consistent immutable target with the original quote timing; no old signal may be restamped or rewritten.
2. `artifacts/api-server/src/lib/v13-production/executor.ts`: saved source target/crossing lineage is checked against `forward_test_windows`, and signal arithmetic is recomputed. Lifecycle promotion must not create a second crossing or mutate an already consumed window.
3. `artifacts/api-server/src/lib/strata/personalExecutionSupervisor.ts`: live `readMarket` repeats exact-market/book and fee evidence, including immediately before POST.
4. `artifacts/api-server/src/lib/strata/personalExchangeRead.ts`: `ownedMarketEvidence` independently requires exact ticker, exchange index 2, active REST status, supported price grid, complete matching fee metadata and signed book depth. I found no direct `floor_strike` check in this final adapter, but that does **not** mean lifecycle readiness unlocks an entry. These remaining REST facts can still lag or reject.

**Do not fix paper only and assume live execution is fixed.** First deploy only a separately approved shadow observer that has zero entry authority. Record bounded comparison evidence at several rollovers: provider send/receive times, sequence continuity, exact-market identity/window, REST strike presence/type, first valid executable quote age, final live admission decision and reasons. No forced signals or real-money test orders belong in this prototype.

Promotion would be a separate reviewed release, not a hot change to the currently trading worker. It must define an immutable metadata-evidence contract used consistently by producer and live final admission, retain fresh status/book/price/depth/fee/account/risk checks, prove reconnect/gap/conflict fallbacks, and pass production acceptance before claiming resolution. If REST status/fee metadata remains delayed, document that residual limit rather than bypassing it. Preserve the current five-second quote policy, controlled flat-account deployment and exact-SHA approvals.

Independent review follow-up: stale heartbeat cannot revive metadata without resync; quote exchange index must exactly match the verified scope. Added six regression tests and realistic periodic synthetic keepalives to replay.

Contract-parity correction: actual observed KXBTC15M REST evidence uses `greater_or_equal`, not the generic docs example `greater`. Both exact supported types are individually tested; mismatches and omitted/unknown types fail closed. This only changes offline metadata-shape support, not trading comparison semantics or entry authority.
