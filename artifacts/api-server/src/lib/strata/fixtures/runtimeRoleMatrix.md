# Disposable runtime-role qualification

This is a test candidate, not a production permission migration. It creates
fixture-only roles and policies in a freshly created, loopback-only database.
It does not connect to the deployed database or read production credentials.
The policies below must not be copied into production as an approved grant set.

## What the new suite exercises

`runtimeRoleMatrix.postgres.test.ts` installs the unchanged full application SQL
manifest through `installFullRecoverySchema`, including its actual-connection
identity check before DDL. It uses the same eight fixed relations as runtime
session attestation, rather than maintaining a different target list.

The existing migration owner remains non-superuser and NOBYPASSRLS. Actual
separate API, worker, and unrelated LOGIN roles have no ownership, membership,
CREATEDB, CREATEROLE, REPLICATION, superuser, or BYPASSRLS capability.

The suite asserts:

- Owner + NOBYPASSRLS still sees seeded rows with RLS enabled, FORCE disabled,
  and no policies. Existing owner-role recovery tests do not prove tenant RLS.
- A non-owner with each SELECT/INSERT/UPDATE ACL but no policy sees no rows,
  updates zero rows, and cannot insert. ACL booleans alone prove too little.
  Catalog ACL/zero-read checks cover all eight tables; actual DML probes target
  accounts and the refused release insert, not all eight table lifecycles.
- Runtime identities cannot regain the owner/bootstrap role, create roles,
  databases, replication slots or schema objects, disable safety triggers,
  truncate/delete accounts, or read unrelated credential/Vault tables.
- Explicit worker-only policies restore service-wide row access without
  exposing rows to an unrelated role that has the same table ACLs. Human release
  authority tables receive SELECT policies only; a worker release insert is
  refused even though its test role still has the INSERT ACL.
- A worker account insert invokes the real definer trace-scope trigger; both
  account and scope row exist in the transaction and disappear on rollback.
  Safety flags remain disabled, and a rolled-back revision update is undone.
- A synthetic API policy uses transaction-local owner context. Missing or
  malformed context fails closed; cross-owner updates/inserts are denied;
  COMMIT, ROLLBACK and failed transactions clear context on the same reused
  physical connection. Simultaneous connections retain independent contexts.
- The API role can deliberately set either owner's context. This is an explicit
  counterexample to treating a custom GUC as authentication, not a vulnerability
  claimed to be fixed by this fixture.
- Transaction-local search path and timeout settings return to their original
  baseline after commit, rollback and an aborted transaction on the same pooled
  session. A separate dirty-session counterexample shows that session-level
  context survives `Pool.release()`, and `SET LOCAL` restores that old value
  after commit rather than clearing it. The dirty checkout is destroyed; a new
  connection must have no owner context. No production session setting changes.
- All eight application SECURITY DEFINER functions have their expected fixture
  owner, search paths and EXECUTE ACLs. New application definers require an
  explicit inventory update. These checks do not prove deployed ownership or
  grants, and do not execute functions that mutate provider state.

## Supported invocation and reporting

From `artifacts/api-server`:

```
pnpm run test:runtime-role-matrix
```

The command first runs dependency-free source-contract checks, then invokes the
existing `run-v13-disposable-postgres.mjs` runner. It is also included in
`test:v13-safety-all`, which is the existing complete hosted qualification path.
The runner never falls back to an ambient database. PostgreSQL tooling, pinned
workspace dependencies and permission for a loopback socket must already exist.

Static checks and TypeScript syntax checks are not native PostgreSQL passes.
If PostgreSQL is missing or local sockets are denied, report the exact failure
and leave the database assertions unrun. Do not install unrecognized tools,
weaken the network fence, or substitute a connected database.

## Two separate production design decisions

1. **Trusted service capability reduction:** use dedicated non-owner runtime
   identities with exact object privileges and no CREATEDB, CREATEROLE or
   REPLICATION. Preserve the required service-wide access deliberately, through
   reviewed role policies or a clearly identified temporary BYPASSRLS model.
   Do not modify Supabase's managed `postgres` role or assume `service_role`
   works: application migrations explicitly revoke its credential/lease access.
2. **Tenant RLS:** separately bind verified identity to every transaction and
   query path, including background workers, borrowed transactions and pool
   reuse. Writable GUCs do not themselves authenticate the caller. A policy that
   permits every row to the worker is service isolation, not tenant isolation.

The actual application currently shares one pool between HTTP controls and the
personal supervisor. Reconciliation helpers also default to that global pool.
Do not switch credentials until those dependencies and all fallbacks have been
explicitly qualified. Separate database pools must preserve one authoritative
supervisor and durable lease fencing; another full API replica is not a safe
read-only canary by default.

## Mandatory next qualification before any production role cutover

The new matrix proves limited PostgreSQL behavior, NOT a complete runtime grant
manifest. Its eight-table worker policies intentionally lack many permissions
needed by real recovery. Authority tables remain read-only to its worker. It
does not run an exchange transport or create a
human approval, and it does not certify live dispatch.

After a separately reviewed permission design, run the following with the exact
candidate non-owner identities, full SQL chain, synthetic keys and fake provider
transport. Do not silently keep the existing owner fixture for these passes:

- `ownerUnknownRecoverySchema.postgres.test.ts`: durable KILL, reconciliation,
  native constraints, child-row locks, concurrent activity changes, immutable
  history, and receipt failure rolling back ledger events and trigger outboxes.
- `heldSupervisorDispatch.postgres.test.ts`,
  `heldSupervisorNoSend.postgres.test.ts`, and
  `heldSupervisorAmbiguous.postgres.test.ts`: partial fills through flat,
  durable no-send, ambiguous POST retention, no duplicate submission, and no
  reopening entry authority while exposure or an uncertain outcome remains.
- `heldReconciliationFence.postgres.test.ts` and
  `stopApplicationInterleavings.postgres.test.ts`: concurrent STOP/KILL, fencing,
  lease ownership and recovery continuing without permitting new entries.
- `protectiveRecoveryDeadline.postgres.test.ts` and
  `protectiveExitFractionalQuantity.postgres.test.ts`: bounded recovery,
  uncertain-commit handling, exact quantity and invoker-trigger helper access.
- `reviewedProtectiveExitFee.postgres.test.ts` and
  `protectiveActualAuthorityDispatch.postgres.test.ts`, through their existing
  protective-fee runner: revoked/expired authority and exactly-once protective
  dispatch with fake transport, including missing dependency permissions.
- Test explicit permissions for auth/profile admin gates, Vault access, invoker
  trigger reads, definer function ownership, sequences, audit inserts, technical
  lease renewal, and every helper that previously borrowed the global pool.
- Exercise rollback to the previous reviewed connection configuration without
  reviving a stale worker, losing an unresolved order, disabling protective
  recovery, or granting new trade/approval authority.

Native test success does not authorize production role/credential changes,
grant changes, deployment, recovery actions or execution. The original platform
schema, actual role memberships/default ACLs and deployed migration history are
still separate evidence requirements.

## Pool connection mode: facts and unknowns

`lib/db/src/index.ts:18-42` constructs a long-lived node-postgres pool with ten
connections. It does not implement request-level role switching, an automatic
session reset, or upstream pooler discovery. The direct disposable cluster
therefore models node-postgres reuse, not a hosted proxy's transaction pooling.

The legacy `createLiveProductionWorker` calls `assertDirectSessionDatabase`
before acquiring a session advisory lock (`liveControl.ts:90-110`). That guard
only rejects port 6543 and `pgbouncer=true` (`instanceLock.ts:12-24`). Synthetic
unit tests show that other endpoint addresses/ports pass. Passing is not proof
of direct/session mode. The personal supervisor has no call to this guard.
This is a limitation of the source evidence, not a finding that the deployed
connection actually uses transaction pooling.

Production ledger transactions borrow one client and keep BEGIN, account locks,
statements and COMMIT on it (`ledger.ts:130-171,291-343`). That is necessary for
transaction-local settings, but session-sensitive operations spanning multiple
transactions additionally depend on the upstream pooler's mode. Transaction
pooling can reassign server sessions between transactions; it does not inherently
move statements between backends inside a normal transaction. Session advisory
locks must not be assumed to follow a reassigned client.

To establish actual deployment mode without exposing DATABASE_URL, use a
separately authorized bounded metadata diagnostic on the actual application's
pool, not an unrelated SQL-editor connection. Borrow one client and collect
`pg_backend_pid()`, current/session role and existing settings before/during/after
short read-only transactions, with unconditional rollback/release cleanup.
Repeat modestly across transactions/checkouts without reading application rows,
hostnames, addresses, URLs, passwords or arbitrary settings. Do not acquire a
real worker advisory lock, create temporary objects, or set a persistent marker
as a probe.

A changed server PID across transactions on the SAME uninterrupted client is
evidence of upstream reassignment or reconnection, not proof of a particular
vendor/mode. Stable PIDs are inconclusive: an idle transaction pooler can hand
back the same server every time. Separate checked-out clients naturally can
have different PIDs even with direct connections. Also inspect the provider's
nonsecret deployment/pool-mode configuration or obtain an operator attestation;
combine that control-plane evidence with runtime observations. This candidate
adds no production diagnostic route and makes no claim that those observations
have been collected.

## SECURITY DEFINER source inventory

No checked-in application migration explicitly changes the owner of these
functions. They inherit the creator/deployment identity. The disposable fixture
creates them as `unknown_recovery_backend`, a NOBYPASSRLS table owner. That owner
can bypass its tables' non-FORCE RLS. Actual deployed owner, role inheritance,
default ACLs and CREATE privileges on referenced schemas remain independent
evidence requirements.

The following entries describe explicit checked-in grants, not an exhaustive
live privilege list. In particular, migration 0022 does not revoke service_role
from can-inspect; an earlier grant or upstream role membership can legitimately
leave that role with EXECUTE. The fixture's freshly created service_role has
neither memberships nor earlier grants, so its narrower expected result must
not be mistaken for a required production invariant.

- `public.strata_claim_official_fee_capture()`: migration 0021, EXECUTE to
  service_role, PUBLIC/anon/authenticated revoked, path `public, pg_temp`.
- `public.strata_can_inspect_pending_fee_artifact()`: migration 0022, EXECUTE to
  authenticated, PUBLIC/anon revoked, path `pg_catalog, pg_temp`.
- `public.strata_two_operator_fee_reviews_valid(uuid,uuid,text)`: migration 0024,
  EXECUTE to service_role, PUBLIC/anon/authenticated revoked, path
  `pg_catalog, pg_temp`.
- `public.strata_record_official_fee_provider_result(integer,timestamptz)`:
  migration 0039, EXECUTE to service_role, PUBLIC/anon/authenticated revoked,
  path `public, pg_temp`.
- Four migration-0044 trace functions, `private.strata_v13_begin_trace_scope()`,
  `private.strata_v13_capture_intent()`, `private.strata_v13_capture_event()` and
  `private.strata_v13_capture_transport()`: empty search path;
  PUBLIC/anon/authenticated/service_role EXECUTE revoked.

The two `public, pg_temp` functions refer to their application table with a
schema-qualified name and to `auth.role()` explicitly. Inclusion of public in
a function search path is a conditional review lead, not by itself a proven
injection defect. Evaluate actual schema CREATE privileges, callable object
resolution and function owners before asserting exploitability. Never broaden
EXECUTE to repair a failed test without reviewing the function's capability.

The trace functions are attached triggers. A caller's lack of direct EXECUTE
does not mean the already-installed trigger cannot run when the caller changes
its table. The existing rollback test deliberately checks that real definer
trigger effect while runtime roles lack direct EXECUTE. Production behavior
still depends on the actual trigger/owner/ACL deployment.
