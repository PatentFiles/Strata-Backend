# Reason-specific stopped-account cash recovery

This candidate does not recover connection-timeout, unknown-order, uncommissioned,
or discretionary risk holds. It does not arm, start, submit, cancel, transfer,
change balances, or create authorization. Successful recovery explicitly closes
the execution gates and preserves the STOP fence. An ambiguous commit is not a
retry authorization: reread the account revision and exact durable audit first.

## Release prerequisites and controls

1. Review this exact diff and test the candidate using disposable PostgreSQL,
   with injected provider responses and no production secrets. SQLite/mocks do
   not prove the real lock or deferred-commit behavior.
2. Review the additive SQL separately. Verify the hosted schema, runtime-role
   visibility to its existing account/lease/observation rows, and both exact
   catalog fences. The SQL adds no app grants and is not invoked on API startup.
   It guards cash-recovery audit insertion and the corresponding exact sticky
   cash-clear transition; it must not be used as a general reason eraser.
3. The route is in the existing authenticated AAL2 protective-release router.
   It is default-off and also requires independent release review, the deployed
   SHA to match, and both database fences to be available. Wrong owner/pair,
   unknown body fields, missing confirmation, stale revision, non-flat or
   scheduled/armed states, expired evidence, and absent/uncertain order
   history all fail closed.
4. The scoped recovery compares two complete signed histories and three
   separately quota-admitted scoped balances under one five-second evidence
   deadline. Exact cash must agree, provider timestamps must not regress, and
   both histories must agree. Advancing `updated_ts` alone is not a financial
   change or an atomic revision. Neither timestamp nor cash is replaced. Do not bypass a rate
   or history refusal. Provider evidence is not an atomic cross-endpoint
   snapshot; the separate locked conservation, exact settlement and exposure
   checks remain mandatory. Native fixtures do not certify real Kalshi
   authentication or the real installed production role/policies.
5. In an approved staged rollout keep execution disarmed. Do not invoke this
   balance-related mutation without exact account/revision/settlement owner
   approval and current signed verification. Do not enable or trade as part
   of this recovery. On unexplained or uncertain outcome keep the controls
   closed and reread; do not resubmit automatically. The paper-independent
   entry/exit rollout is separate and is not made ready by cash recovery.

## Repeatable offline verification

Run from the API package with the repository's disposable PostgreSQL runner:

- `node scripts/run-v13-disposable-postgres.mjs --settled-cash-recovery`
- `node scripts/run-v13-disposable-postgres.mjs src/routes/ownerSettledCashRecoveryHandler.test.ts`
- `node scripts/run-v13-disposable-postgres.mjs src/lib/strata/settledCashBracket.test.ts`

## November 24 stopped-account incident

The deployed backend was `35ba107e500829b2172a2f0240a40d0a27007eae`.
The route was disabled: all three recovery variables below were absent, and
Wallets had no matching owner action. Enabling it alone would not have worked:

- It compared all 173 retained intents with three actual exchange orders.
  Forty-three entries had immutable `PROVEN_NOT_POSTED` receipts. Seventy-eight
  prepared exits had matching immutable expiration receipts. Forty-nine locally
  aborted dispatched exits had immutable `strata_protective_exit_local_no_send`
  receipts, which the previous shared reader did not support.
- Signed balance reads returned equal $26.4845 cash with advancing `updated_ts`.
  Requiring equal timestamps rejected otherwise agreeing evidence.
- Dashboard manual cash renewal required `execution_enabled=false` and
  `kill_switch=true`. An authorized account can instead have a released,
  disarmed worker while retaining execution eligibility. The old predicate
  rejected this supported stopped state.

The fix validates local no-send receipts against their original producer hash
format, immutable request/capability, parent, signer, owner/account, marker and
worker fence. It never excludes a row based on BLOCKED status alone. Recovery
uses the existing full two-way retained-event reconciliation, conservation and
deferred audit/transition fences. Subsequent owner qualification reuses the existing restore service for a current
build approval, with the same complete retained-history proof. A new build uses
the existing owner KILL, exact-build fee consent and fresh owner activation
sequence. No fee or activation guard is relaxed. Existing grants and revocations
are preserved.
Cash renewal now locks the owned account and
released/disarmed matching worker and requires equal exact cash, no hold and no
exposure or uncertainty. It preserves execution flags and all financial values.

Server-side read-only diagnostics on November 24 verified the actual restricted
signer and complete current/archived history. No key, signature or raw response
left the server. Candidate code was bundled only in an ephemeral diagnostic
process; the deployed service and customer workers were not replaced.

At **2026-11-24 23:26:21 UTC**, the candidate preview passed for revision 157662:

| Evidence | Verified value |
|---|---:|
| Cash / opening capital / stake | $26.4845 / $27.72 / $5 |
| Retained intents / verified unsubmitted intents | 173 / 170 |
| Exchange orders / fills / settlements | 3 / 3 / 3 |
| Open positions / unresolved intents / reserved cash | 0 / 0 / $0 |
| Latest settlement | 2026-11-18 20:30:05.110 UTC |
| Required signed GETs | 15, all HTTP 200 |
| Accounting hold cleared / trading authorized | false / false |

The earlier instrumented bracket completed in 2.638 seconds. The complete
candidate preview, including credential and database reads before the signed
evidence clock, completed in 6.810 seconds. Both installed database fences were
verified. The signed evidence deadline and normal request budgets remain intact.
This observation is incident evidence, not a reusable approval or future balance
guarantee. Approval always repeats fresh signed verification.

## Matching release and safe cutover

**Do not deploy while a customer is trading.** Production had one owned/armed
worker during this investigation. No deployment or recovery-variable write was
performed. Keep the current Railway source pin until a safe cutover is verified.

1. Require green exact-head backend checks and the matching frontend native
   browser matrix on PostgreSQL 16 and 17. The frontend workflow pins the backend
   commit it tests. Preserve the current monetary policies, credentials, stake,
   strategy and owner authorizations.
2. Coordinate a maintenance window with customer owners and prevent new
   ARM/START requests during the cutover. Do not stop another customer's worker
   or revoke authority as an unrequested deployment shortcut. Run
   `safe-cutover.sql` read-only immediately before deployment; every activity,
   uncertainty and exposure count must be zero. A historical zero snapshot
   alone is insufficient if new starts can still arrive.
3. Verify the two catalog fences using
   `OWNER_SETTLED_CASH_RECOVERY_MIGRATION_READY_SQL`. They already exist in this
   production database; do not reapply migrations or erase accounting holds.
4. Deploy the final qualified backend merge SHA and the matching frontend.
   Preserve existing settings and set these platform-wide values together:

   ```dotenv
   STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA=<final qualified backend SHA>
   STRATA_OWNER_SETTLED_CASH_RECOVERY_ENABLED=true
   STRATA_OWNER_SETTLED_CASH_RECOVERY_DEPLOYMENT_REVIEWED=true
   STRATA_OWNER_SETTLED_CASH_RECOVERY_SHA=<same final qualified backend SHA>
   ```

   Railway's actual deployed Git SHA must match both pins. These are global
   release controls, never customer enrollment. Verify the live build identity,
   healthy service and owner preview before declaring the recovery available.
5. If release verification fails, leave recovery disabled and retain the hold.
   Reverting software does not reverse a committed accounting recovery; inspect
   the exact receipt before any subsequent action.

## Remaining owner actions

After the matching release is safely deployed, the owner signs in with MFA and
opens Wallets. Select **Preview cash hold recovery**, review the unchanged cash,
opening capital, stake and settled-history summary, check the explicit approval
box, then select **Approve cash hold recovery**. A successful receipt confirms
only this hold recovery and the stopped/disarmed state.

If the response is uncertain, use **Check saved cash recovery**. The browser
preserves the exact account/revision/settlement request across reloads; this GET
does not resubmit approval. A receipt lookup serializes with the account fence.

Select **Resume Commissioning** for current release qualification and complete
any separate owner execution review presented for the deployed build. If the
build changes and requires new fee consent, use the existing explicit Dashboard
KILL action first (the recovered account is already stopped). In Wallets advanced
controls choose **Preview exact-build fee authorization**, review the unchanged
terms and check the confirmation, then **Record exact-build fee consent**. Resume
Commissioning and complete **Review execution authorization** / **Authorize &
qualify account**. Publication is not owner consent. KILL and the subsequent
activation must be performed by the owner; support must not perform them. Existing
durable fee terms and risk settings remain unchanged. Dashboard's **Reconcile
Bot Cash (No Transfer)** can renew equal cash while the authorized worker is
stopped. **ARM and START remain separate deliberate owner actions.** Support
must not perform them or approve the accounting recovery for the owner.
