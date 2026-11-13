# One-time development V13 dedicated-pair reconciliation

This manual tool is NOT an automatic migration, startup hook, fee approval,
funding operation, execution approval, or an instruction to run it now.

Entry point: `artifacts/api-server/src/scripts/reconcileV13Commissioning.ts`.
The exact inherited connection must match the existing verified development
database/server/OID pins. Production, unknown targets, deployed processes and
CI overrides are refused by the real adapter. It does not alter environment
variables. The operator must independently authorize a dedicated development
process bound to `exclusive`, subaccount `1`, exchange index `2`, and INDEX2.
Do not overwrite shared credentials or redirect an existing shared worker.

## Explicit modes

From the API package, using already installed dependencies:

```sh
pnpm exec tsx src/scripts/reconcileV13Commissioning.ts \
  --dry-run --expected-run-id=HISTORICAL_RUN_UUID --actor=OPERATOR_ID \
  --ticker=KXBTC15M-MARKET --account-mode=exclusive --subaccount=1 --exchange-index=2
```

The dry-run opens a read-only serializable transaction, reads recorded evidence,
performs authenticated INDEX2 GET scans and verifies the previously approved
official fee artifact. It reports every singleton field change and the two
append-only audit records plus boundary checkpoint initialization. IDs,
fingerprints, digests and checkpoint cursors are redacted. It does not write.

Actual mutation requires replacing `--dry-run` with the explicit flag
`--apply-development-commissioning`. Never include both. Running either real
mode requires separate authorization; neither was invoked during implementation.

## State and audit contract

Only the precisely archived, unused historical primary singleton is eligible:
FROZEN, $1 cap, no attempted entry/exit, no reservation or unresolved accounting,
kill switch ON, both execution flags OFF, and all 17 target fields NULL.
Legacy primary baseline/checkpoint fields must also be NULL: they cannot be
silently cleared or carried into a dedicated binding.

Reuses funded-boundary, archive/fee binding, funding-anchor and history guards.
Requires confirmed restricted-key provisioning/creation, exact reconciled $25
funding, unchanged approved fee evidence and fresh complete authenticated
history. No inventory/orders/fills/settlements/unexplained activity is accepted.
No stale-inventory/late-snapshot waiver is used. Insufficient evidence blocks
the operation rather than manufacturing provenance.

A success preserves the original commissioning snapshot and every old ledger
row, appends the existing run archive linking old run to new run, and appends an
exact FROZEN successor commissioning snapshot. Only dedicated linkage, run ID,
account binding and update time change. Risk limits, approvals, run attempt/
arming evidence, freeze reason and execution gates are unchanged.

The funded boundary receives the successor identity and authenticated checkpoint.
Everything commits atomically under serializable isolation, locked evidence and
ledger tables, final target/identity/freshness checks, and conditional updates.
Any failure rolls back all changes. Audit-bound repeat invocations refresh
read-only proof and report `already-reconciled` without additional writes.
Changed or expired evidence can still block a repeat; idempotency is not a bypass.

## Validation boundary

The focused suite uses an in-memory atomic mock database with no pg/network
imports or credentials. It covers refusal paths, dry-run redaction, audit/history
preservation, idempotency, execution gates and rollback at every mock write stage.
These mocks do NOT establish live readiness or prove real PostgreSQL constraints.
Disposable-database CI validation must precede any request to apply this repair.
