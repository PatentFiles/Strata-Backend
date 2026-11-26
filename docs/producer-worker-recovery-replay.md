# Offline timing and recovery regression pack

## Scope

This is a deterministic **worker/executor orchestration regression pack**, not
an integrated producer-to-worker replay or a measurement of production speed.
It is test-only: no runtime, migration, trading policy, source clock or provider
behavior changes. The five-second limit is unchanged.

The added cases use real `ProductionWorker.tick`, `ProductionExecutor`
reconciliation/admission/dispatch methods, the source-age helper, the bounded
recovery read runner and the monotonic producer timing accumulator. Database
rows, authority admission, provider responses and elapsed intervals are explicit
synthetic ports. Fresh paths deliberately throw a test sentinel after source
freshness checks and before planning, reservation or any order submission.

The held-position case checks invocation of the existing trusted protective
callback after reconciliation. It does not execute or certify protective order
authorization, signing or transport. `gate` is intentionally a test double;
these tests cannot certify SQL, row locks, ACL/RLS or real account authority.

## Added coverage

- Original source receipt remains unchanged at 4,999, 5,000 and 5,001 ms. The
  first two reach the post-freshness sentinel; the last is refused.
- A simulated 2,000 ms producer delay, 2,000 ms reconciliation delay and
  1,001 ms book delay are charged to the same source clock. A fresh book does
  not revive the old source, and no reservation or submit occurs.
- Reconciliation that consumes the remaining budget leaves no eligible source
  in the synthetic discovery predicate, including a subsequent committed wake.
- Existing regression totals of 5,824 ms source age plus 1,163 ms provider age
  remain 6,987 ms. These values come from the existing
  `workerPublicMetadataPrefetch.test.ts` fixture. They are not newly collected
  telemetry, and no historical stage breakdown is inferred.
- Provider evidence that is already too old prevents another book read even
  while the source receipt itself is under five seconds.
- Synthetic monotonic phase intervals remain separate from source wall time.
  Missing timing or invalid/future source ages remain unknown, not zero.
- UNKNOWN, DISPATCHED, TERMINAL and BLOCKED intents remain no-ops through six
  dispatch attempts across two reconstructed executor objects reading the same
  mocked intent state. This does not restart a process or prove persistence in a
  database. No mock submit,
  book read or ledger persistence is reached.
- An UNKNOWN count is read through the real mode helper; a separate explicit
  fixture option installs the held callbacks. The real worker/executor orchestration
  reconciles and invokes a synthetic protective callback. This is not a transition
  test of the actual UNKNOWN coordinator into held mode. Entry discovery and
  ordinary renewal remain off. Incomplete signed history stops this path.
- Recovery completed at its 15-second deadline cannot become proof, retry or
  authority. Its one-use read runner cannot be replayed.
- Child-process tests verify credential/production-switch stripping and denial
  of fetch, HTTP, TLS, TCP and UDP I/O. Test doubles are local functions.

## Run

From `artifacts/api-server`, after the repository's normal dependency setup:

```sh
pnpm run test:producer-worker-recovery-replay
# Optional broader regression qualification, reusing existing tests unchanged:
node scripts/run-producer-worker-recovery-replay.mjs --with-regressions
```

The default command runs only the 15 new orchestration cases and two runner
fence cases. It is included in `test:v13-safety-all`. Optional broader checking
adds 97 existing timing, quote receipt, wake/coalescing, metadata, final wire,
UNKNOWN and protective-source tests without copying or modifying those tests.

The runner has a fixed file list, a 90-second child timeout, a temporary output
directory cleaned in `finally`, a dummy loopback database URL and a small
explicit environment allowlist. It has no connected-database fallback, does
not create a database and uses no live provider credentials. Dependency
bundling points workspace aliases at the current checkout, not another copy.

## Baseline and local evidence

Prepared against a complete 1,363-file snapshot verified by Git blob hashes
against main `c756e1bbcfa1894a0040e60634f8e8cf8323f535`. The repository comparison
from deployed `dc38df9b91688c0d2b0c2beac8457f654cd88fde` to that main contained only
tests, fixtures, documentation and test scripts, so the production methods
exercised here are unchanged between those revisions.

Local qualification and hashes are supplied in the companion review manifest.
These results do not establish exact-head remote CI, deployment readiness or
real production latency. No code was pushed, merged or deployed by this work.

## Concrete remaining integration gaps

- Actual producer feed collection, SQL evaluation persistence, transaction
  commit and committed notification flowing into the worker in one test.
- Automatic UNKNOWN-to-held transition and a real process/database restart.
- Native database discovery, authority checks, locks, reconciliation commits,
  reservation and final dispatch under the target runtime role.
- Complete timestamped historical events with provenance. The old two-number
  regression is not sufficient to reconstruct a historical timeline.
- Railway event-loop/network/DB timings, live startup and runtime verification
  after infrastructure is restored. An offline pass cannot prove that fix.

Those checks should use the existing disposable PostgreSQL and release
qualification workflows plus separately authorized post-recovery observation.
Do not substitute synthetic timings for measurements, relax freshness to obtain
a pass, use production credentials, or treat this patch as permission to trade.
