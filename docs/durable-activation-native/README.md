# Durable enrollment, qualification and activation native integration

Local candidate based on deployed 202f5d3594468ec94617761b03b8916ec48621a9 plus durable candidate changes, not deployed code. PostgreSQL16.15: **17 scenarios / 18 Node tests passed**, zero skipped/failed. See postgres16.log. No production requests, publication or deployment.

From candidate root, use trusted native PostgreSQL:
```
PG_BIN=/workspace/scratch/4397717a881a/strata-pg16-tooling/pg/usr/lib/postgresql/16/bin PG_SHARE=/workspace/scratch/4397717a881a/strata-pg16-tooling/pg/usr/share/postgresql/16 bash docs/durable-activation-native/run-native-tests.sh
```
Creates only fresh disposable loopback PostgreSQL on55481/database owner_activation_disposable, enforces those identities in test and stops cluster on exit. Do not run simultaneously with another runner using55481.

Actual functions: enrollDurableOwnerFee, strict PDF parser, qualifyProtectiveRelease, recordOwnerSelfStandingReview, activateOwnerSelfAccount, durable verifier and current market/event/series/change validation, financial snapshot/ledger/conservation, commit-trigger and CAS SQL. Each reset enrolls, qualifies and reviews before activation. Prerequisite ledger/capture schema is synthetic; real candidate/repository authority and deadline migrations are applied.

Historical repository PDF is fixture only, NOT current genuine provider evidence. Account GET transport is synthetic with locally generated RSA-PSS signatures, exercising real signer/read functions. Metadata HTTP is mocked. No real Kalshi request, real account or order. Policy already has durable scope in fixture: this test does NOT cover policy migration, auth middleware or frontend. It proves tested transaction behavior, not full release readiness.

Cases: happy activation/replay, simultaneous duplicates, post-account/audit rollback, real deferred5second rollback, lost COMMIT acknowledgment before/after server commit, review/entry-consent/publication/credential/policy races during signed read, V2 refusal, qualification refusal on revoked entry/changed publication/unavailable metadata without new receipts, and revocation waiting through final activation COMMIT before blocking subsequent fee proof. Every successful activation remains released/disarmed; no START.

Tested source SHA256:
- ownerSelfAccountActivation.ts: 5c00e71abcb3a0737eab31d93e51b8490aecbbe8f426a978049bdd66fcb051bf
- inAppProtectiveRelease.ts: e3123870263a58945e82fa13c476cbd71f709555a05d7c07e735e16489eb0ea0
- durableActivation.native.test.ts: 90e708bd6241e61a6ba169e113fd8082cae63e657a31820281e64bd9a9e2ff63

This is focused integration evidence, not complete safety aggregate, role/RLS simulation, production privileges or live START clearance. No runtime defects found in these scenarios.

## Full-chain migration integration

`run-fullchain.sh` additionally executes actual atomic migration/enrollment, actual new activation-request function, qualification, review and activation. PostgreSQL16.15:3 scenarios/4 Node tests passed. See fullchain-postgres16.log. Invocation is the same environment as above, replacing run-native-tests.sh with run-fullchain.sh; uses the same disposable port55481, so run sequentially.

- No prior same-SHA approval: actual migration preserves limits and revokes old policy, stale request is refused, fresh request/qualification/review/activation completes, worker remains disarmed.
- Existing SAME-SHA approval: migration now refuses BEFORE mutation/revocation. This fixes the discovered path where migration would commit but activation could never accept the revoked same-SHA approval. A fresh deployment SHA is required, not a silent reset of revoked approval.
- Prior OLD-SHA approval: migration revokes prior authority while subsequent new-SHA activation succeeds and preserves historical revocation.

This harness starts with fully shaped prior policy columns, computed policy hash, unique account/version and one-approved-policy constraints, real owner-SHA foreign keys, a synthetic funding receipt, synthetic encrypted-key replacement store, actual credential loader and RSA-PSS signed GET fixture. Historical PDF parsing is real; source capture identity and provider responses remain fixtures. No new activation request is hand-seeded after migration. No actual production grants/RLS role simulation, browser/MFA routes, fresh issuer capture, runtime worker START or order transport is tested. Full-chain success is not release clearance.
