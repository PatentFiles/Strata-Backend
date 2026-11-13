# C52/C53 entry-policy revision — development source only

Worker entry-policy identity: `v13-first-qualifying-cross-v2`.
Legacy policy: `v13-first-observed-cross-v1`; NULL remains unversioned historical
provenance and uses legacy eligibility, not an implicit upgrade.

Champion identity is unchanged:
`v13-champion-2-c52-confirm53`,
`314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`.
The parameter hash does NOT attest worker entry-policy or deployed build identity.

## Semantics and prospective boundary

Only newly INSERTED market-window rows receive v2. An existing row, even one
without an entry, is never upgraded by this code. There is no backfill, marker
reset, startup migration, or automatic deployment. Nullable policy columns in
window, evaluation, position, shadow and approval schemas have NO defaults.

First observed direction/time/key remains historical. Entry availability is
separate: actual fresh crossing, shared champion classification, supported
velocity, valid fresh feeds/offers and active window, no open position and no
consumed market claim. Drifting into range without crossing is not eligible.
Touching zero is not a crossing; departing from previous zero is, exactly as
specified by the unchanged shared classifier. No stricter sign-reversal rule
or invented crossing is introduced.

The existing `${ticker}:first` market-wide key is retained, not replaced by
per-event keys. Position creation, evaluation eligibility and consumption commit
atomically under the window/engine lease transaction; rollback publishes none.
Consumption persists after close and restart. Paper's trigger-specific unique
index is not enough on its own: the locked durable consumption check is required.

Research shadows use qualified champion entry observations and prior durable
consumption under v2; they remain a conservative champion-entry subset, not
independent simulated position histories or execution authority. Historical
firstCross fields are not renamed to mean first qualifying crossing.

## Frozen execution boundary

No connected-database migration/test write, flag change, commissioning,
key/funding operation or exchange operation was performed for this implementation.
That is not an attestation that an existing running process made no state changes.
Source schema changes require a separately reviewed
additive schema rollout before this code can run; do not restart a worker against
the old schema. No publish/start/migration command is authorized by this note.
The review-only additive SQL is docs/sql/c52-entry-policy-review-only.sql.
It explicitly replaces the shadow CHECK: do not assume a same-named Drizzle
constraint automatically changes during a later schema push.
Background paper startup additionally requires the explicit revision-valued
`V13_ENTRY_POLICY_RUNTIME_APPROVED` opt-in, as well as the old worker flag.
It is not set by this change. Manual isolated test cycles do not start a timer.

Production requires explicit `entryPolicyVersion` approval matching a v2 source.
The approval hash includes this field only when non-NULL, preserving old hashes.
Existing approvals cannot silently authorize v2. Existing micro-live approvals
do not bind this revision: their new entries from v2 are blocked; owned-position
exit/recovery paths remain unchanged.
V2 production entries additionally prove the persisted consumed market-wide
claim and active window at preparation and at the final POST fence.

For Brit: port the complete worker/record/research/executor/approval alignment,
not just the actionable expression. Run offline fixtures with transport blocked,
then independently attest the exact worker and API image/build and this policy
version. A reported matching champion hash or API-only health endpoint is not
independent worker runtime proof. Review authority separately; no research preset
may gain live authority. No deployment/live acceptance is established here.

## Offline validation

Use run-v13-disposable-postgres.mjs with credential-stripped environment and
network fencing. New targeted source:
forwardTestEntryPolicy.integration.test.ts and v13EntryPolicy.test.ts.
Also run existing worker integration, research, production acceptance, planner,
risk, preflight and browser/shared parity suites.

Required invariants include ineligible-first then later SCOUT/CONFIRM; no drift,
zero touch/departure parity; malformed/stale/expired/overpriced/unsupported
momentum; concurrency, close/re-entry, restart and transaction rollback; unknown
identity/policy/hash rejection; uncertain dispatch non-replay; fee/risk/kill-switch
fences and no automatic trading authority.

## Completed offline verification

- Whole-workspace typecheck: passed.
- Credential-free isolated `test:v13-safety-all`: 333 passed; zero failures,
  cancellations or skips, including 12 new DB entry-policy regressions,
  19 research tests and 28 production acceptance tests.
- Final production acceptance expanded to 29 passing tests: separately approved
  v2 SCOUT/YES and CONFIRM/NO each complete simulated entry and owned exit, then
  reject re-entry after close/restart. The full typecheck passed again afterward.
- Existing isolated paper-worker integration: 10 passed; zero skips.
- Browser/shared classifier parity: all 23 baseline cases passed.
- Additive-SQL rehearsal preserved historical NULLs, identities, markers and
  approval hashes; NULL/unknown shadow policy cannot bypass the revised CHECK.
- All four safety-pipeline PostgreSQL clusters stopped; no test PostgreSQL
  process remained. No connected-database fallback exists in the runner.

## Observed runtime blocker — not resolved by source-only authorization

Read-only development log review found a running paper process querying
`entry_policy_version` against an unmigrated schema and reporting missing-column
errors. This is not a healthy or attested runtime. The latest source startup
review gate does not change an already-running process, and has only been
verified offline. No migration, service refresh or connected-state repair was
performed to conceal or resolve this issue. Separate authorization and a
coordinated schema/application rollout are required.

Independent API/worker build attestation remains necessary: this workspace's
source tests and unchanged parameter hash cannot establish the independent
execution deployment's release or entry-policy identity.

## Subsequent authorized development hardening — October 10, 2026

The sections above record the original source-only implementation, not today's
separately authorized development repair. The development target was independently
identified as heliumdb; the production replica was separately identified as neondb.
The development API was stopped before snapshot/migration. A fresh private custom
backup was restored into an isolated PostgreSQL instance, and the reviewed SQL was
rehearsed there with fingerprints preserved for all 33 public tables.

Only development received the five nullable/no-default columns and the explicitly
replaced, validated shadow CHECK, in one guarded transaction. Existing rows,
first-cross markers, consumption, parameter identities, approval hashes, monetary
limits and frozen configuration were preserved; all historical policy values
remain NULL. No production DDL, deployment, flag change or exchange operation was
performed by this repair. Existing published processes are outside that claim.

A development-only staging boundary now precedes authentication/provisioning/
application routes and all background startup. Without the exact reviewed v2
runtime marker, only GET /api/healthz responds successfully with explicit staged,
paper-disabled/live-disabled status; other routes return 503 before downstream
handlers. Fee monitoring, shadow polling, paper timers, live reconciliation and
exchange startup reads do not start. Production behavior retains its existing
authority controls. This is not paper readiness or live clearance.

Fresh credential-stripped/network-fenced safety validation: 337 tests passed,
zero failures/cancellations/skips, including 3 staging tests, 12 entry-policy DB
regressions, 19 research tests and 29 production acceptance tests. Whole-workspace
typecheck passed. The disposable runner prefers installed PATH binaries before
enumerating Nix; it still has no connected-database fallback.

The source-only handoff contains the exact original 21-path patch and a separately
identified development-hardening patch (startup/middleware/tests/tooling/doc).
It contains no Git history, private backup, runtime data, credentials or memory.
Review and test the independent API AND worker builds plus separately staged schema
before considering explicit v2 opt-in for newly inserted market windows. Never
backfill historical rows or reset consumed claims. Keep live execution off.
