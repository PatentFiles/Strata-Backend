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
