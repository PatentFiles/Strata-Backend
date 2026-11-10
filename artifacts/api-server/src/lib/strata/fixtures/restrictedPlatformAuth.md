# Isolated Auth/profile successor-authority experiment

Test-only candidate based on merged PR #324, commit
`16e038e0d9d54ebf3784464373ab547276560af6`, tree
`62d405dcb54c6e4a0dbce1b986b2f25fae353663`. This is not a production grant
recipe, real human approval, tenant isolation proof, provider verification,
credential cutover or authorization to start a worker or place orders.

## Execution and verification status

From `artifacts/api-server`, with local PostgreSQL and already installed
workspace dependencies:

```
node --test scripts/restrictedPlatformAuth.contract.test.mjs
node scripts/run-v13-disposable-postgres.mjs src/lib/strata/restrictedPlatformAuth.postgres.test.ts
```

Use the unchanged canonical runner, with no flags or environment overrides.
It creates a new loopback-only cluster, strips ambient credentials, denies
external sockets, and has no connected-database fallback. The fixture checks
both the canonical URL and actual database, session user, address and port
before role/grant/policy setup. It installs the unmodified complete migration
manifest through the existing full-schema helper. Later capability setup
rechecks the actual bootstrap connection. No production query is part of this
suite, and no credentials or extension installations are required.

On 2026-11-10, all **six dependency-free contracts passed**. These include
TypeScript syntax stripping, executable invalid-target rejection and source
checks. Native execution was attempted and stopped before cluster or fixture
setup with: `PostgreSQL binaries required; no connected-database fallback
exists`. Workspace dependencies are also absent. SQL, ACL/RLS behavior,
concurrency, bundling and full TypeScript typechecking remain **unverified**.
Source contracts are not substitutes for those checks. No alternate database,
installation or weaker runner was used.

## Observed metadata versus explicit synthetic additions

The shape is informed by bounded metadata collected on 2026-11-10, not Auth,
profile or application rows, managed helper bodies, production credentials or
JWTs. Only the narrow relevant contracts are represented:

- `auth.users` retains the source fixture's three columns, but now belongs to
  a distinct synthetic managed owner, has enabled/unforced RLS and initially
  has zero policies. The application migration owner is separate.
- `private.role_assignments` remains migration-owned, RLS-enabled with zero
  initial policies, and contains synthetic email/role pairs only.
- `public.profiles` is a new minimal `id,role` stub, migration-owned with
  enabled/unforced RLS. The two observed authenticated-only permissive policy
  shapes are present: own-profile SELECT with AAL2 or both MFA exemptions;
  own-profile UPDATE with AAL2. Authenticated receives **SELECT only**. The
  UPDATE policy does not confer an UPDATE ACL or role-promotion capability.
- Minimal `mfa_login_policy` and `mfa_user_preferences` stubs supply those
  predicates. Their SELECT grants and absence of RLS are synthetic dependency
  scaffolding because the upstream MFA tables' ACL/RLS were not inspected.
- `auth.uid()` and `auth.role()` retain the existing simplified GUC helpers.
  A new simplified `auth.jwt()` reads a JSON GUC. All are stable SQL invoker
  functions owned by the synthetic managed owner with PUBLIC EXECUTE.
  **Caller-writable GUCs are not authentication.** No signature, session,
  issuer, audience, expiry, MFA ceremony or real Auth-helper parsing is tested.

The fixture does not reproduce the full Supabase managed schema or every ACL,
role, helper, constraint or platform version. Real JWT verification remains in
the application's separate authentication implementation and tests.

## Two stages and the lock-only capability inventory

Initially the runtime has only schema USAGE. Native tests first establish
missing-SELECT errors, then default-deny row visibility after adding SELECT
without runtime policies. Forged AAL2/subject GUCs still do not make the runtime
an authenticated browser role or expose reviewer profiles. Browser-policy
probes use bootstrap-only `SET LOCAL ROLE authenticated`, never a worker call.

Only after these tests does an explicitly synthetic capability phase add
runtime SELECT policies and column UPDATE lock privileges to the exact union
of relations locked by the real `REVIEW_SQL` and `SUCCESSOR_SQL`:

- Account `id` and live-money policy `id`.
- Source grant `grant_id`, rate review `review_id`, owner consent `consent_id`.
- Standing delegation `delegation_id`, standing model `model_id`, standing
  execution review `release_id`.
- Auth user `id`, role assignment `email`, reviewer profile `id`.

Each receives permissive UPDATE visibility plus a restrictive UPDATE
`WITH CHECK(false)`. This is intended to admit row locks but reject mutations,
including no-op changes and the introduction of another permissive policy.
Native tests distinguish errors from silently invisible rows and demonstrate
the unsafe counterexample when that restrictive guard is temporarily removed
inside the disposable experiment. An unforced owner-bypass counterexample is
also included; the runtime therefore must not own these relations.

No table-wide UPDATE, INSERT, DELETE, sequence privileges, credential access,
technical lease writes or continuous-entry/owner-SHA approval reads are added.
The two latter human authority tables remain completely unavailable to this
runtime. Existing immutable triggers are not disabled. A trigger may deny
first with P0001; that is not described as a 42501 RLS denial.

`restricted_platform_auth` and the unrelated test role are genuine restricted
LOGINs with no memberships, inheritance, owned relations, superuser,
BYPASSRLS, role/database creation or replication privileges. RESET ROLE leaves
the original restricted session identity intact. SET ROLE and SET SESSION
AUTHORIZATION escalation attempts are covered. The unused privileged global
pool is closed before restricted runtime calls, and each application helper
receives the actual restricted pool or checked-out client explicitly.

These SELECT policies intentionally represent trusted backend visibility
across synthetic rows. They do not enforce per-owner or per-reviewer read
isolation, and are not recommendations for managed Auth tables.

## Actual application paths and prepared native cases

The suite invokes `verifyReviewedProtectiveExitFeeAuthority`, not a rewritten
SQL approximation. Transparent observation confirms the unmodified
`REVIEW_SQL` and `SUCCESSOR_SQL` reached the native driver. The confirmed-ADMIN
session inspection helper also runs through the restricted pool. One call to
`verifyReviewedProtectiveExitFee` injects explicitly synthetic fee metadata
only; it performs no provider GET and does not qualify provider proof.

The synthetic authority seed is adapted from the existing standing-renewal
fixture, with unique SHA per case to avoid cross-case competing-model matches.
Its delegation validity is 23 hours, below the 24-hour model validity. Its
original source grant is expired while the legacy rate review is still valid,
so a failed standing successor must not silently revert to legacy authority.

Prepared cases cover:

- Exact role identities and missing ACL, SELECT-policy and UPDATE-policy
  differences, with native SQLSTATE assertions and no simulated DB results.
- Own-profile AAL1/AAL2 and MFA exemption predicates, other-profile hiding and
  id/role UPDATE denial despite the authenticated UPDATE policy.
- Real standing-successor success, unchanged human approval snapshots, and
  read-only proof flags that never authorize a policy or trade.
- Every required lock column's independent revocation, missing Auth/profile
  reads, no-op and changed human approvals, and denied issuance/deletion.
- Unconfirmed issuer/model reviewer, ordinary or missing role assignments,
  ordinary or missing reviewer profile, each relevant committed revocation,
  and competing same-SHA models. DEVELOPER profile remains accepted where the
  actual SQL permits it, while the separate ADMIN assignment remains required.
- A caller-owned native transaction retaining the actual verifier's SHARE
  locks. Independent setup writers time out with 55P03 when attempting Auth
  confirmation loss, role/profile loss or standing model/delegation/review
  revocation. After rollback releases the locks, committing each change makes
  the next verification fail closed.

The verifier's row locks are not a general serializable/predicate guarantee.
For example, a new competing model can be inserted after a snapshot without
updating a row already locked; this suite checks the next observation's
competing-model denial, not a range-lock or phantom-prevention guarantee.
No network call is made while these lock probes hold a transaction.

## Remaining qualification

Independent review and execution on the unchanged native disposable runner
are required before claiming SQL/ACL/RLS or concurrency success. This local
candidate changes no application logic, production migration, managed grant,
authentication behavior, provider path or deployment. It cannot establish the
production API role, the actual upstream pooling mode, the full supervisor
fallback graph, or real platform JWT/MFA behavior. The separate Vault fixture
covers a different synthetic structural experiment, not cryptographic parity.
