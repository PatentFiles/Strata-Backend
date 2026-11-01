# Owner renewal event-schema hotfix

## Defect and evidence

Base release: `498dcd192503a529d48910806fa58bd28e15e053`, tree
`78092e5eed5b99e99b99756fedd6434c10ac6394`.

The shared never-posted history reader projected `id` from
`public.v13_production_event`. Its committed migration and Drizzle schema instead
name the event key `event_id`. The production catalog checked on 2026-11-01 also
has `event_id` and no `id`. The original renewal fixture incorrectly created an
`id` column; this fixture drift hid the error.

A disposable PostgreSQL replay using the actual event CREATE TABLE block from
`lib/db/drizzle/0000_reviewed_release_schema.sql` reproduces SQLSTATE `42703` even
when the table is empty. Before the correction, legitimate renewal and signed
flatness diagnostic cases fail against that DDL. Production's original catch did
not log SQLSTATE: `42703` is locally reproduced, not claimed as a captured
production exception. A bounded production read after the failed owner attempt
found no new exact-SHA approval; this patch performs no production recovery write.

## Narrow correction

Project `1 AS present` for the existing event-existence query. The same account,
intent identifiers, LIMIT, shared lock and nonempty-result refusal remain. Both
owner renewal and the signed diagnostic use this shared reader. No event is
excluded, reclassified or deleted.

The fixture now loads the actual committed event DDL rather than a hand-written
imitation. A regression compares its PostgreSQL catalog columns with the Drizzle
schema, confirms `event_id` exists and `id` does not, and reproduces the old invalid
projection. The negative financial-event case inserts the real required fields.
An independent audit of the remaining renewal/diagnostic query columns against
the production catalog and committed schemas found no second missing column.

Unexpected renewal failures additionally emit only a fixed phase, allowlisted
SQLSTATE and bounded category. No Error object, message, SQL, values, account
identity, credential or provider body is logged by this diagnostic. Unknown
codes become null; unusual error getters cannot replace the refusal. Public
failure reasons remain unchanged, and a lost COMMIT acknowledgment remains
uncertain rather than being reported as a proven rollback.

## Preserved behavior and rollout

No migration, environment, permission or frontend changes are needed. No control,
attestation, grant or historical row is repaired automatically. The existing
owner/current-SHA consent, prior authority, signed flatness, history, lock and
concurrency fences remain mandatory. Bootstrap and restore behavior is unchanged.
The signed release proof remains fifteen seconds with the existing qualification
expiry contract; the trading five-second quote policy is untouched.

Deploy only after independent review and combined CI. Keep the worker stopped
through release verification. The legitimate owner must complete the normal
new-SHA consent flow; this hotfix does not authorize anyone to fabricate that
consent. Before retrying an uncertain previous transaction, inspect existing
exact-SHA approval state. Rolling back requires no schema rollback, but restores
the known renewal/diagnostic defect for accounts with never-posted history.

## Local validation

All external network access was fenced off; all database changes occurred in
fresh disposable PostgreSQL clusters. Final focused results:

- Renewal/diagnostic, schema regression, concurrency and redacted telemetry: 60/60.
- Legacy owner release: 12/12.
- Signed diagnostic unit cases: 9/9; actual PostgreSQL concurrent-revision case: 1/1.
- Existing owner restore actual PostgreSQL: 12/12.
- API TypeScript check and backend build passed.

Reproduction log: `strata-renewal-event-before.log` (intentional failing baseline).
Corrected log: `strata-renewal-event-after.log`. These are local release evidence,
not repository fixtures or claims of a successful production consent attempt.

Commands (with the installed PostgreSQL 17 and pnpm tools on PATH):

```sh
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs --renewal
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerShaRelease.test.ts
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerSignedExchangeReleaseProof.test.ts
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerSignedExchangeReleaseProof.postgres.test.ts
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs --restore
./node_modules/.bin/tsc -p artifacts/api-server/tsconfig.json --noEmit
pnpm --filter @workspace/api-server run build
```

Full combined validation and deployment remain separate release steps.
