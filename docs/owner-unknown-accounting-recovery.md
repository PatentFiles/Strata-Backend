# Owner-confirmed UNKNOWN entry accounting

This workflow is accounting-only. It must not submit, replace or cancel an order, liquidate a position, transfer funds, clear an existing freeze, approve a release, arm execution, or restart a worker.

The original signed release diagnostic and stale-lease recovery keep their existing flat/zero-reserve/terminal-history requirements. An HTTP 201 order acknowledgment is not final execution evidence. Do not use this workflow as an arbitrary signed-provider proxy.

## HTTP boundary

The server mounts `/api/strata/me/unknown-accounting` behind the existing Supabase bearer verifier. Signature, issuer, audience, expiration, UUID subject and AAL2 are required. The verified subject is the owner. STANDARD owners may operate only on their own account; an administrator cannot select a different owner in the request.

Only a unique owned Subaccount 1 / Exchange Index 2 account is supported. No request accepts owner/account selectors, credentials, provider URLs, snapshots, cash values, order requests, fencing tokens or revisions. Extra body keys are rejected. Responses are sanitized and `Cache-Control: no-store`.

- `GET /` returns the scope, warning and exact confirmation strings. It makes no database or provider call.
- `POST /fence` accepts exactly `targetIntentId`, `confirmation`, and `protectiveAutomationAcknowledgment`.
- `POST /reconcile` accepts exactly `targetIntentId`, `fenceReceiptId`, and `confirmation`.
- `GET /receipts/:receiptId` reads the owner-bound committed observation and present account/lease/intent state in one database snapshot. It makes no provider call or financial write.

The accounting confirmation is `I_AUTHORIZE_ACCOUNTING_ONLY_RECOVERY_OF_MY_UNKNOWN_ORDER_AND_KEEP_EXECUTION_KILLED`.

The additional safety acknowledgment for the fence is `I_UNDERSTAND_KILL_HALTS_PROTECTIVE_AUTOMATION_AND_DOES_NOT_CANCEL_OR_LIQUIDATE`.

**KILL halts protective automation. It does not cancel orders or liquidate positions.** The operation refuses when the authoritative shared process registry still reports a scheduled worker. It does not construct a new registry or silently stop a running worker. A separate supported owner control is required if a worker is active.

## Two explicit actions

1. With the explicit safety acknowledgment, fence the exact UNKNOWN entry. Account KILL/execution-off, a strictly advanced killed/disarmed lease token and the audit receipt commit together. Financial state and existing freezes do not change.
2. With the committed fence receipt and an explicit accounting confirmation, collect restricted-signer authenticated history and reconcile through the unchanged production ledger. The collector rechecks owner, credentials, policy, fence, history and independent activity after asynchronous reads and under final locks. Only complete terminal/flat history and exact ledger conservation may release the reservation.

There is no automatic retry, worker restart or release grant. Missing history, open exposure, an active protective reservation, pending maintenance, changed context, malformed fills/fees/settlements or expired evidence preserves the hold. No provider call is made until the committed held context passes admission.

## Uncertain outcomes

A lost COMMIT acknowledgment is uncertain, not rollback. Preserve the exact returned `attemptId` (fence) or `receiptId` (accounting), and inspect `/receipts/:receiptId` before considering any new operation.

An absent, inaccessible or invalid receipt reports `accountingCommitted: null`, `outcomeUnknown: true`, and never authorizes replay. A valid committed receipt establishes a historical commit. It reports success only when the current fence/revision and required state still match. If they changed, the response refuses with `recovery_receipt_current_state_changed` while preserving the truthful historical commit flags. A receipt never grants trading or retry permission.

Accounting recovery leaves execution killed and the prior risk freeze unchanged. Any later release, restart, authority change or exchange action needs its own existing supported gates and authorization.

## Offline qualification

- `pnpm --filter @workspace/api-server run test:owner-unknown-recovery` runs registered unit, real-JWT router, service/receipt, source-manifest and unchanged diagnostic guard tests in a credential-stripped child. All network sockets, listeners, DNS, HTTP and fetch are forbidden.
- `pnpm --filter @workspace/api-server run test:owner-unknown-recovery-postgres` uses the unchanged disposable PostgreSQL runner for both financial/concurrency scenarios and the checked-in application migration chain. Each test receives a freshly created random loopback database. There is no connected-database fallback.
- The workflow `.github/workflows/owner-unknown-recovery.yml` and normal `test:v13-safety-all` include these checks.

The full-source schema fixture applies all checked-in Drizzle SQL, sidecar SQL and maintenance hardening unchanged, under a non-superuser backend table-owner role. It checks FKs, trigger behavior, browser-role denial and recovery writes. Five necessary Supabase platform tables plus auth/vault prerequisites are explicitly modeled because their authoritative DDL is absent from this repository. This is **not** proof of the deployed schema, current role membership, effective grants, platform policies, migration history or real incident evidence. Two preexisting private transfer tables lack explicit RLS in the checked-in SQL; modeled browser roles are denied by private-schema/table privileges. No new grants or SQL migrations are introduced by this integration.

Before a release, verify the real deployment's migration chain, service-role ownership/grants and platform prerequisites through an authorized read-only qualification. Review the exact release commit, run release CI, and obtain the required deployment and owner-action approvals. Never infer production readiness or an incident outcome from synthetic fixtures.
