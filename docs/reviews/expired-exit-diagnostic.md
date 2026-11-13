# Expired exit history diagnostic correction

The owner signed-exchange diagnostic previously excluded validated never-posted entry intents but counted expired, never-posted exit intents as expected exchange orders. An otherwise reconciled account could therefore fail the history count comparison before exposure was evaluated.

This change opts the read-only diagnostic into strict validation of receipts emitted by `recoverPreparedOwnedExitIntents`. The shared helper's default and authorization-renewal callers remain entry-only. No trading, ledger reconciliation, permission, deployment or approval path is enabled or modified.

An exit is excluded only with exactly one matching digest-valid `PROVEN_NOT_POSTED` receipt for `production_prepared_exit_expired`, an intact immutable request capability, terminal zero-fill/zero-reservation state, no dispatch/order/cancel evidence, a consistent filled parent, supported reduce-only IOC quantity encoding, and source/expiry/owned-quantity evidence. A referenced reservation must be uniquely matched, VOID, non-authorizing, owner/account scoped, and bind the exact provider request and digest. A receipt claiming no reservation requires that no marker exists. Missing or contradictory evidence fails closed. The existing signed provider contradiction check and complete archive requirement remain in force; final history fencing now includes marker revisions.

Remaining inventory must be positive and bounded by the parent fill, but need not cover the original exit request: a partial reduction after preparation is accepted by the recovery producer. This is no-send evidence, not authorization to execute that request.

The existing entry validation remains intact. Diagnostic-only observation reads additionally detect cancellation evidence. No provider rows are discarded from mapping. Remaining history mismatches, fills, cash, positions, nonterminal orders, final hold revisions, and the 45-second freshness bound still apply. Successful diagnostics continue to report `tradingAuthorized:false`, `liveEligible:false`, `ordersSubmitted:false`, and `recordPersisted:false`.

## Validation

All added fixtures are synthetic. The new suite exercises the actual history helper, validator, signed diagnostic, mapper and flatness predicate using read-only database ports and synthetic provider responses. It covers whole/fractional exits, YES/NO price mapping, optional VOID markers, missing/duplicate/corrupt/foreign evidence, send/cancel contradictions, financial events, source expiry, parent ownership, marker changes, provider contradictions, incomplete archives, retained history mismatches and current exposure. It also checks unchanged entry exclusion and the default renewal contract.

Round-trip tests additionally invoke the actual recovery producer against an in-memory transaction port, then pass its captured receipt and resulting intent/marker state to the actual validator. Cases include partial reduction with whole/fractional requests, absent markers and PREPARED-to-VOID markers, unavailable ownership/evidence, transition races, unexpired requests, post-recovery tampering and contradictory provider evidence. The port permits only synthetic position/marker reads and an in-memory marker transition; these tests do not exercise PostgreSQL.

From the repository root, build shared type declarations with `pnpm exec tsc --build`, then run `pnpm --filter @workspace/api-server typecheck`.

From `artifacts/api-server`:

```sh
pnpm exec esbuild src/lib/strata/expiredExitNoSendEvidence.test.ts src/lib/strata/ownerSignedExchangeReleaseProof.test.ts --bundle --platform=node --format=cjs --outdir=dist/exit-diagnostic-tests --out-extension:.js=.cjs --external:pg-native --external:pdfjs-dist '--external:pdfjs-dist/*'
DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/unused node --test dist/exit-diagnostic-tests/expiredExitNoSendEvidence.test.cjs dist/exit-diagnostic-tests/ownerSignedExchangeReleaseProof.test.cjs
```

The inert loopback URL satisfies module initialization; the test ports never connect to a database. The commissioning workflow explicitly runs the new unit suite and `expiredExitNoSendEvidence.postgres.test.ts` alongside the existing held-account PostgreSQL suite. The new database fixture runs the recovery producer and history validator with whole/fractional partial reductions and absent/VOID markers. It applies the checked-in marker migrations in isolated schemas (only schema names are rewritten), checks UUID/bigint/revision decoding and client-identity index eligibility, asserts immutable marker guards, and exercises committed receipt revisions and an uncommitted-to-committed marker insertion across diagnostic reads. Account authorization and provider IO remain synthetic ports in this fixture; the companion held-account suite covers the real account query. Index eligibility is not a production latency claim. Before release, confirm these CI results and run the existing renewal regression suite. Review the new exit predicate against the recovery producer. Do not substitute a production database for the disposable test runner.

## Independent current exposure assessment

A separate observation can safely report current signed order and position counts without treating historical reconciliation as authority. Prefer an owner-only AAL2 response containing scope, batch start/end times, completed pagination indicators, nonterminal-order and nonzero-position counts, and a bounded sample of non-secret identifiers. Compute it only from complete, scope-validated signed reads; unknown/malformed statuses, failed pages and timeouts must return unavailable, never zero. Preserve the final stopped-account/revision and freshness checks. Keep historical reconciliation status separate and retain all trading gates.

That response extension is not implemented here. The present mapper depends on historical request matching, so exposing its counts alone would not constitute an independent view when history mapping fails. A separately reviewed raw provider exposure normalizer is needed, with tests for unknown orders, pagination, malformed rows, scope conflicts and concurrent changes. No fresh production exposure claim or live-start permission follows from these synthetic tests.
