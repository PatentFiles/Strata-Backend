# Held paper market read at rollover

## Reproduced defect

Baseline tree `cd4f5533caa3ac91f2dab657dd35b32dea365e7a` calls current-market
discovery before reading an existing paper position's exact ticker. The current
market result is unused by the producer. When the next quarter-hour market is
not yet available, this dependency prevents observing an available settlement
or executable exit quote for the held contract and keeps the paper position
open. Even when discovery succeeds, it adds unrelated provider requests before
the held read and consumes the same eight-second feed budget.

## Narrow change

An open paper position supplies its exact market ticker to the parallel market
read. With no open position, current-market discovery is unchanged. A failed
held read never falls back to a different ticker. Once the position clears,
the next cycle resumes current-market discovery.

Current-market rollover diagnostics are emitted only by current discovery.
They therefore have no new-window samples while the paper producer is reading
a held contract directly. This is an observation gap, not evidence that the new
market was unavailable or its strike was late. Do not restore unrelated reads
to the held path solely to produce those diagnostics.

The shared deadline, sibling cancellation and settlement, BTC validation,
market identity validation, lease/epoch fences, locked position recheck,
settlement requirements and entry book gates remain unchanged. No live order
path, strategy rule, database schema, retention policy or deployed setting is
changed. This fix does not establish the cause of any historical live miss.

## Evidence and qualification limits

- Three added feed-scope regressions fail on the unchanged baseline and pass
  with the candidate: unavailable next market, failed held read without fallback,
  and discovery resuming after the held position clears.
- The feed-scope/public feed/cooldown group passes 37 tests. Existing cadence,
  feed validation and expiry-close tests pass 23 tests. Offline pool-error,
  pool-checkout, connection-fence and analytics cache/drainage tests pass 61 tests.
- The existing native worker integration rollover case now requires settlement
  while current-market discovery would fail, and retains exactly-once and next
  window crossing assertions. It has not run locally: PostgreSQL binaries are
  absent. This is not a native database or full safety-suite PASS.

Run `test:worker` through its `run-isolated-worker-test.mjs` harness on a verified
fresh disposable PostgreSQL database, and run the required full safety suite
on the final combined candidate before release. Running the integration file
directly without `FORWARD_TEST_ISOLATED_SCHEMA` is intentionally refused.
Earlier qualification receipts do not cover
this runtime change. No production database or exchange was contacted for this
audit, and nothing was published or deployed.
