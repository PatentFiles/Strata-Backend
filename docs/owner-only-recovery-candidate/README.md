# Owner-only recovery runtime candidate (inactive)

This draft publishes actual application source separately from the protected
qualification tooling. It does not merge, deploy, apply SQL, clear account risk
blocks, issue genuine evidence or enable live trading.

## Included

Owner AAL2/current-session consent, held consent and provider credential guards,
scoped readback, bounded signed-history reconciliation, disarmed atomic recovery,
and a separately typed one-use machine-authority consumer. The owner route is an
explicit fail-closed admission boundary; it is not an independent-review request.
The issuer deliberately remains unavailable until authentic protected evidence
and deployed-role/writer qualification exist. Disposable atomic authority seeds
and fake provider responses in tests are not genuine evidence.

All SQL in this directory is an unapplied candidate, not a startup migration.
Some files are alternative/partial proposals: do not execute this directory as a
migration sequence. Production grants, schema integration and cutover must be
qualified together. No reviewer identity is invented or required by these
owner-only candidate modules; separate existing unrelated release policies are
not silently removed by this draft.

## Reproduce focused checks

With repository dependencies installed using the pinned pnpm version and native
PostgreSQL available, run from the repository root:

```
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
bash artifacts/api-server/scripts/run-owner-only-candidate.sh
```

The runner always creates a fresh loopback-only database on port 55461. A busy
port, missing PostgreSQL or failed setup stops the run; no existing/production
DB fallback exists. It does not persist or delete another cluster. Set PG_BIN_DIR
only to an installed trusted PostgreSQL binary directory when pg_config is not
on PATH. OWNER_RECOVERY_SOURCE_ROOT is set by this runner for portable fixtures.

Local exact-stage results: 35 native atomic/rollback/credential/role/lifecycle
cases; 9 synthetic-provider adapter tests; 6 authenticated admission tests. Full
API typecheck passed after building library declarations. Additional ledger
regression checks are recorded separately. These are focused tests, not a claim
that full remote required CI or production qualification has passed.

## Genuine remaining blockers

The present artifact resolver only binds consent and does not verify deployed
bytes. Need the protected qualification run for final source/test policy,
externally adopted server trust pins, actual authenticated artifact/run identity,
qualified deployed roles/barriers and signed current account reconciliation.
Until then production recovery unconditionally refuses. Do not replace those
facts with request flags, local fixtures or a user report that an account is flat.

A successful eventual recovery must leave execution disabled. Owner START is a
separate action, not a side effect of approving recovery.

## Server composition and explicit schema candidate

`createProtectiveReleaseRouter(requireUser, ownerRecovery?)` now composes the
existing owner consent and outcome/held-inspection paths at `/owner-only` when
server bootstrap supplies `OwnerRecoveryRuntimeDependencies`. The existing user
middleware remains first. Without those dependencies, every subpath returns 503
without DB/provider access. Dependencies are not request fields or a public
qualification flag. This does **not** wire production atomic release or START.
The server bootstrap still must supply genuine protected machine binding and
separately bounded account/session pools before these consent-only paths operate.

`lib/db/owner-only-candidate/001_owner_recovery_evidence.sql` is an explicit,
transactional schema candidate, deliberately outside the automatic migration
journal. It packages consent, machine authority and immutable release receipt
storage. It refuses if the control-head and lease-epoch prerequisites are absent,
grants nobody issuer/consumer rights, and does not install or qualify writer
barriers. Reapplication refuses rather than hiding schema drift. Do not treat
creating these tables as evidence of trusted issuer or runtime role qualification.

Run `scripts/test-owner-recovery-migration.sh` from any working directory with
`PG_BIN_DIR` pointing to native PostgreSQL tools. This uses a fresh disposable
localhost cluster on port 55462 and tests prerequisite rollback, schema creation,
absence of public authority, receipt/authority truncate rejection, and duplicate
migration refusal. It never uses an ambient database URL.

## Production transaction composition (not configured or deployed)

`recoverOwnerAtomicallyCandidate` now has a production composition. It accepts
only token, accountId and requestId, authenticates the owner, loads durable consent
scope, then uses the same atomic account-held transaction with real signed
snapshot/credential readers and machine-store authority consumption. No fixture
transport or synthetic authority selector is exposed by this production entry.
It rechecks the actual approved policy and commissioned credential. Release stays
DISARMED with execution disabled; COMMIT uncertainty requires historical readback.

`assembleOwnerRecoveryRuntime` supplies the existing router's optional server
configuration, including a separately bounded session pool. It requires a
server-installed `verifyLockedQualification(tx, scope, phase)` verifier, called at
`lock`, `before_release`, and `before_commit`. That verifier must authenticate the
protected source/deployment and actual role/barrier proof; the last phase must
account for the transaction's own expected lease changes while rechecking trust
freshness. A callback that merely returns, owner consent, the Ed25519 signing
primitive alone, or a configuration boolean is **not** a valid production verifier.
No such genuine verifier is installed by this patch. Missing configuration fails
before a DB connection. `/owner-only/recover` accepts only `{accountId,requestId}`.

Tests exercise successful atomic release using explicitly synthetic disposable
fixtures, plus production-boundary refusal before provider access when genuine
qualification is absent. They do not prove genuine production identity, role
coverage, deployed bytes, or a successful production recovery.

The main Strata router now forwards its server-only `ownerRecovery` dependency.
`createConfiguredStrataRouter` can receive the assembled configuration; its default
export remains unconfigured, not silently enabled by an environment switch.
`bootstrapOwnerRecoveryRuntime` constructs dedicated explicit account/session pools
with one connection each, 1-second checkout and bounded statements. The session
pool defaults to read-only transactions. Remote URLs require verifying TLS modes;
no production credentials, grants or config values are created. Actual database
privileges and same-barrier writer coverage still require authentic qualification,
not merely pool construction or matching usernames.

## Automatic issuer-to-recovery orchestration

With the protected issuer configured, the existing `/owner-only/recover` request
now stages authority using a dedicated issuer pool, commits it, and only after an
acknowledged COMMIT invokes the separately privileged recovery consumer. The owner
need not manually issue evidence. Current owner session and exact durable consent
are verified under locks; request JSON supplies no proof, signer or role config.
The issuer callback is the protected verifier-backed stage implementation, not a
consent-only signature. Bootstrap rejects partial issuer config/shared pool roles.

Issuer-stage failure rolls back/destroys the transaction and never reaches
recovery. An unknown issuer COMMIT acknowledgment returns `issuer_outcome_unknown`,
`released:null`, `readbackRequired:true`, `retryAuthorized:false`; it is not retried
and no recovery is initiated. Existing outcome readback must not label missing
release evidence as proof that issuance failed. Atomic recovery still separately
verifies genuine qualification, provider history and unexpired one-use authority.

Native tests use an explicitly simulated issuer stage to verify rollback,
acknowledged handoff, and lost-COMMIT acknowledgment. They prove orchestration, not
production signing, deployment identity, or live release authority. The authentic
issuer/verifier/roles remain unconfigured in the default server installation.
