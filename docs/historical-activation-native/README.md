# Independent historical-baseline full-chain native tests

PostgreSQL16.15: **22 scenarios / 23 Node tests passed**, zero failed/skipped/cancelled. Source fingerprint: tested-sha256.txt. Includes latest immutable migration-receipt provenance guard and source-aware readback. No runtime edits made by this tester.

Run from candidate root:
```
PG_BIN=/workspace/scratch/4397717a881a/strata-pg16-tooling/pg/usr/lib/postgresql/16/bin PG_SHARE=/workspace/scratch/4397717a881a/strata-pg16-tooling/pg/usr/share/postgresql/16 bash docs/historical-activation-native/run-fullchain.sh
```
Runner creates a new disposable loopback PostgreSQL cluster on55486/database owner_activation_disposable, asserts exact host/port/db/NODE_ENV, and stops it on exit. Do not run concurrently on the same port.

## Actual tested behavior

Actual historical migration/enrollment with the release-controlled repository PDF, credential loader and signed provider reader, then real activation-request, qualification, owner review and final activation. Historical mode has ZERO canonical capture rows. Tests assert historical policy/source identity, NULL capture ID, genuine_source_verified=false, sourceAuthenticityVerified=false and publicationKnownCurrent=false; no authenticity or current-source claim is fabricated.

Exact owner consent/risk text, baseline identity, source-kind confusion, fresh-capture consent substitution, extra capture ID and feature-off refuse. Same-SHA approval refuses before mutation; old-SHA authority remains revoked while new-SHA activation succeeds. Known conflicting capture prevents migration; a new capture after qualification latches and blocks activation. Simultaneous migrations and activation calls each produce exactly one result. Three injected post-write faults roll back policy/model/receipt changes (receipt fault matches receipt table, NOT attempt journal). Lost COMMIT ACK returns unknown/no retry and exact historical readback. Relabeling historical authenticity is rejected. Revoked entry, publication change and unavailable current-market applicability fail closed. Successful activation remains released/disarmed; no START/orders.

## Fixture and verification limits

- Actual core SQL and repository authority/deadline/candidate migrations run, but prerequisite account, intent, lease, event, position, vault, capture and funding tables are reduced fixtures, NOT a full production migration restore.
- Prior policy includes full approved-policy fields, computed canonical hash, unique(account,version), one-approved-policy-per-account index. Owner SHA/qualification constraints come from real SQL. Not every production index, CHECK, trigger or permission is represented.
- DB is disposable superuser. No simulation of production service-role RLS, privileges, connection pooling/load, deployment or rollback.
- Historical repository PDF is the real pinned local artifact, NOT genuine current issuer evidence or independent authenticity proof.
- Locally generated RSA-PSS credentials exercise actual signing and credential loading, but provider response transport is synthetic. Funding receipt and account balances are seeded synthetic prerequisites. Current market/event/series/change endpoints use synthetic responses and exact preselected ticker rather than live startup discovery.
- Global fetch is replaced with a failing counter; final assertion proves zero accidental live HTTP calls. No real exchange requests, API keys, orders, captures, cooldown changes, remote writes or production controls.
- Concurrent requests use Promise.all, not a forced dual-transaction barrier. Test proves observed duplicate safety, not exhaustive schedules. Earlier durable activation suite separately tests explicit lock-through-COMMIT barrier.
- No real browser/MFA/auth-route, worker ARM/START, partial fills, live recovery or actual financial transaction.

No product defect found in these scenarios. Passing tests do not establish authenticity/current base-rate correctness, approve risk acceptance, or clear live START.
