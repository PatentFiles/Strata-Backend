# Durable PREPARE public-metadata overlap

Candidate based on `2ced77708ab048b1b69d9b83bca4a3094bda302a`.

## Observed missed signal and limits

Supplied production trace, 2026-11-17 UTC, evaluation
`414a88b9-9f5a-48a9-88d8-34c9393c1498`:

- Source 22:48:02.761; canonical book 02.898–02.962, YES 49 cents.
- Producer commit observed 03.315 (source age 554 ms).
- Worker reconciliation 03.342–04.436; discovery 04.498.
- Book read 04.560; fee verification completed 04.923 (reported 362 ms).
- Prepare rejected 05.246 because ask 51 exceeded source reference 49.
- Later source age 4,693 + provider age 901 exceeded the unchanged 5,000 ms limit.

The committed wake already arrived promptly: only 27 ms separates observed
commit and reconciliation start. Poll acceleration is not the demonstrated
bottleneck. Mandatory reconciliation cannot be skipped. Producer's remaining
transaction spans are not decomposed by this trace, so this patch does not
speculatively remove durable writes or move notification before COMMIT.

The durable fee path did not participate in existing API-source-only metadata
prefetch. This patch lets its **public GET transport only** overlap mandatory
reconciliation, behind the existing explicit PREPARE prefetch opt-in. It does
not pre-authorize fees, cache a signed book, or change admission price.

A deterministic test captures all five public bodies before a simulated 1,100 ms
reconciliation delay, then runs the real durable verifier with direct fallback
transport forbidden. It verifies five total public reads, a fresh locked model
read, and the unchanged original source timestamp. This demonstrates removal of
those reads from the post-reconciliation path, not a measured production speedup.
At most the reported 362 ms fee stage could be hidden in the supplied trace;
model/authority queries and other parallel reads remain. No counterfactual fill,
49-cent availability, or successful order is established.

## Safety boundary

- Existing coordinator enforces exact account, owner, release, policy, worker
  holder/fence and evaluation identity before consuming the one-use attempt.
- A WeakMap-bound process-local capability preserves the conservative creation
  clock (before every transport) and original monotonic deadline. Consumption
  cannot mint a new five-second window; copied/serialized objects fail closed.
- Durable model, policy, historical bytes, revocation and publication-change
  checks still run after reconciliation. No cached authorization decision.
- Historical source authenticity and current-publication claims remain false.
- Failed, stale, stopped or scope-changed admitted attempts cannot fall back to
  fresh reads. Final-market and wire-fee reads remain separate fresh direct GETs.
- Signed book, exact 49-cent source ceiling, final freshness checks, mandatory
  reconciliation, protective exits and all kill/lease/revocation gates unchanged.
- Existing opt-in false/unset remains off. No runtime setting is changed here.

## Verification

Run full workspace typecheck, durable-fee-offline, public-prefetch-prototype,
public-metadata-prefetch-config, final-public-metadata-phases,
producer-worker-recovery-replay and v13-safety-all. New tests are in existing
CI-selected suites, not an uninvoked standalone script. Native suites use only
disposable loopback PostgreSQL and synthetic provider responses.

No production requests, account controls, orders, publication or deployment are
part of this patch preparation. A later backend release still needs its normal
build-specific approvals; code changes do not establish live readiness.

## Additional confirmed FINAL self-lock repair

A separate native investigation found a deterministic blocker not addressed by
metadata overlap: FINAL market verification runs inside the ledger transaction,
which holds the account row `FOR UPDATE`. Its durable fee stage previously
queried `FOR SHARE OF m,s,a,p` on another pool connection, waiting on its own
awaiting caller. A bounded200ms test lock timeout reproduced the failure before
any public provider read. Borrowing the actual owning transaction succeeded.

The supervisor now passes its invocation-local `currentTransaction()` into the
durable fee stage (ordinary and held-protective market branches). Both policy
lookup and model locking use it; startup/PREPARE without a transaction still
use the pool. The borrower never begins, commits, rolls back, releases or retries
a client. WIRE already used the owning transaction and is unchanged. This is not
permission to omit a lock or reuse an old authorization.

Native regression covers the original self-lock, successful actual historical
model/provenance verification inside the owner transaction, concurrent revocation
blocking, caller-owned rollback, committed entry revocation, and held protective
fee proof. It also exercises actual executor PREPARE/FINAL/WIRE through the real
durable model verifier and synthetic raw transport. Private grant/lease ports
and provider responses are explicit test fixtures; these tests do not certify
production approval or live exchange behavior. Provider age901ms and original
source quote are retained. Synthetic transport returns UNKNOWN as usual.

This removes a confirmed transaction-lock blocker, but does not establish that
all live provider/DB work fits five seconds. Separate scratch timing comparison
showed only17–28ms headroom under one optimistic set of assumed delays with
additional API phase overlap; that is neither durable timing proof nor a robust
latency guarantee. No price/freshness limit is relaxed.
