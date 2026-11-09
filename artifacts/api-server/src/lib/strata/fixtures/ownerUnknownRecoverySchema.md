# UNKNOWN recovery application-schema qualification

## What the suite proves

The native suite executes all 46 checked-in `lib/db/drizzle/*.sql` files,
all 15 root `sql/*.sql` migrations, and the continuous-grant search-path
hardening SQL. Files are applied verbatim in the explicit 62-file manifest,
including both distinct `0043` migrations. Each file's SHA-256 is emitted in
the run log. A static test fails if a root migration is added but omitted.

The unchanged canonical runner creates a random, loopback-only disposable
cluster with a credential-stripped environment and external-network fence.
The test verifies both the canonical URL and the actual connection's database,
session user, server address and port before replacing the runner's Drizzle
schema. This replacement is essential: an ORM schema push must not conceal
missing SQL migrations, constraints, triggers or grants.

All application objects come from the SQL sources, not reduced hand-written
trading tables. Migration creation and recovery run as a non-superuser,
non-BYPASSRLS table owner. This models the backend-owner connection documented
in `0000_reviewed_release_schema.sql`. `service_role` is deliberately not used
as that backend: it is explicitly denied credential and worker-lease access
by the reviewed migrations.

Tests cover native FK validation and enabled immediate checks, all seven
table privileges for both browser roles, actual denied reads, RLS state,
owner-role privileges, actual durable KILL and unchanged-ledger settlement,
zero-fill cancellation, immutable execution-trace triggers, missing/deferred/
unvalidated/disabled FK refusal, concurrent new-row insertion and inactive-row
reactivation, audit-failure rollback including trigger outbox, and replay
preserving all financial history. All exchange feeds and RSA keys are fake.

## Explicit limits and existing source debt

This is **checked-in application migration qualification**, not a claim that
the actual production Supabase schema or deployed privileges were inspected.
No live database or provider read was performed.

The checkout omits its original platform schema and deployed migration
history. `ownerUnknownRecoveryPlatform.sql` explicitly models only five
external prerequisite tables: `auth.users`, `vault.secrets`,
`public.financial_accounts`, `private.provider_connections`, and
`private.role_assignments`. It also supplies basic auth-claim functions and
private-schema ACLs. It contains no application/trading tables, real users,
real secrets, Vault decryption, session verification or network functions.
`pgcrypto` is installed locally from the existing native PostgreSQL tooling.

Browser access results assume those documented private-schema ACLs and normal
empty default ACLs. Live role membership, database ownership, default ACLs,
extension versions, auth functions and Data API exposure remain unverified.
The migration journal registers only `0000`; the explicit test manifest is not
a substitute for a separately verified controlled-deployment migration history.

All six recovery-required account FKs already exist in the checked-in SQL and
qualify on PostgreSQL 16. No FK fix or broader permission grant is needed for
the tested chain. Two preexisting private tables from `0017` and `0018`,
`kalshi_owner_pilot_transfers` and `kalshi_owner_shard_allocations`, omit RLS and
explicit table revokes. The test exposes this exact source debt rather than
silently repairing it. They have no browser grants in the modeled platform,
and private-schema access is denied. This is not evidence that arbitrary live
default grants are safe. No production migration or grant change was authored.

Before production readiness, separately verify the real schema/role/ACL
fingerprint and controlled migration history under authorized read-only scope.
Do not infer permission to obtain that evidence, deploy, recover the live
incident, lift a risk freeze, issue orders, or restart execution from this test.

## Run

From `artifacts/api-server`, with the repository's pinned pnpm and PostgreSQL
tools on PATH:

```
node scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerUnknownRecoverySchema.postgres.test.ts
```

The static suite is `src/lib/strata/ownerUnknownRecoverySchema.test.ts` and is
registered by the parent integration in the offline recovery runner. Do not
run either fixture against an ambient or persistent database.
