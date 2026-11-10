# Native producer commit/wake integration candidate

**Prepared, not native-qualified.** This extension is test-only and has not been
published. The existing offline regression package is preserved unchanged.

## Baseline and composition

The integration checkout starts from frozen combined-worker candidate
`c42719f72c888737750d2263cfb6b1f39627d185`, tree
`126d134adfbdb722919ffad1ec7e56b4e355c342`. Both match its qualification handoff.
The original combined files are unchanged, except additive package wiring.
The four non-package files from the previously reviewed timing/recovery patch
are copied byte-for-byte. The original package and archive remain available.

The aggregate retains `test:restricted-combined-worker`, adds the existing
17-test offline timing pack and adds `test:producer-commit-wake`. Existing
native runners, runtime code, migrations and workflows are unchanged.

## What this new test is designed to exercise

Unlike the earlier deterministic orchestration pack, the new candidate invokes
the actual `runForwardTestCycle` using synthetic BTC/market/book feeds. It
creates and renews the real producer lease, classifies the cross, writes its
actual evaluation/window/paper-position records and commits through the normal
Drizzle transaction. It never inserts a replacement qualifying evaluation.

A test-only deferred PostgreSQL constraint trigger pauses the real COMMIT on
an advisory lock. A separate database client checks that the qualifying row is
not yet visible and no wake or production reservation has appeared. Releasing
the lock allows the producer's own notification to reach the real worker's
registered scheduler. The test neither calls `notifyCommittedForwardSignal`
nor directly calls the worker's tick or private scheduler.

The actual worker performs reconciliation, account-scoped policy discovery,
source reads, gate checks and entry preparation through a real
`ProductionLedger` and native SQL. A fresh case must create a committed
PREPARED intent with the original evaluation ID/timestamp and positive reserve.
The dispatch method is an explicit test boundary: it records the prepared
intent and stops the worker without performing an order action.

Four intended native subcases:

1. Successful COMMIT becomes visible to another session before the emitted
   wake is consumed, and the worker reserves the exact committed source.
2. A deferred-trigger error rolls back COMMIT, leaving no qualifying source,
   no wake and no production reservation.
3. A synthetic late book advances the consumer clock to source age 5,001 ms.
   The real admission check refuses it, without a reservation or submit.
4. STOP while producer COMMIT is blocked removes the worker's listener. The
   source may commit and publish, but does not reopen worker admission.

## Safety and exact limits

Both URL and actual connected database name/user/address/port are checked
before test setup. Only the canonical fresh loopback database is accepted.
The existing runner strips credentials and fences external sockets. Global
fetch is additionally refused by this test, and both provider submit/cancel
functions throw if called. The policy remains fixed at 5,000 ms.

Native source/transaction/notification/scheduler/discovery/reservation are
intended to be real. Provider snapshots, book and fee evidence, local account
approvals and logical clocks remain synthetic. The exchange mode is SIMULATION,
with actual owned-account gate SQL and a canonical producer receipt checked
separately. This is not complete LIVE cash-risk/fee/signing/transport proof, a
production account test or measured production latency.

The four integration subcases have **not executed in this workspace**. Their
assertions are intended coverage, not passing evidence. SQL syntax, constraint
behavior, scheduling races and the expected reservation are unverified until a
native run succeeds. Parsing, bundling, typechecking and source-contract tests
cannot replace that run.

The canonical runner currently stops before database creation with:

    PostgreSQL binaries required; no connected-database fallback exists

No connected database or alternative implementation was substituted. The
native runner was not changed, no PostgreSQL installation was attempted, and
no policy or assertion was weakened. Existing offline tests remain separately
useful and independently runnable.

## Qualification when the normal development/CI environment is available

From `artifacts/api-server` after the repository's frozen dependency setup:

```sh
# Source contracts only; no native SQL claim:
node --test scripts/producerCommitWake.contract.test.mjs
# Intended real integration, exclusively through the unchanged fresh-DB runner:
pnpm run test:producer-commit-wake
# Preserved independent suites:
pnpm run test:producer-worker-recovery-replay
pnpm run test:restricted-combined-worker
```

Run full workspace typechecks/build and the normal aggregate on the exact
reviewed publication head. Preserve initial failures and cleanup outcomes.
Do not report this extension as native-qualified or release-ready before that
validation. Railway recovery, live runtime verification and any publication or
deployment remain separate decisions.
