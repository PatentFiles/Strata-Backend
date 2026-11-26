# Owner-confirmed economic obligation discharge

This additive release follows canonical settlement booking. It never credits a
second payout, changes historical UNKNOWN transport, sends an order, changes
stake/loss limits, grants fee consent, or starts a worker. An old exit remains
UNKNOWN even after its settled economic obligation is positively discharged.

## Positive evidence and exact identity

The existing authenticated AAL2 owner router derives scope. Current restricted
key metadata and management inventory must attest the same account pair. A
bounded signed history/cash bracket, finalized binary market, immutable booked
settlement and a complete stable transfer cut must match. Unrelated holds,
pending money, live/scheduled workers, missing evidence, late orders/fills and
scope/revision changes refuse. Global historical transfer ambiguity remains a
blocker; absence is never treated as proof.

A fresh five-second proof and locked scope revalidation precede one atomic
transaction. The canonical event cash delta, P&L and occurrence time must match
the original booking receipt, not just its digest column. The transaction
releases only the modeled reserve and stale lease, advances fencing/control
revisions, and leaves the account stopped, disarmed, killed and execution off.
Cash, positions, fees, funding, policy and historical order state are untouched.

An immutable separate receipt recognizes discharge. This receipt is not an
order result, a no-send assertion, or live-trading authorization. Subsequent
reconciliation rejects contradictory venue orders/fills and changed financial
records. Browser/paper roles cannot read or write receipts. No new privileged
SECURITY DEFINER function is introduced.

## Wallets and acknowledgement loss

Preview is read-only. A separate checkbox and owner action explicitly authorize
reserve/lease release. A scoped durable request journal is written before the
single POST. Lost responses keep PENDING; only exact receipt readback or durable
cancellation resolves it. An absent receipt never authorizes a replay. Account
switches, missing AAL2, review mode, failed storage and unavailable cross-tab
locks cannot dispatch. This is separate from settlement booking and ARM/START.

## Qualification and deployment order

1. Test the exact backend/frontend pair in network-isolated PostgreSQL and real
   Chromium, including two-owner isolation and old/new release restart. Preserve
   both the original settlement suite and dedicated discharge/route regressions.
2. Complete protected backend release checks; never fabricate a hosted pass or
   bypass branch protection when runner billing prevents job startup.
3. Apply supabase/migrations/20261126113609_economic_exit_obligation_discharge.sql
   using the normal migration process. This additive migration changes no
   existing account. Verify RLS, API grants, browser/paper denial, and zero rows.
4. Deploy the qualified backend with action rollout disabled. Verify actual
   serving identity and source digest, not only a configured Railway pin.
5. Only after qualification set STRATA_ECONOMIC_EXIT_FINALITY_ENABLED=true and
   STRATA_ECONOMIC_EXIT_DISCHARGE_SHA to the exact deployed revision. Publish the
   matching Wallets build and verify its asset bytes.
6. The owner previews and authorizes recovery in their own session. Read back
   exact booked settlement, unchanged cash, released reserve/fence and stopped
   controls. Reconcile independently and confirm current fee/policy/protective
   readiness. ARM and START remain deliberate owner actions.

## Rollback

Disable the action SHA first to stop new discharge requests. Keep readback and
cancellation available across release rotation. Never delete receipts, rewrite
UNKNOWN into never-sent, recreate an order or manually reverse account balances.
After a discharge, preserve the recognition/conservation implementation in any
replacement release. Disabling recognition fails closed and can hold the owner;
it is not authority to reconstruct the old reserve or silently restart trading.

## Historical backlog disposition

Backend #358 and #317 were retired in favor of current stopped-account and
owner-scoped diagnostic/recovery paths. Backend #258 predates the verified TLS
pool and separate paper process; any justified pool tuning must be a new narrow
change, not restoration of its old index.ts. Frontend #234 was superseded by the
unified live history/read model; #209/#204/#203/#202/#172/#164 were obsolete
approval or activation companions. All were closed without deleting branches.
Public multi-tenant self-service, five-key commissioning, administrator-managed
fee uploads and the approved trading strategy remain the current contract.
