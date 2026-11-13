# Commissioning-repair source validation — runtime unchanged

This separate proposal is PR #2, branch `review/v13-commissioning-repair`.
The exact reviewed revision is the final PR head and its matching CI run.
It is not part of PR #1's production-engine source.

## Actual adapter verification

`v13CommissioningRepair.postgres.test.ts` imports the real Drizzle adapter,
uses real PostgreSQL tables/constraints and its actual SERIALIZABLE transaction
and writes. It substitutes the authenticated account proof and saved-key
identity ONLY in an explicitly verified disposable test context:

- NODE_ENV must be `test`.
- DATABASE_URL must equal the explicitly supplied disposable URL.
- The URL must name `v13_test` on `127.0.0.1`, with a `v13_disposable_<digits>` database.
- The actual connection must report that exact disposable database family and loopback server.
- The guard is checked before reads and again on the transactional connection
  before writes. Runtime fsync and synchronous_commit are asserted ON.
- The final independent identity/freshness predicate still executes.

The normal CLI has no injection argument. Its development destination pins,
real saved-key identity, signed account authentication, table/row locks, flags,
field allowlist and historical archive interlocks remain in force.

Six adapter cases cover:

1. Actual successful repair populates all 17 linkage fields, preserves frozen/
   execution-off flags, original caps/limits and the immutable historical archive.
2. A second identical call reports already-reconciled and changes no rows.
3. Injected failures after prior archive, singleton, boundary and successor
   archive writes roll back every table exactly.
4. Dry-run and failed authentication are read-only; real CHECK constraints
   reject incomplete funding or boundary initialization.
5. Concurrent repairs produce one successor/archive pair; serialization
   losers cannot commit duplicate successors and later retry is idempotent.
6. Non-test context and changed final key identity cannot bypass the guards.

The 21 pure transition/CLI tests remain included separately. Existing strategy,
planning, fee, authorization and micro-live recovery safety suites remain in
the aggregate, with the actual adapter suite appended.

## Safe reproduction

From `artifacts/api-server`:

```sh
node scripts/run-v13-disposable-postgres.mjs
node scripts/run-v13-disposable-postgres.mjs --full-suite
```

The runner creates a new temporary PostgreSQL cluster with credential-stripped
children and never reads the ambient connected database URL or Kalshi secrets.
Schema setup and all writes are restricted to that cluster, which is stopped
and removed afterward. Initial file-tree sync is skipped for temporary-filesystem
performance; runtime WAL durability is not disabled.
Full-suite mode requires unused local port 5432 and exercises the existing
postgres/v13_ci CI pin; run branches sequentially. Missing binaries or an
occupied port cause failure, never a fallback to a connected database.

## What this does NOT establish

Authentication/key identity is simulated in these tests. They do not prove
current Kalshi cash, history, permissions, exclusive control, fee approval,
account readiness, or operator authorization. Failure injection throws within
the application transaction; it is not an operating-system power-loss test.

No development/production repair was applied. No runtime schema, selector,
credential, funding record, policy approval, arming or execution flag was changed.
Main and the running workflows were not switched to this branch.
Any real repair still requires exact-revision independent review and separate
owner authorization; a passing test does not grant it.
