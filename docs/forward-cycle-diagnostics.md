# Non-authoritative forward-cycle diagnostics

`forward_cycle_timing` is sampled process-local telemetry, not a source freshness check, execution authority, fill assertion or complete event archive. Existing evaluation/source timestamps, strategy inputs, provider reads and trading gates are unchanged.

The worker observes cycle start, completion of its decoded/validated feed bundle, canonical classifier start/finish and return from the committing transaction. `commitReturnedAtMs` is a local observation after transaction return, not a database commit timestamp. `marketDecodedAtMs` is the existing exact-detail fetchedAt, assigned after JSON decoding; `btcReceivedAtMs` is the existing validated BTC receipt boundary. `legacyEvaluatedAtMs` keeps the earlier source-clock meaning visible. Wall clocks can regress; these are raw boundaries, not proven cross-machine latency. Logs should not substitute a later timestamp for a missing earlier one.

Provider counters compare timestamps of consecutive successful BTC observations in each engine's process-local state. Equal timestamps do not prove a duplicate payload, and decreasing timestamps do not establish exchange sequence reversal. A receive gap over 30 seconds measures a local observation gap, not lost exchange messages. Invalid feed attempts are not a complete expected-event denominator. Counters can reset on process restart or eviction (maximum 32 engine states).

At most one event is pending globally and each engine samples at most once per 30 monotonic seconds. Emission runs in setImmediate, after synchronous signal wake scheduling, with no await, database write or network request. Slow or failing logging is not required for strategy completion. Pending/rate-limited observations are deliberately omitted; this is not a durable capture collector. Caller-supplied extra fields, market prices, account IDs, account balances, credentials and raw payloads are not logged. Evaluation UUID permits joining a sampled committed cycle.

Tests cover preserved boundaries, duplicate/regression/gap distinctions, rate limiting, deferred bounded emission, 32-engine state eviction, field allowlisting and clock/sink/scheduler failure isolation. No profitability, completeness or live fill claim follows from these tests.

## Qualification and remaining limits

The logging callback still shares Node's event loop: setImmediate removes it from the synchronous commit/wake stack but cannot guarantee zero future latency under a slow sink. The current logger callback is synchronous. Promise-returning replacement sinks require explicit rejection handling and tests before adoption; this implementation does not claim support for them.

Local qualification passed: six diagnostic tests, 34 feed-read tests, 11 cadence/validation tests and 11 worker tests in a fresh PostgreSQL 17 cluster with isolated schema. Library/API typechecks and API build passed. Independent review reported no blocking defect and reran six diagnostic plus 11 cadence tests. Full exact-PR qualification is delegated to CI; these focused local checks are not a full-suite claim. No deployment, trading activation, source-clock change or production data mutation is included.
