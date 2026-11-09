# Non-authoritative forward-cycle diagnostics

`forward_cycle_timing` is sampled process-local telemetry, not a source freshness check, execution authority, fill assertion or complete event archive. Existing evaluation/source timestamps, strategy inputs, provider reads and trading gates are unchanged.

The worker observes cycle start, completion of its decoded/validated feed bundle, canonical classifier start/finish and return from the committing transaction. `commitReturnedAtMs` is a local observation after transaction return, not a database commit timestamp. `marketDecodedAtMs` is the existing exact-detail fetchedAt, assigned after JSON decoding; `btcReceivedAtMs` is the existing validated BTC receipt boundary. `legacyEvaluatedAtMs` keeps the earlier source-clock meaning visible. Wall clocks can regress; these are raw boundaries, not proven cross-machine latency. Logs should not substitute a later timestamp for a missing earlier one.

Provider counters compare timestamps of consecutive successful BTC observations in each engine's process-local state. Equal timestamps do not prove a duplicate payload, and decreasing timestamps do not establish exchange sequence reversal. A receive gap over 30 seconds measures a local observation gap, not lost exchange messages. Invalid feed attempts are not a complete expected-event denominator. Counters can reset on process restart or eviction (maximum 32 engine states).

At most one event is pending globally and each engine samples at most once per 30 monotonic seconds. Emission runs in setImmediate, after synchronous signal wake scheduling, with no await, database write or network request. Slow or failing logging is not required for strategy completion. Pending/rate-limited observations are deliberately omitted; this is not a durable capture collector. Caller-supplied extra fields, market prices, account IDs, account balances, credentials and raw payloads are not logged. Evaluation UUID permits joining a sampled committed cycle.

Tests cover preserved boundaries, duplicate/regression/gap distinctions, rate limiting, deferred bounded emission, 32-engine state eviction, field allowlisting and clock/sink/scheduler failure isolation. No profitability, completeness or live fill claim follows from these tests.

## Qualification and remaining limits

The logging callback still shares Node's event loop: setImmediate removes it from the synchronous commit/wake stack but cannot guarantee zero future latency under a slow sink. The current logger callback is synchronous. Promise-returning replacement sinks require explicit rejection handling and tests before adoption; this implementation does not claim support for them.

Local qualification passed: six diagnostic tests, 34 feed-read tests, 11 cadence/validation tests and 11 worker tests in a fresh PostgreSQL 17 cluster with isolated schema. Library/API typechecks and API build passed. Independent review reported no blocking defect and reran six diagnostic plus 11 cadence tests. Full exact-PR qualification is delegated to CI; these focused local checks are not a full-suite claim. No deployment, trading activation, source-clock change or production data mutation is included.


## Version 2: bounded transaction phase intervals

The sampled event now includes a fixed nine-interval `transactionPhases` object,
measured with local monotonic time. It never reads SQL text, parameters, rows,
connection strings or account data. Timing hooks do not add queries, awaits,
retries or pool interception; SQL order, locks, lease checks and source clocks
remain unchanged. Missing/reordered marks or invalid clocks produce unknown
intervals (`complete=false`), not zero latency.

- `poolAndBeginMs`: transaction request to entry into Drizzle's transaction
  callback. This combines pool queueing/connection acquisition, BEGIN and local
  scheduling. It does NOT independently measure pure pool checkout.
- `leaseLockMs`: engine lease row-lock acquisition and validation.
- `positionReadMs`: open paper-position read/lock and identity check.
- `windowPreparationMs`: window insert-if-absent, row lock and validation.
- `historyPreparationMs`: entry evidence checks, old BTC sample cleanup, sample
  insertion and history read.
- `classificationPreparationMs`: in-memory history/velocity preparation, entry
  structure checks and the canonical classifier.
- `strategyPersistenceMs`: remaining evaluation/window/position/engine writes
  and event construction until the callback returns.
- `leaseRenewalMs`: final fenced lease renewal.
- `commitAndReleaseMs`: callback completion through transaction return, including
  COMMIT/client release and local scheduling.

Every interval includes local JavaScript and network/DB waits, not database CPU
alone. Data is still sampled successful committed cycles, not a complete attempt
or lock-wait trace. The existing pool wrapper intentionally does not instrument
Promise-style connect; this patch leaves that safety boundary unchanged. To
measure pure pool acquisition later would require separately qualified driver
instrumentation, not relabeling `poolAndBeginMs`.
