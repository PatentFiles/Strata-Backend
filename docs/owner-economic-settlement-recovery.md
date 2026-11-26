# Exact-owner economic settlement recovery

## Scope
This is accounting-only software for one fully settled buy-only position with
an historical protective EXIT whose send/acknowledgement remains UNKNOWN.
It is **not** an order retry, no-send finding, reserve release, worker release,
risk-hold clearance, fee approval, ARM, START, or live-readiness declaration.
No saved stake, capital limit, daily/total loss limit, or strategy is changed.

The API remains disabled unless STRATA_ECONOMIC_SETTLEMENT_RECOVERY_SHA is
exactly the validated RAILWAY_GIT_COMMIT_SHA. Outcome and cancellation remain
available across release rotation to resolve a saved request without replay.

## Existing architecture preserved
The current API owns authenticated owner controls and personal live sessions
through sharedPersonalTradingControls. The independent start:paper process
owns research production; this recovery creates no producer or worker.
userExecutionRouter mounts the new routes under existing owner/AAL2 middleware.
Neither a body nor a query may choose a different owner/account.

## Data path
1. Pin the existing owner, exact account pair (subaccount 1 / exchange 2),
   policy/control revision, current verified credentials, lease and UNKNOWN marker.
2. Require disarmed, unscheduled and stale-or-released worker state. Current
   management metadata must attest the restricted key and exact subaccount.
3. Read a bounded signed cash/history bracket. Venue fills, settlement, flat
   inventory and all retained financial history must reconcile exactly.
4. Match the whole settlement, original buy cost and already-booked fill fees.
   Cumulative venue fee_cost is not subtracted again as a settlement fee.
5. Return a non-authorizing preview of the proposed cash/P&L only.
6. A separate owner confirmation dispatches one UUID-bound request. Fresh
   evidence and identical scope are required again. Inside an account-first
   transaction, lock the lease, connections, credentials and financial history.
7. Insert the canonical SETTLEMENT event, update the exact position/cash,
   verify conservation, and insert the immutable recovery receipt atomically.
   The UNKNOWN intent/marker, reserved cash, lease, holds and controls stay intact.
8. Resolve any lost response by exact-owner/request receipt readback, never
   by resending the writer. Durable cancellation uses the same lock order and
   prevents a delayed request from committing. NOT_RECORDED alone is not safe
   retry permission. Another owner cannot cancel or read this owner's receipt.

## Release sequence and rollback
Qualify the exact backend/Wallets pair, native PostgreSQL 16/17 tests and all
required CI. Review and apply the additive economic-settlement migration using
the existing migration process. Verify runtime SELECT/INSERT grants and deny
anonymous/authenticated browser roles and the paper role. Deploy the qualified
backend while trading stays stopped, then expose the matching Wallets panel.
Enabling the exact-build feature is a platform operation, not owner consent.
The owner must preview and explicitly authorize accounting; nobody should
impersonate that approval or write financial data directly with SQL.

Disable the feature flag first for rollback; never delete canonical financial
events, receipt/cancellation rows or reverse a settled cash update by hand.
**After any recovery has been posted, do not roll back to code that releases
an entry's reserve solely because its position is flat while a child EXIT is
still uncertain.** Retain this ledger guard or a later equivalent release.

A recorded settlement does NOT make the retained UNKNOWN exit terminal.
Reserve/lease release and subsequent stopped-account reconciliation require
independent complete evidence and a separately qualified path. If that proof
is missing, report the blocker; do not clear it to make ARM pass.

## Evidence and tests
Local fixture tests exercise full financial matching, missing/corrupt evidence,
account/market binding, exact quantities and fee accounting. HTTP tests use
synthetic authenticated identities and cannot send venue orders. The native
runner creates a disposable Unix-socket PostgreSQL database, strips inherited
secrets and denies external network access. It verifies atomic rollback,
concurrent duplicate posting, lost COMMIT acknowledgement, immutable receipts,
role restrictions and delayed-request cancellation races. Its reduced schema
is transaction evidence, not a substitute for deployed-schema acceptance.

The incident candidate was evaluated using a read-only signed preview. That
was not a posted production recovery. Customer balances and account identifiers
are intentionally omitted from this public repository. Fresh owner-authenticated
production evidence is required at application time.
