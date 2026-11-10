# Isolated standing technical renewal experiment

This is a test-only, trusted service-role compatibility experiment. It is not
a production grant recipe, tenant isolation proof, reviewed human approval,
provider proof, or authorization to start a worker or submit an order.

## Execution and current verification limit

From `artifacts/api-server`, use the unchanged canonical runner:

```
node scripts/run-v13-disposable-postgres.mjs src/lib/strata/restrictedStandingRenewal.postgres.test.ts
node --test scripts/restrictedStandingRenewal.contract.test.mjs
```

The runner requires local PostgreSQL and already installed workspace
dependencies, creates its own loopback cluster, strips ambient credentials and
denies external sockets. There is no alternate or connected-database target.
The fixture additionally verifies the exact database, server address, port and
session identity before role/policy DDL. It applies every unmodified migration
in `ownerUnknownRecoveryMigrationManifest.json` through the existing helper.

Native execution was attempted locally on 2026-11-10 and stopped before any
cluster/setup operation: `PostgreSQL binaries required; no connected-database
fallback exists`. Workspace dependencies also are absent. Native PostgreSQL,
bundling, full typecheck, runtime grants and concurrency therefore remain
unverified here. All five dependency-free contract tests passed, including
TypeScript syntax stripping and executable rejection of noncanonical URLs.
They are only supplemental evidence, not a full TypeScript typecheck.

## Permission inventory

The new `restricted_standing_renewal` role is a genuine nonowner LOGIN, with no
memberships, inheritance, superuser, BYPASSRLS, role/database creation or
replication rights. Every real renewal call receives that pool explicitly. The
privileged global singleton is closed before the runtime connection is opened.

The fixture grants schema USAGE on `public`, `private`, `auth`, and table SELECT
plus explicit SELECT RLS policies on the following objects only:

- `public.v13_production_account`, `public.v13_live_money_policy`.
- `private.kalshi_account_worker_lease` and
  `private.strata_emergency_exit_reservations`.
- `private.strata_continuous_execution_grants`,
  `private.strata_standing_execution_reviews`,
  `private.strata_owner_sha_approvals`, and
  `private.strata_continuous_execution_technical_lease`.
- `private.strata_api_fee_standing_delegations`,
  `private.strata_api_fee_standing_models`,
  `private.strata_api_fee_source_grants`,
  `private.strata_api_fee_owner_consents`,
  `private.strata_api_fee_rate_reviews`.
- `auth.users`, `private.role_assignments`.

Native row locking requires UPDATE privilege even where the application only
reads. Lock-only UPDATE columns are account `id`, policy `id`, worker lease
`execution_account_id`, continuous grant `grant_id`, standing review
`release_id`, and owner SHA approval `approval_id`. Each has permissive UPDATE
USING plus restrictive UPDATE WITH CHECK(false). This preserves row visibility
and locks while rejecting mutations, including when another permissive UPDATE
policy is introduced. Immutable BEFORE-row triggers stay enabled and can
reject first with P0001; a denial is not mislabeled as RLS in that case.

Actual technical writes are separate:

- Continuous lease INSERT: `grant_id`, `execution_account_id`, `observed_at`,
  `expires_at`, `evidence_digest`, `fencing_token`, `generation`.
- Continuous lease UPDATE: `observed_at`, `expires_at`, `evidence_digest`,
  `fencing_token`, `generation` only. ON CONFLICT needs these permissions even
  on its first insert path.
- Continuous audit INSERT: `grant_id`, `execution_account_id`, `kind`,
  `evidence_digest`, `reason` only. A restrictive INSERT policy admits only
  `LEASE_RENEWED` / `signed_owned_reconciliation`; human authorization and
  revocation audit kinds are denied. Identity values need no direct sequence
  grant. Runtime audit SELECT/UPDATE/DELETE and nextval/setval remain denied.
- Fee delegation UPDATE: `lease_expires_at` only. Its human scope, confirmation,
  `valid_until`, grant/model references and revocation fields remain unwritable.

No human authority table receives INSERT, table-wide UPDATE or DELETE. No
Vault access, credentials, worker transport, broad sequence/function grants,
default privileges, migration edits or application behavior changes are added.

## Native cases prepared

- Real `renewContinuousTechnicalLease`: insert, current-lease read reuse,
  generation rotation, five-minute bound and matching immutable audit digest.
- Exact missing lock-column, lease INSERT/UPDATE-column, and audit
  INSERT-column permissions fail closed with native SQLSTATE assertions.
- Audit failures are injected after the actual native lease upsert completed.
  Both a new lease and an existing generation/audit history must roll back.
- Direct human issuance/revocation/value changes, real revocation functions,
  role escalation, forged human audit kinds and sequence use are denied.
- Stale fence, changed cash/hash/SHA, invalid/stale synthetic evidence, worker
  heartbeat expiry, kill switch and committed owner/reviewer/SHA revocation
  cannot renew. A fresh valid worker fence requires a new lease generation.
- The real renewal query is paused after acquiring locks; an independent
  fixture writer times out trying to revoke its grant. After renewal finishes,
  committed revocation blocks the next renewal and final eligibility check.
- Real `renewStandingFeeObservationLease`: STEP_11/ORDER_ENTRY, original
  bootstrap expiry, delegation expiry clipping, atomic caller rollback,
  missing technical UPDATE privilege and missing Auth/role SELECT policies.
- Next-observation denial after model/delegation/grant/consent/rate-review
  revocation, issuer/reviewer role loss, reviewer email confirmation loss,
  policy hash drift or deployed SHA drift.
- Full human approval row snapshots are compared before/after the real
  successful renewals. Only delegation `lease_expires_at` is excluded from
  the human snapshot because it is explicitly technical state.

## Boundaries and remaining gaps

The platform fixture is source-qualified, not a production schema export.
`auth.users` is its existing three-column stub; enabling Auth RLS here is an
explicit synthetic addition. `private.role_assignments` already has source
RLS. New policies are test-only. `public.profiles` remains absent and neither
narrow renewal function queries it. This does not qualify the successor
protective verifier's profile locks, real Auth ownership/policies, JWT/MFA,
Vault owner-rights views/decrypt helpers, pooler session/transaction behavior,
network/provider verification, or a live supervisor's full dependency graph.

The role intentionally represents trusted backend code, not hostile arbitrary
SQL. Column grants cannot prove that every admitted technical write came from
the two renewal functions, or bind synthetic provider evidence to a real
signed exchange response. In particular a writer with `lease_expires_at`
UPDATE can change that technical field directly within the existing table
constraints. Reducing that trust would require separately designed database
interfaces/policies and review; this test adds none to application migrations.

Changes are limited to tests, fixtures, documentation and package-test
integration. Publishing or executing these tests does not authorize production
SQL, operational grants, secrets, activation, orders or deployment.
