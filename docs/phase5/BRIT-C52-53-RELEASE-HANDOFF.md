# Brit handoff: C52/53 integration

## Status and authority

This is an integrated development release, not a live-trading authorization.
Production has not been republished by the agent. Do not describe a successful
source build, a simulation, or a restored database test as production readiness.

The release combines the latest PR1 (`d1661ad74e0de60fd1f914d934074db3eaf4dbc6`)
and the intended PR2 repair (`20b3742c259f869b0980565b95d567b360b1153f`).
It retains PR1's newer readiness checks and failure exit status rather than
replacing that handoff with the older PR2 branch. Integration commits are
`82ec553` and `86f590a`; subsequent release hardening is on
`release/c52-53-brit`. Existing operator layout and server history are retained.

Nothing in this release authorizes credential replacement, selector redirection,
funding, fee/risk approval, arming, exchange orders, exchange cancellations, or
safeguard bypass. Existing identity and destination checks remain mandatory.

## Champion contract

| Property | Value |
|---|---|
| Champion | `v13-champion-2-c52-confirm53` |
| Parameter SHA-256 | `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161` |
| SCOUT separation | $8–$15 inclusive |
| SCOUT maximum executable offer | $0.52 |
| CONFIRM separation | $20 or greater |
| CONFIRM maximum executable offer | $0.53 |
| Wrong-side recross separation | $8 |
| Momentum-invalidated exit | Enabled |

Browser and server classification use the same shared evaluator. Freshness,
window coherence, persistent first-cross consumption and settlement attribution
remain responsibilities of their respective callers. Do not equate independently
timed browser and worker signals: compare coherent identical inputs when testing
classifier agreement. An ask/offer is an entry input; a bid is an exit input.

The server paper engine is separate from per-user browser paper history.
Browser positions are tab-local; account history sync is per-user; the persistent
server engine has its own positions and metrics. Neither is the live ledger.
The new production executor has its own ledger, remains inert without its
independent gates, and is not automatically started by this integration.

Research presets and shadow evaluations are research only. They cannot change
the champion, financial limits, or execution eligibility. Research results are
not currently exposed by the dashboard API; the UI says so rather than inventing
results or substituting paper results for production results.

## History-preserving schema upgrade

New parameter identity fields on existing forward-test tables are nullable,
without a current-champion default. Existing records stay unknown; only newly
generated observations and positions supply the current ID/hash explicitly.
Unknown records cannot authorize production entry. Partial or mismatched
parameter pairs are rejected by new named checks.

The development diff was reviewed as additive: new research/production tables,
new nullable observation fields and new checks. The existing funding uniqueness
constraint is modeled as the existing constraint, avoiding a drop/recreate.
No existing trade history was rewritten or retrospectively labeled C52/53.

Do not enable **overwrite production data**. Do not add schema pushes to builds,
startup hooks or production application code. Production schema application must
use the supported publish flow and be verified separately from build health.

## Recovery evidence

Code recovery point: `recovery/pre-c52-53-brit-20261008` at
`6fa0364ebecbcf87ae8d5d15a786e44ea9a5b92e`.

A development `pg_dump` was made only after its database destination was
independently matched to the established development fingerprint. It was restored
into a new local PostgreSQL cluster with stripped exchange credentials and no
application worker. Restoration preserved history and the frozen safety state.

The corrected schema was also applied to that restored copy. On
2026-10-08 at 01:36:34 UTC, all 25 original tables retained identical normalized
row digests, and historical parameter identities remained NULL. The original
dump and detailed restore proof are retained privately under
`.local/private-backups/c52-53-pre-upgrade/`, ignored by Git. Do not upload those
files to GitHub or expose their records in a handoff or Library card.

The development schema was subsequently applied with a fresh destination check
and before/after checks of the existing safety flags and account selection.
Production schema and production data were not changed.

**Production recovery is not independently proven.** Documentation describing
backup/PITR capability is not evidence of an available restore point. Before
publishing, the owner must verify a usable production restore point and its
timestamp/retention in database settings, and retain reviewable evidence.

Restoring a backup can discard paper activity recorded since its snapshot.
Prefer reverting application code while retaining additive schema when possible.
Before any full data restore, preserve newer data, confirm the intended target,
stop conflicting worker writes and obtain explicit owner approval. Never apply
a development dump over production.

## Commissioning remains blocked

The repair is a manual development-only tool, not a startup migration. Its
production/destination, frozen-state, exact key, funding/history, fee freshness,
account-mode and final-write fences must all pass. `--dry-run` is read only;
`--apply-development-commissioning` is a separate consequential action.

The installed shared configuration is `primary_nonexclusive` / subaccount `0`.
The dedicated-pair adapter requires `exclusive` / subaccount `1` / exchange `2`.
Do not change or redirect the shared selector to make that check pass.
The INDEX2 key remains separately bound; historical funding or approval records
are not new financial approval. Retaining historical approval metadata in a
frozen successor does not arm it.

Mocked authenticated evidence in disposable tests proves adapter mechanics and
rollback, not current broker readiness. The real readiness verifier is allowed
to report BLOCKED and must exit nonzero when required evidence is missing.
No repair apply, new financial approval, or exchange write was performed.

## Verification and release identity

Completed checks include workspace typechecking, the corrected executor
acceptance suite (24 isolated PostgreSQL tests), six actual Drizzle/serializable
repair tests, the restore/upgrade proof above, and integrated regression checks.
The executor cases include partial fills, unknown submissions, restart recovery,
position-owned exits, financial conservation, final evidence fences, unknown
historical provenance and rejection of partial parameter identities.

Full combined safety command:

    node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs --full-suite

It creates a new credential-stripped PostgreSQL cluster. It never falls back to
the connected development or production database. Existing CI calls the package
safety entrypoint, which now includes repair core, real adapter and SQL tests.

Public `/api/healthz` includes non-secret revision/tree/dirty-state and champion
identity captured for the process/build. The dashboard polls it and compares
frontend/backend revision, tree, champion and 52/53 ceilings. Missing, stale,
dirty or mismatched identity is explicitly unverified. This endpoint grants
no authority and does not prove worker liveness or authorization.

For a release chain, record:

1. Reviewed GitHub release commit and successful CI run.
2. Revision/tree returned by the published backend's `/api/healthz`.
3. Published frontend revision and the agreement badge.
4. Independently verified production database migration, safety flags and
   unchanged account/key ownership.
5. Fresh worker lease/heartbeat and subsequent champion-tagged observations.
6. Actual owner and ordinary-user checks, and per-user persistence/isolation.

The existing published site is
https://btc-paper-testing-dashboard.replit.app.
Before publishing this release its backend revision is not independently
attested; an old frontend asset is not proof of current backend source.

## Operator acceptance checklist

- Sign in through actual Clerk authentication; do not inject an admin identity.
- Verify the owner sees authorized status and an ordinary user cannot perform
  owner-only operations. Anonymous protected requests must fail.
- Confirm account history survives reload and another user's account cannot
  read it. Keep diagnostics separate from trading results.
- Confirm server status reports a current source heartbeat, a live lease and
  advancing evaluations; a browser fetch timestamp is not a heartbeat.
- Confirm new worker records carry the exact champion ID/hash; old records keep
  unknown identity. Worker restarts must not fabricate historical attribution.
- Confirm kill switches remain on, live execution flags remain false and the
  bounded run remains FROZEN. Production accounting clearance is separate.
- Treat failed refreshes and stale cached flags as unverified, never as “off.”
- Keep all challenger panels labeled research-only.

## Publish decision

Publishing is owner-triggered, not performed by this agent. Do not publish until
production recovery evidence and the actual authorized-session checks are
available and the final combined CI/build evidence is reviewed. After publishing,
verify the complete revision chain and current production worker separately.
If a check is unavailable, record it as unverified rather than granting clearance.
