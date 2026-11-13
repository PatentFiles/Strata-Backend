---
name: Drizzle constraint and index sync
description: Development schema pushes may not replace modified PostgreSQL CHECK or index definitions.
---

After changing a CHECK constraint or the predicate of an existing partial index in the Drizzle schema, inspect the development database's actual definition before relying on the publish diff. A successful development push, including "No changes detected," is not sufficient evidence that the old definition was replaced.

**Why:** A push applied table removals and a changed column default but left an older mode CHECK in place; an isolated safety test caught that the previously permitted mode was still accepted. A later partial-unique-index predicate change was also undetected by a push and blocked a legitimate canceled-exit retry.

**How to apply:** Read the development CHECK definition or pg_indexes.indexdef and the pending development-to-production diff after these changes. Reconcile only the development schema if necessary; never use a manual production DDL workaround.

Drizzle's CLI can print a snapshot serialization error and still exit zero.
Do not treat that exit alone as successful schema setup, including on a new
disposable database.

**Why:** BigInt literal defaults caused JSON snapshot serialization to fail
while the CLI reported a successful exit. SQL-expression defaults avoided the
serialization issue, but actual catalog/constraint tests were needed to prove DDL.

**How to apply:** After schema tooling, verify actual tables and constraints
before claiming a database-backed acceptance pass. Keep such setup isolated from
connected runtime databases when runtime writes are not authorized.

Temporary PostgreSQL initialization can stall while synchronizing the initial
file tree on this environment's filesystem. This setup cost is separate from
transaction durability.

**Why:** Disposable-cluster initialization exceeded a 90-second timeout at its
initial sync step despite the acceptance queries themselves taking seconds.

**How to apply:** Skipping initial cluster-tree sync is acceptable for disposable
tests, but do not disable PostgreSQL runtime fsync or synchronous_commit to make
financial tests faster. Assert both runtime settings ON in the fixtures.