# Production source acceptance — execution disabled

## Revision and scope

Review PR #1's **final head commit**, not a previous passing revision.
The PR checks and acceptance comment record that exact SHA and run URL.
The main workspace remains on its original source; nothing is merged, deployed,
registered at API startup, migrated into a connected database, or activated.
No real order POST/DELETE, transfer, credential change, approval or arming was used.

Strategy remains C52/53 (`v13-champion-2-c52-confirm53`,
`314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`).
Production code is separate from the micro-live harness and its small limits.

## Implemented entry points

- `artifacts/api-server/src/lib/v13-production/consumer.ts`: consume persisted
  fresh champion candidates; separately classify reconciled owned positions
  using paper-cycle feed metrics. A paper EXIT/CONFIRM is never live authority.
- `executor.ts`: locked atomic fee-inclusive reservation, dispatch/cancel
  precommit, immutable decision/request digests, final account/source/book/fee/
  policy/ownership checks, logical one-use execution fence.
- `ledger.ts`: transactionally journal exact fills/settlement and derive durable
  cash, reservations, basis, realized net P&L, loss usage and residual positions.
- `transport.ts`: strict signed dedicated `(1,2)` adapter, canonical YES-book
  request/response normalization, exact owned order market on DELETE, opaque
  executor-only fence, GET-history proof. POST/DELETE responses are not fill proof.
- `readers.ts`: production factory with public depth/market/fee reads, verified
  approved fee-artifact digest, conservative formula bounds, dedicated signer,
  and the existing complete pair-history reader. No micro-live cap substitution.
- `worker.ts`: explicit execution startup or explicit GET-only recovery startup;
  periodic reconciliation before evaluation and no replay of dispatched claims.
- `lib/db/src/schema/v13Production.ts`: durable account, intent, position,
  journal and observation tables and numeric/account/commissioning constraints.
  The policy table also permits only one APPROVED policy.

Read providers reuse the final transaction client. They must not acquire a second
account lock or connection behind that fence. Final POST/DELETE keep the account,
approved-policy and safety rows locked while obtaining their last proofs.

## Safety and accounting contract

Amounts use integer micros and exact hundredths of a contract. Reservations
include entry notional, bounded entry fees and full-position exit fees. Admission
sizes down or blocks against approved capital, available cash, loss limits,
depth, pending claims and existing owned exposure. The $25,000 notional ceiling
is not a sizing target or automatic authority.

Concurrent consumers serialize reservations. Evaluation/crossing identifiers and
claim state prevent duplicate submissions. DISPATCHED/UNKNOWN and claimed DELETE
are never replayed after restart. Uncertain absence/404, incomplete history or a
POST/DELETE response cannot release their reserves. A failure before invoking
the transport may be journaled as a proven local non-submission; a crash in the
dispatch gap remains uncertain.

Complete GET evidence must reproduce exact order identity, authoritative fill
totals, previously journaled fill payloads, cash and owned positions before
mutation or clearing. Inconsistent/foreign evidence freezes instead of clearing.
Late terminal fills are journaled and freeze new admission. Authorized exposure
is limited under the account lock; a late fill reopening an older position must
still be recorded even if it creates actual overlap.

Owned EXIT is reevaluated independently under the reservation lock and again
bound to unchanged, fresh feed evidence at the final fence. Reduce-only IOC
exits use an approved minimum executable bid, preserve fractional residuals
without rounding up, and debit actual observed fees. Winning/losing settlements
require complete authoritative position/settlement attribution. Kalshi's
settlement aggregate fill fee is not charged a second time.

Checked conservation: cash equals initial cash plus journal cash deltas;
account basis equals remaining position basis; reservations equal all intent
holds; net realized P&L and conservative realized loss usage match the journal.

## Real PostgreSQL / simulated exchange acceptance

The complete local safety suite passed **281 tests, zero failures, zero skips**.
Of those, **22** exercise the new production engine against actual PostgreSQL:

1. Concurrent duplicate/crossing claims reserve and locally submit once.
2. Reservation-write crash rolls back without a capability/position leak.
3. Dispatch-commit crash is retained and never replayed after reconstruction.
4. Accepted POST timeout/post-POST crash recover authoritative partial fills.
5. Partial reduce-only exits retain exact residual/basis; settlement closes it.
6. Cancel timeout/race ingests late fills without repeating DELETE.
7. Wrong account, incomplete/404-like history, foreign activity and cash mismatch freeze.
8. Policy revocation, stale fees and kill changes block final POST.
9. Concurrent revocation waits behind the final mutation's approved-policy lock.
10. Worker execution startup rejects kill switches; ticks never replay uncertainty.
11. Owned classifier emits a justified exit even when paper says WATCH.
12. Paper EXIT alone cannot sell a position with no owned champion exit trigger.
13. Fractional fill, refused upward-rounded exit and settlement conserve exact funds.
14. Execution-disabled GET-only recovery books late terminal fills and freezes admission.
15. Changed fill payload, missing fill total and foreign order identity retain holds.
16. Actual numeric/commissioning/account and APPROVED-policy constraints reject bad writes.
17. NO sell maps to canonical YES-book bid/complementary price; IOC/reduce-only persist.
18. Changed cash/source/depth blocks POST and records proven non-submission.
19. Read providers observe the same transaction client instead of self-deadlocking.
20. Forged executor fences are rejected before any HTTP or real credential use.
21. Open owned exposure blocks a second admission.
22. A NO-owned position is independently exited as NO, not the paper's side.

These use an in-process simulated exchange with complete/partial/late/failed
evidence. They prove code/database behavior, **not actual broker executions,
cash precision, permissions, runtime commissioning or profitability**.

## Reproduce without connected databases or credentials

From `artifacts/api-server`:

```sh
node scripts/run-v13-disposable-postgres.mjs
node scripts/run-v13-disposable-postgres.mjs --full-suite
```

The runner reads no ambient DATABASE_URL or Kalshi credentials. It initializes
a new temporary loopback PostgreSQL cluster, creates its test database, applies
schema only there, strips child credentials/environment, runs tests and stops/
removes the cluster. It fails if PostgreSQL is unavailable; there is no runtime
database fallback. Full-suite mode requires unused local port 5432 and exercises
the existing `postgres/v13_ci` CI destination pin without weakening it.
Run separate branches' full suites sequentially.

Initial cluster-file synchronization is skipped to avoid temporary-filesystem
initialization stalls; PostgreSQL runtime `fsync` and `synchronous_commit` remain
ON and are asserted by the acceptance fixtures. Application failures are injected
at named stages and recovery reconstructs executor/worker instances from the
database. These are not broker-server crash or operating-system power-loss tests.

Workspace typecheck: `pnpm run typecheck`. CI includes these 22 tests through
`test:v13-production-ledger` in the existing `test:v13-safety-all` aggregation.

## Required independent review; runtime still blocked

Brit should inspect the final SHA's source, acceptance fixtures, constraints,
transaction locks, claim-to-network crash gaps, conservation, canonical NO
normalization, fee bounds, fractional residuals and late-fill freeze behavior.
Record findings against that revision; fix findings before activation.

Commissioning repair stays in PR #2, not this branch. Its actual-adapter tests
substitute authentication only after NODE_ENV=test, exact disposable URL and
actual loopback/database identity verification. Normal CLI guards remain intact.

Before any future runtime setup, the owner must independently resolve the
historical primary binding/missing dedicated linkage, select the intended
runtime/account, review champion selection, approve the production money and fee
policy/artifact and independently verify account cash precision/exclusive
control. Fresh full signed account history, permissions and balance are still
required. No synthetic approval is transferable to runtime. Schema application,
merge, deployment, startup registration, arming and real commissioning are
separate later approvals, not implied by this source handoff.
