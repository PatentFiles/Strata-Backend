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
4. The scoped recovery is a one-attempt read of complete signed history with
   separately quota-admitted scoped balance reads before and after it. A
   difference in exact cash or the provider's balance update stamp discards the
   whole read; neither the timestamp nor cash is replaced. Do not bypass a rate
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
