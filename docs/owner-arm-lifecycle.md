# Owner ARM preparation and restart

## Product contract

Wallets is one-time setup: save/reuse Kalshi credentials, verify genuine funding,
review the financial scope, and commission. The Dashboard is the only ordinary
restart workflow: **ARM, then a separate explicit START**. STOP, DISARM and the
clearly labeled personal KILL do not require customers to repeat commissioning.

ARM is an explicit owner decision, not background consent. Its review binds the
current backend build, exact account, key fingerprint, saved stake, fee digest,
approved limits and control epoch. It may restore a stopped account's own kill
state only after all existing checks pass. It cannot submit orders, transfer
funds, replace keys, change monetary terms, revoke/revive grants, or erase holds.
Changed fees/policies, unexplained accounting, open/unknown orders and platform
kill switches still prevent execution.

## Server sequence

`GET /api/strata/me/arm/review` returns the authenticated owner's saved scope.
`POST /api/strata/me/arm` accepts exactly requestId, scopeDigest and the versioned
confirmation. The owner/account are never client-selectable.

A durable attempt and account control epoch serialize preparation across API
processes. The coordinator establishes a held/disarmed boundary, obtains signed
full-history cash reconciliation, renews an unchanged exact-build fee approval
when necessary, and composes the existing protective qualification, owner review,
activation and continuous-grant services. A brand-new commissioned account with
no prior intent, event or position can initialize a killed worker record before
reconciliation; that bookkeeping is not cash proof or permission to trade.

Only a successful final readback produces a READY receipt. It expires after
15 minutes; preparation itself has a three-minute deadline. No worker is started.
`GET /arm/current` and `GET /arm/outcome?requestId=...` recover results without
resubmission after a timeout, tab switch or reload.

`POST /api/strata/me/start-prepared` requires a separate confirmation and consumes
that READY receipt once. It rechecks cash and calls the existing START path. The
worker lease claim is atomic with the current epoch and approved-scope checks.
Existing five-second quote, fee, risk, exchange-history, owner and execution gates
remain authoritative. An unknown START response is never automatically retried.

STOP/DISARM/KILL increment the control epoch inside their existing account-first
safety transaction. A delayed ARM review or a later authority transaction from
that canceled attempt cannot restore or start the account. Worker timers do not
inherit the request's async context; established worker/lease fences govern ticks.

## Migration and deployment

Apply `supabase/migrations/20261125205247_owner_arm_preparation.sql` only after
qualification. It adds a control epoch and a private append-only attempt ledger
with constrained transitions, tenant-bound receipts, RLS and explicit backend
runtime permissions. It does not activate any customer, change cash, clear any
kill switch or start a worker. Retain all previous financial and approval records.

Release backend and frontend as a coordinated qualified pair. Do not publish the
new frontend before its endpoints and migration exist. Existing protected main
checks, two STANDARD-customer native acceptance, and platform-wide exact deployed
SHA qualification remain required. Do not mark an arbitrary deploy qualified or
change the platform gate merely to make a customer button work.

Production verification is read-only until the owner confirms ARM/START: verify
actual deployed build identity, schema/permissions, frontend build identity,
owner-scoped responses, stopped worker state and readiness refusal messages. Do
not impersonate an owner or manufacture consent in SQL.

## Tests

The native attempt test uses disposable PostgreSQL and the actual migration to
exercise cross-tenant refusal, duplicate requests, one-use START, expiry, stake
changes, immutable audit records, browser-role denial and concurrent STOP fences.
The frontend repository has a two-customer native browser acceptance running the
actual setup, Dashboard, authenticated routes, backend services and restricted
PostgreSQL role against a signed synthetic exchange. It exercises initial setup,
ARM/START, STOP/DISARM/KILL restarts and new-build fee reauthorization without a
manual KILL detour. No real exchange order or production performance is tested.

## Rollback

Keep real trading stopped during a rollback and use the existing supported owner
STOP/KILL path to cancel in-flight preparation. Redeploy the last qualified code
pair if needed. Retain the additive epoch/attempt tables and all consent/history;
do not drop audit data or directly toggle execution flags. A partially completed
attempt can have stored valid fee/release evidence but is not permission to START.
Reacquire authoritative account state and require a fresh explicit ARM after the
qualified deployment is restored.
