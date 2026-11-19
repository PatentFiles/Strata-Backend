# Settled-cash recovery commit fence

`sql/strata_owner_settled_cash_recovery_commit_fence.sql` is an additive,
unapplied candidate for reviewed deployment. Apply it atomically before
enabling the matching server route. It does not clear a freeze, change
balances, grant execution, or grant a database role. A 3-second DDL lock
timeout and 30-second statement timeout make a busy database fail the
migration rather than wait indefinitely. Presence of both guards and their
catalog/ACL posture is a route prerequisite.

The audit and account constraints are reciprocal. A clearance must point
to one audit from the current transaction with the exact owner, prior
revision, prior reason, signed snapshot digest and clock. The audit
validator rereads the final account and released, non-armed lease before
commit and refuses evidence at or beyond five seconds. The application
does not use savepoints or change constraint deferral; the xid comparison
uses the epoch-independent low 32 bits because the tuple stores an xid.
Freshness is measured at deferred constraint evaluation, not WAL fsync.

Both functions are explicitly invoker-only with `pg_catalog` search path.
Their ACL is owner-only; custom default permissions that exceed this fail
the migration. No schema/table ACL changes are made. The backend role
still needs separately reviewed existing DML reads and narrowly authorized
writes. A database owner can alter database constraints and is outside
the untrusted runtime threat model; the route must not expose arbitrary
SQL, change the constraint mode, or create savepoints.

The native fixture proves deployability and these boundaries locally,
using representative relations, a stripped environment, and a throwaway
loopback database. It does not certify production topology, grants,
provider credentials, signed reconciliation, release approval, or
actual settlement cause. Keep STOP and the cash freeze unchanged until a
fresh authenticated stopped-account reconciliation and approved deployment
are available. Do not retry a clearance automatically after uncertain
commit; recover through independent readback.
