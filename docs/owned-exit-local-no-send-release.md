# Owned protective-exit local non-submission release

## Scope and invariants
This fixes the **owned** worker route (`dispatchReviewedProtectiveExitOnce`), not the generic executor EXIT fallback. Existing reservation freshness (8 seconds) and worker heartbeat freshness (5 seconds) are enforced after final COMMIT, signing and serialization, immediately before raw HTTP. Database-relative ages plus monotonic elapsed avoid assuming application and database wall clocks are synchronized. Subtracting the entire SQL round trip is deliberately conservative. No entry signal, entry grant or champion reference check is added to protective exits.

The immutable UNKNOWN marker still precedes any possible POST. Only the same live invocation can mint a private, one-use local non-submission proof: an explicitly rejected or thrown second read-only fee observation, or the synchronous final clock refusal before raw transport. The proof is not supplied by an API, exception string, database field, or provider response. Any actual transport invocation remains uncertain until authenticated exchange reconciliation. Crash/ambiguous final-fence COMMIT and other unsupported pre-send failures remain UNKNOWN, not assumed absent.

A local proof consumes no trading approval. Under account/current-lease/reservation/financial-intent locks it appends a private immutable audit, marks the exact zero-fill never-sent financial EXIT `BLOCKED`, and transitions its private reservation `UNKNOWN→VOID`. Parent entry cash, exit-fee reserves and owned exposure remain unchanged. The original client order ID is permanently non-replayable. A new signed reconciliation and fresh protective-exit preparation use a **new** identity. Entry authorization is not renewed. An acknowledged local terminal result is privately branded with exact owner/account/reservation scope; only that original result object may avoid the supervisor's sticky failure latch. The production `reconcileOwnedProtectiveExitOutcome` helper is used by both the supervisor and the composed lifecycle regression; tests do not mirror its acceptance branch. It still requires signed reconciliation, and the technical gate stays closed while exposure remains or any approval/readiness gate is invalid. Forged/copied results and UNKNOWN/lost-acknowledgement outcomes retain the sticky safety hold.

## Mandatory deployment ordering
1. Complete independent code, migration and CI review on one exact release. Keep trading disarmed; do not apply this migration to work around a running unresolved order.
2. Through the existing controlled migration process, apply `sql/strata_protective_exit_local_no_send.sql` **before** deploying this runtime. It requires the existing private reservation schema, financial account/intent/position tables and private worker lease schema.
3. Verify the private audit table has RLS enabled, no public/anon/authenticated grants, its insert/update/delete guard is present, and the reservation guard allows `UNKNOWN→VOID` only with matching immutable local proof and a terminal blocked zero-fill intent. Preserve `UNKNOWN→RECONCILED` exclusively for exchange reconciliation without contradictory local proof.
4. Deploy the exact reviewed runtime while disarmed. Exercise the controlled read-only/qualification process before changing trading authorizations. No migration or test here turns on trading.

Missing migration fails closed: a local refusal stays UNKNOWN if its audit/terminalization cannot commit. Therefore deploying code first is **not** an acceptable self-recovery rollout.

## Rollback and crash behavior
- Do not delete local proof rows or rewrite VOID/BLOCKED outcomes. They are permanent non-replay evidence.
- Older runtime may coexist with the additive table/guard but does not provide the freshness/liveness fix. Roll back code only under the controlled disarmed process; retain audited schema and terminal history.
- Do not revert the reservation trigger while the new runtime may execute. Do not fake an exchange RECONCILED record to clear a local no-send.
- If the local finalization COMMIT acknowledgement is lost, the caller returns UNKNOWN and never retries the old POST or finalizer. Independent state reads may show the transaction actually committed (VOID/BLOCKED); the normal next reconciliation can then prepare a new identity. If the transaction did not commit, UNKNOWN remains and requires existing recovery/operator review.
- A crash after the durable UNKNOWN marker but before a private live proof exists remains UNKNOWN. Absence of exchange order history alone is not treated as proof of non-submission. These conservative manual-review cases are not claimed to be automatically solved.

## Local regression commands
From `artifacts/api-server`, with installed PostgreSQL binaries on PATH:

```
node scripts/run-v13-disposable-postgres.mjs src/lib/v13-production/acceptance.test.ts
```

The isolated PostgreSQL suite covers real migrations, RLS and trigger denials, request/proof mismatches, lease row-lock serialization, preserved cash/exposure, fresh exit identity, and lost acknowledgement after actual finalizer COMMIT. The signed-dispatch unit suite covers deadline boundaries, invalid/regressed clocks, raw-signing expiry, partial finalizer failure, lease changes, repeat calls and actual transport ambiguity. The general diagnostics CI already watches `sql/**` and runs the production acceptance suite.

No production mutation, authenticated live fill or profitability is established by these tests.

## Generic fallback scope
The synthetic generic executor EXIT delay reproduction is not a reachable current LIVE worker path. `consumeOwnedPosition` requires the reviewed protective dispatcher for every LIVE worker and throws if it is absent; only simulation reaches the generic executor fallback. A regression now exercises this runtime branch and continued protective processing while entry authorization is held. No legacy transport was silently disabled or presented as repaired.
