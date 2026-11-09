# Metadata-only API database session observation

`GET /api/strata/me/fees/runtime-db-session-attestation` is additive. The existing
`/fees/runtime-db-attestation` remains unchanged and still includes an account
fingerprint; do **not** use that older endpoint under a no-account-scan constraint.

The new route requires the existing verified AAL2 user middleware, then rechecks
confirmed ADMIN using the same `auth.users` / `private.role_assignments` predicate
as the older endpoint. The auth middleware retains its existing role lookup.
Only that authentication/authorization work reads application rows. The observation
uses fixed PostgreSQL catalog/ACL functions, not account data, fingerprints,
credential contents, connection strings, network addresses, grants or writes.
Success and failures have `Cache-Control: private, no-store`.

One checked-out API pool connection performs the ADMIN check and metadata query.
The response allowlists current_user, session_user, search_path,
session_replication_role, row_security, current-role superuser/BYPASSRLS flags,
private-schema USAGE, and existence plus individual SELECT/INSERT/UPDATE ACL flags
for exactly these relations:

- public.v13_production_account
- public.v13_production_intent
- public.v13_production_position
- public.v13_production_event
- private.kalshi_account_worker_lease
- private.strata_emergency_exit_reservations
- private.strata_protective_exit_release
- private.strata_owner_sha_approvals

These are observations, not approval, actual row access tests, or proof of
isolation. RLS, triggers and other constraints can still prevent operations.
Missing relations produce exists=false and false privileges when name resolution
is possible; schema/name resolution errors fail closed. No effective permission
is changed. All policy/commissioning/trading authorization flags remain false.
It identifies the sampled API checkout, not every connection in the pool or an
independently verified database deployment. Role authorization can change after
the check; no locks or transaction/session settings are introduced.

Each query uses node-postgres's 3-second client query timeout. A query error
(including timeout) destroys the checked-out connection instead of returning a
possibly busy connection to the pool. This bounds the client query wait, not a
server-side statement execution deadline. Acquisition uses the existing pool's
10-second connection timeout. No SET, SET LOCAL or connection options are changed.
No credentials, errors or unrecognized output fields are returned. Metadata types
and bounded strings are validated before publication.

Offline tests (requires installed workspace dependencies):

    DATABASE_URL=postgres://invalid:invalid@127.0.0.1:1/offline pnpm --filter @workspace/api-server test:runtime-db-session

Tests use fake pool checkouts, real locally signed JWT verification and local HTTP.
They do not connect to PostgreSQL or attest production. Real PostgreSQL and
production endpoint validation remain separate, explicitly authorized steps.
