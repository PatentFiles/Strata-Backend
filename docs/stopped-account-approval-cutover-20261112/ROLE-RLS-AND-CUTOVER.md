# Read-only role verification and cutover analysis

## Verified during this run
Three small catalog-only queries on the specified Supabase project read seven named
relations, four standard roles, private-schema/default ACLs and effective privileges.
No account rows, credentials, trading telemetry, provider data or controls were read
or changed. No denied monitoring/security action was retried.

- Connector session is postgres; this is NOT proof of Railway backend session identity.
- Existing private owner approvals and qualification tables: owner postgres, RLS on,
  FORCE RLS off, no row policies, ACL only postgres.
- Private schema: owner postgres; USAGE/CREATE only postgres.
- Effective privileges: anon/authenticated/service_role have no private schema usage
  or SELECT/INSERT/UPDATE on owner approvals; postgres has each. service_role BYPASSRLS
  does not bypass missing SQL grants/schema access.
- postgres is nonsuperuser with BYPASSRLS; service_role also BYPASSRLS.
  anon/authenticated are nonsuperuser, no BYPASSRLS.
- Named public account/policy/observation tables grant postgres and service_role;
  RLS on, FORCE off. Default ACL entries observed apply only to public, not private.
- Candidate consent tables are absent, as expected: no migration was applied.

Current Supabase RLS documentation was consulted. Changelog inspected; recent CLI
v3/local-default and PostgreSQL upgrade notices do not justify changing this project's
roles or RLS. No CLI upgrade or schema operation performed against Supabase.
https://supabase.com/changelog.md
https://supabase.com/docs/guides/database/postgres/row-level-security.md

## Local role-model replay
role-validation/isolated-role-test.sql mirrors observed permissions using invented local
role names. On disposable PG16, a nonsuperuser owner with BYPASSRLS created the schema,
applied candidate migration, inserted a qualified/bound receipt, advanced generation
and revoked it through actual triggers. Anon/authenticated analogues and even a
BYPASSRLS service analogue without private grants were denied private read and write.
The local server was stopped. This validates the observed permission model and candidate
SQL under that model, NOT production runtime identity or applied production schema.

## Precise remaining identity prerequisite
Need verified role used by actual deployed Railway pool, without exposing connection
credentials. Source reads DATABASE_URL but does not prove its deployed username.
Do not infer it from connector current_user or silently grant broad privilege to make
it work. If runtime role differs from postgres, its least-privilege access/RLS must be
reviewed and tested explicitly. No production GRANT/ALTER ROLE/RLS changes authorized here.

## Quiescent cutover plan, NOT performed
1. Freeze reviewed artifacts and exact source hashes; independent signoff must include
   four complete policy migration tests, schema ownership and actual runtime role.
2. Obtain an approved maintenance/cutover window and establish safe financial state
   through separately authorized evidence. Never disable protection for open exposure.
3. Operator must exclude new qualification/approval/revoke/policy/provisioning requests
   across every old instance and drain in-flight writers. A UI banner, local supervisor
   flag or one quiet request is not evidence of complete quiescence.
4. Verify no old-version writer can resume. Old zero-row revocation is invisible to
   row triggers. Rolling mixed-version availability is therefore not supported.
5. Apply reviewed schema atomically as intended owner, while quiescent. Epoch1 seed
   invalidates pre-cutover unbound qualification, not historical approvals or owner
   control intent. Existing proof records and tombstones must not be deleted.
6. Install coordinated backend and frontend; verify exact deployed artifacts, owner
   role/grants/RLS, trigger presence and migration completion with bounded read-only
   checks before restoring traffic. No automatic code receipt or trading action.
7. Reopen only after compatible writers are confirmed. Fresh post-cutover qualification
   is required where a new receipt is needed. Existing release, fee, standing review,
   genuine owner enablement and START gates remain separate and authoritative.
8. Rollback must preserve consent generations, revocations and audit. Never drop the
   new guards or reset heads to accommodate old code. Keep writes quiesced and use a
   reviewed compatible rollback/forward fix; no old mixed-version writer resurrection.

This is a release-wide availability change, including provisioning/new accounts, not
just a hidden checkbox repair for one account. No operational quiescence, deployment,
role identity verification or successful live START is claimed by this document.

## Follow-up: source-only identity path and operational feasibility
Pinned backend 48783da92ffc979dae6df4e01638399e9d6841a3 already includes
apiFeeRuntimeDbSession.ts (Git blob273bf4a082ef43d07bbdbed12b37ee3fecec4465)
and userExecutionRouter.ts (blob e75b5b3068d09b914a692dc8696924c0f73b185f).
Both inspected files match the pinned tree. Existing GET
/me/fees/runtime-db-session-attestation (relative to Strata router) uses AAL2
requireUser plus confirmed ADMIN lookup, then current_user and session_user on
that same API pool checkout. It returns bounded catalog/ACL data, not credentials;
queries have 3000ms client timeouts and errors destroy the checkout. Source proves
a suitable mechanism exists, NOT the current runtime result. The endpoint was NOT
called: prior denied monitoring scope is unresolved, so this is not an alternate
route around that denial. No variables/secrets, runtime logs, traces or database
activity were fetched during this follow-up.

Source inventory confirms the seven approval DML sites in two insertion modules
(ownerNeverPostedReleaseRenewal, ownerShaRelease) and five revocation modules
(ownerShaRelease, ownerFeeV3Migration, ownerApiFeePolicyMigration,
ownerV4CommissioningRepair, ownerStakePolicyAmendment). This is a repository
inventory, not an external-writer inventory. It cannot identify other Railway
services, old deployments, operator SQL, database functions/triggers outside the
checkout, SQL jobs, Supabase Edge functions, CI jobs or another repository holding
credentials. The earlier four-role ACL check does not enumerate every database
role/member or prove no privileged external writer exists.

Entrypoint app.listen does not retain the server handle, and inspected production
entrypoint/router source contains no SIGTERM/SIGINT server.close handler or
whole-request admission/drain barrier. Startup prints a one-instance requirement,
but a log statement is not enforcement of deployment replicas or old-instance
exclusion. Background workers are started from the same entrypoint. Consequently,
ordinary rolling deploy and nominal shutdown grace cannot be certified as safe
quiescence from source. A separately approved operator maintenance procedure must
prove both traffic exclusion and process/job exclusion before applying this migration,
with financial safety established separately. Do not stop a service carrying active
protective duties merely to satisfy migration convenience.

Conclusion: cutover is feasible only with operational evidence not available from
this source pass. There is no honest source-only shortcut to attest actual runtime
identity or absence of external writers. No production operation was attempted.
