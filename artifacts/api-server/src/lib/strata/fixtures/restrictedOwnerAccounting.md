# Isolated restricted owner-accounting experiment

This test prepares qualification of a trusted backend role, not a production
grant recipe or tenant-isolation boundary. It uses real owner recovery and
ledger code, the complete existing application migration fixture, synthetic
rows, an ephemeral signing key and fake GET evidence. It starts no worker,
calls no provider and issues no order, transfer, withdrawal or human approval.

## Execution and qualification status

From `artifacts/api-server`:

```
pnpm run test:restricted-recovery-gaps
```

The package command runs both new contract suites and then runs owner
accounting and standing renewal in separate fresh PostgreSQL clusters through
the unchanged `run-v13-disposable-postgres.mjs`. It is included in
`test:v13-safety-all`. Run only that canonical native runner. There is no
connected-database fallback. Its loopback cluster, stripped environment and
external-socket fence remain unchanged. The tests additionally check the
exact URL and actual session identity, database, address and port before role
or policy setup. The existing full-schema installer checks the same boundary
before its destructive fixture reset.

Local checks on 2026-11-10: all ten new dependency-free contract tests passed,
including TypeScript syntax stripping and executable canonical-target
rejection. Native execution stopped before cluster/setup because PostgreSQL
binaries are absent. Workspace dependencies are also absent. Native SQL,
concurrency, bundling, full typechecking and runtime compatibility are pending
hosted qualification. Parser and source assertions are not substitutes.

## Permission inventory and pool boundary

`restricted_owner_accounting` is a genuine nonowner LOGIN with no memberships,
inheritance, superuser, BYPASSRLS, role/database creation or replication. It
cannot recover bootstrap authority with RESET ROLE or SET ROLE. The original
global pool is closed and its query/connect/end entry points are bound to the
actual restricted pool. Setup and independent adversarial writers use a
separate fixture-only connection. All application calls use the restricted
pool. Global fetch throws; the runner separately prevents external sockets.

Schema USAGE is limited to `public` and `private`. Exact SELECT tables:

- `v13_production_account`, `v13_live_money_policy`, `v13_production_intent`,
  `v13_production_position`, `v13_production_event`,
  `v13_production_observation`, and `financial_accounts` in `public`.
- `provider_connections`, `kalshi_connection_credentials`,
  `kalshi_account_worker_lease` and the six independent activity tables in
  `private`: `kalshi_owner_pilot_transfers`, `kalshi_owner_shard_allocations`,
  `kalshi_owner_topups`, `strata_auto_withdrawal_maintenance`,
  `strata_emergency_exit_reservations`, `strata_manual_profit_withdrawals`.

Lock-only UPDATE capabilities are `id` on the policy, financial account,
provider and credential relations, and `execution_account_id` on all six
activity relations. Permissive UPDATE USING plus restrictive WITH CHECK(false)
allows the existing FOR SHARE locks without permitting row mutations. This
is a disposable policy experiment, not independent caller authentication.

Actual UPDATE columns are explicitly enumerated:

- Account: `cash_micros`, `reserved_micros`, `blocked_reason`, `revision`,
  `reconciled_at`, `evidence_digest`, `kill_switch`, `execution_enabled`.
  An additional restrictive policy requires the resulting account to remain
  killed and execution-disabled, including while the real fence first kills it.
- Existing intent: `state`, `exchange_order_id`, `filled_hundredths`,
  `reserved_micros`, `terminal`.
- Existing position: `quantity_hundredths`, `basis_micros`,
  `realized_pnl_micros`.
- Existing worker lease: `state`, `account_kill`, `arm_requested`,
  `fencing_token`, `released_at`, `heartbeat_at`. A restrictive policy requires
  killed state, account kill and no arm request.

INSERT is allowed only on production events and observations. There is no
account, policy, intent, lease, reservation or human-approval issuance, DELETE,
Vault or Auth access, explicit sequence grant, function-grant sweep, schema
ownership, default-privilege change or runtime DDL. Original trace triggers
and their SECURITY DEFINER functions remain unchanged and exercise their
existing owner/sequence rights. A single rollback probe temporarily grants
account-scoped trace SELECT to observe uncommitted trace rows on the same
runtime transaction; it removes that diagnostic grant/policy afterward and
verifies trace SELECT is again denied.

The source fixture lacks RLS on pilot transfers and shard allocations. The
fixture explicitly enables RLS on those two only, matching separately
observed production catalog flags, without importing production rows. This
is an acknowledged fixture correction, not a production migration. Auth,
profiles and Vault stubs remain unchanged and are not qualified by this suite.

## Fifteen native cases prepared

1. Genuine restricted session, escalation denial and denied issuance/Vault.
2. Missing kill-column permission rolls back the real fence completely.
3. Wrong owner, invalid confirmation or absent durable kill cannot reach the
   synthetic material loader or GET adapter.
4. Real fill plus losing settlement produces exact cash/reserve accounting,
   two events and two trace rows while preserving kill and the risk freeze;
   replay fails unchanged. Direct reenable/rearm attempts are denied.
5. Zero-fill cancellation releases reserve with no financial event or activation.
6. Fencing-token drift during GET collection prevents financial writes.
7. Missing cash UPDATE permission rolls back ledger, events and trace outbox.
8. Final receipt failure rolls back positively observed uncommitted trace
   rows and the entire ledger transaction.
9–13. Each of five valid inactive maintenance rows cannot be reactivated
   while the real restricted accounting transaction holds its row locks.
   Every adversarial writer must reach a PostgreSQL-reported lock wait before
   the recovery transaction resumes, then finish after its commit.
14. A new reservation's FK insert waits on the parent account lock until
   recovery commits. It is synthetic reservation data, never a dispatch request.
15. Lost acknowledgment after an actual COMMIT reports an unknown outcome,
   does not retry or pretend rollback, and leaves the committed receipt visible.

## Remaining gaps

The suite exercises `fenceOwnerUnknownForAccounting` and
`createHeldUnknownAccountingRecovery`, not the external HTTP owner/AAL2 gate,
real signed provider evidence, credential loading/decryption, platform Auth
policies, session/transaction pooler modes, or production role membership.
Synthetic injected signing material intentionally excludes Vault privilege
qualification. It tests five existing-row reactivations plus one reservation
insert race, not every conceivable maintenance insert/update interleaving.

The policies express trusted accounting capabilities. They do not establish
that arbitrary SQL writes came from these functions, validate owner identity
inside PostgreSQL, or prove general cross-tenant isolation. The restrictive
kill/arm checks prevent those specific authority increases, but an allowed
bookkeeping writer remains trusted for its permitted accounting fields.

The companion `restrictedStandingRenewal.md` inventories the distinct
technical lease and fee-renewal surface. Together these are new local test
candidates pending native qualification, not evidence that switching a live
API/worker role is safe. Publication should contain only these test fixtures,
tests, docs, shared test-helper extraction and package test integration.
